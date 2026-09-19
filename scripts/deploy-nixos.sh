#!/usr/bin/env bash
# Build first, checkpoint the running daemon, then activate the immutable closure.
# The whole operation runs in a finite systemd unit outside paseo.service.
# Usage: deploy-nixos.sh [--flake <ref>] [--reason <text>] [-- <deploy options>]
# PASEO_HOME selects the daemon; PASEO_CLI may override the built checkout CLI.
# PASEO_DEPLOY_ENV_FILE supplies daemon credentials inside the detached unit.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "$0")"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_PATH")")"

if [[ "${1:-}" != --worker ]]; then
  CLI_PATH="$(command -v "${PASEO_CLI:-$ROOT_DIR/packages/cli/bin/paseo}")"
  UNIT_NAME="paseo-deploy-$(date +%s)-$$"
  echo "Deployment job: $UNIT_NAME (logs: journalctl -fu $UNIT_NAME)"
  ENV_ARGS=(--setenv="PATH=$PATH" --setenv="HOME=$HOME" --setenv="PASEO_CLI=$CLI_PATH")
  for name in PASEO_HOME PASEO_DEPLOY_FLAKE NIX_PATH; do
    if [[ -v "$name" ]]; then ENV_ARGS+=(--setenv="$name=${!name}"); fi
  done
  if [[ -n "${PASEO_DEPLOY_ENV_FILE:-}" ]]; then
    ENV_ARGS+=(--property="EnvironmentFile=$(readlink -e "$PASEO_DEPLOY_ENV_FILE")")
  elif [[ -n "${PASEO_PASSWORD:-}" ]]; then
    echo "Use PASEO_DEPLOY_ENV_FILE to supply credentials to the detached job." >&2
    exit 1
  fi
  exec sudo systemd-run --unit="$UNIT_NAME" --uid="$(id -u)" --collect --wait \
    --working-directory="$PWD" "${ENV_ARGS[@]}" -- "$SCRIPT_PATH" --worker "$@"
fi
shift

FLAKE_REF="${PASEO_DEPLOY_FLAKE:-}"
REASON="NixOS deployment"
EXTRA_DEPLOY_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --flake) FLAKE_REF="${2:?--flake needs a reference}"; shift 2 ;;
    --reason) REASON="${2:?--reason needs text}"; shift 2 ;;
    --) shift; EXTRA_DEPLOY_ARGS=("$@"); break ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Keep the result link and build log for inspection and rollback. Each deployment
# gets its own directory, so concurrent builds cannot replace each other's result.
WORK_DIR="$(mktemp -d /tmp/paseo-deploy.XXXXXXXX)"
BUILD_ARGS=(build)
if [[ -n "$FLAKE_REF" ]]; then BUILD_ARGS+=(--flake "$FLAKE_REF"); fi
# Without --flake, use the host's /etc/nixos configuration, not the dev-shell flake.
cd "$WORK_DIR"
nixos-rebuild "${BUILD_ARGS[@]}" > >(tee build.log) 2> >(tee build-errors.log >&2)
CLOSURE_DIR="$(readlink -f result)"
SWITCH_BIN="$CLOSURE_DIR/bin/switch-to-configuration"
TARGET_CLI="$CLOSURE_DIR/sw/bin/paseo"
if [[ ! -x "$SWITCH_BIN" ]]; then
  echo "Built closure has no executable switch-to-configuration: $CLOSURE_DIR" >&2
  exit 1
fi
if [[ ! -x "$TARGET_CLI" ]]; then
  echo "Built closure has no Paseo executable for checkpoint preflight: $TARGET_CLI" >&2
  exit 1
fi

echo "Built closure: $CLOSURE_DIR; retained build files: $WORK_DIR"
ACTIVATION_SCRIPT="$WORK_DIR/activate.sh"
cat > "$ACTIVATION_SCRIPT" <<'ACTIVATE'
#!/usr/bin/env bash
set -euo pipefail
closure="$1"
before="$(systemctl show paseo.service --property=InvocationID --value)"
nix-env --profile /nix/var/nix/profiles/system --set "$closure"
"$closure/bin/switch-to-configuration" switch
after="$(systemctl show paseo.service --property=InvocationID --value)"
# An unchanged unit is left running by NixOS. It is now checkpointed and paused,
# so it still needs one replacement. Never restart an already replaced daemon:
# its checkpoint has been claimed and it may already be generating new output.
if [[ "$before" == "$after" ]]; then
  systemctl restart paseo.service
else
  systemctl start paseo.service
fi
ACTIVATE
chmod 700 "$ACTIVATION_SCRIPT"
exec "${PASEO_CLI:-$ROOT_DIR/packages/cli/bin/paseo}" daemon deploy \
  --target-cli "$TARGET_CLI" --reason "$REASON" "${EXTRA_DEPLOY_ARGS[@]}" -- \
  /run/wrappers/bin/sudo "$ACTIVATION_SCRIPT" "$CLOSURE_DIR"
