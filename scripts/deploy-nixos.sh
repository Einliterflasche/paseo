#!/usr/bin/env bash
# Build first, then stop paseo.service, switch to the new closure, and start it again.
# The whole operation runs in a finite systemd unit outside paseo.service.
# Usage: deploy-nixos.sh [--flake <ref>] [--reason <text>]
# PASEO_HOME selects the daemon. The built closure owns the CLI that checks the result.
# PASEO_DEPLOY_ENV_FILE supplies daemon credentials inside the detached unit.
# PASEO_DEPLOY_STOP_TIMEOUT (default 300) limits the stop, in seconds.
# PASEO_DEPLOY_READY_TIMEOUT (default 300) limits the wait for the new daemon, in seconds.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "$0")"
# Only the setuid wrapper works on NixOS; the sudo in PATH is not setuid.
# PASEO_DEPLOY_SUDO and PASEO_DEPLOY_SUDO_WRAPPER are internal test overrides.
SUDO="${PASEO_DEPLOY_SUDO:-${PASEO_DEPLOY_SUDO_WRAPPER:-/run/wrappers/bin/sudo}}"
if [[ ! -x "$SUDO" ]]; then
  echo "Setuid sudo wrapper not found: $SUDO" >&2
  exit 1
fi

if [[ "${1:-}" != --worker ]]; then
  UNIT_NAME="paseo-deploy-$(date +%s)-$$"
  echo "Deployment job: $UNIT_NAME (logs: journalctl -fu $UNIT_NAME)"
  ENV_ARGS=(--setenv="PATH=$PATH" --setenv="HOME=$HOME")
  for name in PASEO_HOME PASEO_DEPLOY_FLAKE PASEO_DEPLOY_STOP_TIMEOUT PASEO_DEPLOY_READY_TIMEOUT NIX_PATH; do
    if [[ -v "$name" ]]; then ENV_ARGS+=(--setenv="$name=${!name}"); fi
  done
  if [[ -n "${PASEO_DEPLOY_ENV_FILE:-}" ]]; then
    ENV_ARGS+=(--property="EnvironmentFile=$(readlink -e "$PASEO_DEPLOY_ENV_FILE")")
  elif [[ -n "${PASEO_PASSWORD:-}" ]]; then
    echo "Use PASEO_DEPLOY_ENV_FILE to supply credentials to the detached job." >&2
    exit 1
  fi
  # The job stops paseo.service, so it must not run inside it or wait on it from there.
  "$SUDO" systemd-run --unit="$UNIT_NAME" --uid="$(id -u)" --collect \
    --working-directory="$PWD" "${ENV_ARGS[@]}" -- "$SCRIPT_PATH" --worker "$@"
  echo "Deployment submitted; follow completion with: journalctl -fu $UNIT_NAME"
  exit 0
fi
shift

FLAKE_REF="${PASEO_DEPLOY_FLAKE:-}"
REASON="NixOS deployment"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --flake) FLAKE_REF="${2:?--flake needs a reference}"; shift 2 ;;
    --reason) REASON="${2:?--reason needs text}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

STOP_TIMEOUT="${PASEO_DEPLOY_STOP_TIMEOUT:-300}"
READY_TIMEOUT="${PASEO_DEPLOY_READY_TIMEOUT:-300}"
if [[ ! "$STOP_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "PASEO_DEPLOY_STOP_TIMEOUT must be a positive number of seconds." >&2
  exit 1
fi
if [[ ! "$READY_TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "PASEO_DEPLOY_READY_TIMEOUT must be a number of seconds." >&2
  exit 1
fi
echo "Deployment reason: $REASON"

# Keep the result link and build log for inspection and rollback. Each deployment
# gets its own directory, so concurrent builds cannot replace each other's result.
WORK_DIR="$(mktemp -d /tmp/paseo-deploy.XXXXXXXX)"
BUILD_ARGS=(build)
if [[ -n "$FLAKE_REF" ]]; then BUILD_ARGS+=(--flake "$FLAKE_REF"); fi
# Without --flake, use the host's /etc/nixos configuration, not the dev-shell flake.
cd "$WORK_DIR"
build_status=0
nixos-rebuild "${BUILD_ARGS[@]}" > >(tee build.log) 2> >(tee build-errors.log >&2) ||
  build_status=$?
if [[ "$build_status" != 0 ]]; then
  echo "Build result: failed with status $build_status; nothing was stopped. Logs: $WORK_DIR" >&2
  exit "$build_status"
fi
CLOSURE_DIR="$(readlink -f result)"
SWITCH_BIN="$CLOSURE_DIR/bin/switch-to-configuration"
TARGET_CLI="$CLOSURE_DIR/sw/bin/paseo"
if [[ ! -x "$SWITCH_BIN" ]]; then
  echo "Build result: closure has no executable switch-to-configuration: $CLOSURE_DIR" >&2
  exit 1
fi
if [[ ! -x "$TARGET_CLI" ]]; then
  echo "Build result: closure has no Paseo executable: $TARGET_CLI" >&2
  exit 1
fi
echo "Build result: built $CLOSURE_DIR; retained build files: $WORK_DIR"

ACTIVATION_SCRIPT="$WORK_DIR/activate.sh"
cat > "$ACTIVATION_SCRIPT" <<'ACTIVATE'
#!/usr/bin/env bash
# Runs as root. Each step has a time limit, and the service is started again in every
# case, so a deployment never leaves Paseo stopped or waits for an operator.
set -uo pipefail
closure="$1"
stop_limit="$2"
status=0

echo "Stopping paseo.service (limit ${stop_limit}s); the daemon saves its checkpoint now."
if timeout "$stop_limit" systemctl stop paseo.service; then
  echo "Stop result: clean stop."
else
  echo "Stop result: the stop failed or exceeded ${stop_limit}s; killing paseo.service with SIGKILL."
  systemctl kill --signal=SIGKILL paseo.service || true
  timeout 60 systemctl stop paseo.service || true
  echo "Stop result: forced kill. Agents without a saved checkpoint do not resume automatically."
fi
systemctl reset-failed paseo.service || true

# Paseo is stopped from here on, so a wait for the profile lock must not hold it down.
if timeout 300 nix-env --profile /nix/var/nix/profiles/system --set "$closure"; then
  echo "Profile result: system profile set to $closure."
  # The limit only guards against a hung activation; a normal switch ends in minutes.
  if timeout 1800 "$closure/bin/switch-to-configuration" switch; then
    echo "Switch result: switched to $closure."
  else
    status=$?
    echo "Switch result: failed with status $status."
  fi
else
  status=$?
  echo "Profile result: failed or exceeded 300s with status $status; the switch was skipped."
fi
system_status="$status"

# The switch can start the service itself. A start of an active unit does nothing.
if timeout 120 systemctl start paseo.service; then
  echo "Start result: paseo.service started."
else
  start_status=$?
  echo "Start result: failed with status $start_status."
  if [[ "$status" == 0 ]]; then status="$start_status"; fi
fi

# A failed switch can leave other units stopped, such as the public front.
if [[ "$system_status" != 0 ]]; then
  if timeout 120 systemctl start multi-user.target; then
    echo "System units result: multi-user.target started."
  else
    echo "System units result: start of multi-user.target failed with status $?; ignored."
  fi
fi
exit "$status"
ACTIVATE
chmod 700 "$ACTIVATION_SCRIPT"

activation_status=0
"$SUDO" "$ACTIVATION_SCRIPT" "$CLOSURE_DIR" "$STOP_TIMEOUT" || activation_status=$?
echo "Activation result: exited with status $activation_status."

STATUS_ARGS=(daemon status --json)
if [[ -n "${PASEO_HOME:-}" ]]; then STATUS_ARGS+=(--home "$PASEO_HOME"); fi
deadline=$((SECONDS + READY_TIMEOUT))
while true; do
  # status exits 0 for a stopped daemon too; only a reachable daemon counts as an answer.
  if daemon_status="$(timeout 30 "$TARGET_CLI" "${STATUS_ARGS[@]}" 2>/dev/null)" &&
    grep -Eq '"connectedDaemon": *"reachable"' <<< "$daemon_status"; then
    echo "Daemon status:"
    echo "$daemon_status"
    exit "$activation_status"
  fi
  if (( SECONDS >= deadline )); then
    echo "Daemon status: the daemon did not answer within ${READY_TIMEOUT}s." >&2
    exit 1
  fi
  sleep 2
done
