# Fork maintenance

Keep the upstream source and history intact. Put every customization in a
focused commit whose subject starts with `fork patch: ` followed by a short
description. Customizations may change any part of Paseo; keeping the patch
series reviewable is the constraint.

## Branches

- `upstream`: fetch remote for `https://github.com/getpaseo/paseo.git`.
- `origin`: publishing remote for `https://github.com/Einliterflasche/paseo.git`;
  `klaus-botty` has push access.
- `main`: unmodified mirror of `upstream/main`.
- `upstream-base`: upstream commit underneath the current patch series.
- `fork`: working branch; all commits after `upstream-base` are fork patches.

The checkout is `/home/agent/code/paseo`. The initial upstream base is v0.8.0 revision,
`b8e24677e12b226c7c38c1c3a40649daa9f1152f`. Fetching newer upstream code does
not upgrade the running daemon. Commit and push completed changes to `origin/fork`
unless Raphael explicitly requests local-only work. His standing authorization
to push to this fork was given on 2026-09-18.

## Update upstream

Fork patches must always be the newest commits, directly on top of the selected
upstream revision. Rebase the entire series on every upstream update. Never merge
upstream into `fork`, interleave local patches with upstream commits, or squash
unrelated customizations into one patch.

Start with a clean working tree. Fetch upstream, preserve the current fork under
a new archival branch name, then rebase. For an update to upstream's main branch:

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch fork
git branch "archive/fork-$(date -u +%Y%m%dT%H%M%SZ)"
git rebase --onto main upstream-base fork
```

Resolve conflicts within the affected patch. If upstream has adopted a patch,
verify the behavior before dropping its duplicate; the archival branch retains
the previous series. Keep the `fork patch: ` subjects on surviving commits.

Run the checks required by the changed code and inspect `git range-diff
upstream-base..<archival-branch> main..fork` before advancing the base marker:

```sh
git branch -f upstream-base main
git log --reverse --format='%h %s' upstream-base..fork
git rev-list --merges upstream-base..fork
```

The final command must produce no commits. Every subject in the patch range must
start with `fork patch: `. Publish rebased history to `origin/fork` with
`--force-with-lease`, preserving collaborators' unexpected changes.
Never push our patches to the upstream remote.

## Deployment baseline

The live daemon is managed by `/etc/nixos/configuration.nix`, with its source
pinned independently of this checkout. As of 2026-09-16, the host adds two Paseo
packaging overrides that must be accounted for when moving deployment to the fork:

- The host-verified npm dependency hash is
  `sha256-gDB48rHd0K1VOAblaQlPP4XnKGHI8cAt9S09aRxx6b4=`.
- The Nix build rebuilds `node-pty` in the `@getpaseo/server` workspace and copies
  its Linux x64 `pty.node` into the installed workspace's prebuild directory.

Carry required source/build fixes as their own fork patch commits when wiring
this repository into deployment. Keep machine configuration and credentials in
the existing host configuration. Use the project's flake for development tools.
Develop against separate runtime state; the live state is
`/home/agent/.local/state/paseo`.

Set `services.paseo.environment.PASEO_DAEMON_HEAP_MB` in the host configuration
to choose the daemon worker's Node old-space limit in MiB. This VM uses `6144`
as temporary headroom while the cumulative transcript fix is validated and observed
under the production workload.
The supervisor passes the limit directly to the worker and removes the setting
from its environment; agent subprocesses keep their own defaults. Do not use
service-wide `NODE_OPTIONS` for this adjustment. The heap limit is an allowance,
not reserved RAM, and excludes native buffers and other processes.

The VM has run this fork with restart recovery since 2026-09-16. The initial
handover is complete; its backups and verification are retained in
`/home/agent/paseo-deployments/20260916T112552Z`. Do not reuse its one-time
bootstrap scripts for later updates.

For an update, first validate and commit the change, retain the previous fork
revision, and create an immutable source archive from the committed revision.
Update the `paseoSrc` archive URL and unpacked hash in
`/etc/nixos/configuration.nix`, preserving the packaging overrides above. Keep the
previous archive and host configuration. A checkout edit or a history-only squash
does not update the running package; a squash with the same Git tree needs no
service restart. Push the committed revision to `origin/fork` before deployment.

What the CLI now owns is the activation step after that pin update: `paseo daemon
deploy --target-cli <replacement-paseo> -- <activation argv>` prepares a checkpoint on the _running_ daemon, runs the
given argv (executed directly, no shell) only once that checkpoint is ready, and only
reports success once the replacement daemon confirms it is running that exact
checkpoint generation. It never runs the activation command without a ready
generation validated by the replacement package, never force-kills anything on failure, and serializes concurrent deploys
with a `deploy.lock` file in `PASEO_HOME`. Investigate its owner if a previous attempt
failed; never delete state to force a deployment through. `scripts/deploy-nixos.sh` wraps the whole sequence for a
NixOS host: it builds the closure with `nixos-rebuild build` (never `switch` directly),
then hands activation of that exact closure to `paseo daemon deploy`, with the closure's
own Paseo executable as `--target-cli`. Only after
the checkpoint succeeds does activation update the system profile and switch the
configuration. If NixOS leaves the service unchanged, activation replaces the
paused service once; if NixOS already replaced it, activation does not restart it again.
The wrapper runs the built closure's CLI for both deployment and checkpoint
validation. That CLI refuses live terminals, including managed script terminals,
before Prepare and checks again after Prepare has frozen mutation admission and
drained the scheduler. It verifies the same paused, ready generation around that
second inventory. A failed inventory or changed generation prevents activation.
This is a refusal policy, not terminal transfer: deployment cannot preserve a
running managed service by moving it into the replacement. A refusal after
Prepare leaves the checkpoint and paused daemon intact for diagnosis.
The complete build and activation run in a finite `systemd-run` unit as the operator,
outside `paseo.service`, with build logs and the result link retained. The launcher
returns after submission; follow the printed unit with `journalctl -fu <unit>`
until deployment reports the restored generation. Submission is not deployment success.
The worker waits for an explicit handoff after `sudo systemd-run` returns, so no
privileged waiting client remains in the provider tree when checkpointing begins.
A process that changed user inside an agent's tree (for example `sudo journalctl -f`
or `sudo nixos-rebuild build` started from a session) cannot be signaled by the
daemon at all. Teardown certification skips such foreign-owned processes: the
daemon stops everything it owns, including owned descendants beneath the foreign
process, and the foreign process itself is left running as an orphan. It cannot
write into the provider pipe the daemon owns, so it cannot alter recorded history.
This does not change service OOM preferences or the activation command's privileges. Readiness has no
default deadline; `--wait-timeout` adds one explicitly and never kills a process.

The VM-wide continuity rules are in `/home/agent/AGENTS.md`. Build and test while
the old service stays available, use the wrapper as the sole deployment entry
point, and follow its detached job until it reports the restored generation.
Do not invoke its internal worker or generated activation script yourself.

On this VM, select the live state directory explicitly. The
detached job also needs the host's `NIX_PATH`, a PATH that finds
`/run/wrappers/bin/sudo`, and its credential file via `PASEO_DEPLOY_ENV_FILE`.
The current credential source is `/home/agent/.config/slack-bridge/raphaels_agent.env`;
systemd loads it privately, so do not print or put its contents in command arguments.
An exported password alone is not forwarded to the detached job. Use `--flake`
only for a separate NixOS flake, never the Paseo development flake:

```sh
PASEO_HOME=/home/agent/.local/state/paseo \
PASEO_DEPLOY_ENV_FILE=/home/agent/.config/slack-bridge/raphaels_agent.env \
./scripts/deploy-nixos.sh
```

The NixOS source pin must already identify the immutable revision being deployed.
Running this command is an actual deployment, not a validation command.

For an authorized restart of the currently installed package, use authenticated
`paseo daemon restart` with the same live `PASEO_HOME`, without `--force`.
This requests a checkpointed supervisor replacement; a successful request alone
does not prove restoration is complete. Verify the reported generation is running
after reconnect. For a new package or NixOS configuration, use the deployment wrapper.

An unsupported or unreachable daemon, failed checkpoint, or readiness error is a
reason to inspect the logs and retained state. Never fall back to raw stop/start,
signals, `--force`, a direct NixOS switch, or a reboot. A paused daemon may hold the
only complete recovery state; preserve it. After a partially completed activation,
understand which generation is running before retrying or considering rollback.

Success means the expected checkpoint generation is restored, agents continue their
work, and the updated web UI reconnects. A process or open port alone is insufficient.
The guarantee covers controlled restarts, not power loss, arbitrary crashes, or
harness-native loops. Keep prior packages and state available for an inspected,
compatible rollback. A package must support the offline `daemon checkpoint-check`
command and read the prepared checkpoint's format before it can be activated.
The preflight checks advertised formats before preparation, then validates the exact
ready generation's checksum and schema without claiming it. Older packages that
lack this command are rejected; do not flatten history or bypass preflight to use them.
Recovery semantics also need the isolated handoff test; format acceptance alone is
not rollback evidence.

The package deployed before the systemic memory fix does not support that preflight
or checkpoint format 3. Keep its archive for investigation; it is not a compatible
rollback target. Until another validated package supports the current format, recovery
means repairing forward while preserving the paused daemon and its checkpoint.

Before handing deployment ownership to another agent, record the restored generation
and its `running` state, compare each previously active agent's native session identity,
confirm the web client reconnects, and observe a scheduled run complete. Save the
daemon's existing memory metrics for the five minutes before activation and at one
and five minutes afterward. Compare worker heap and RSS separately from the service
cgroup, which includes provider subprocesses. Keep the 6144 MiB allowance until the
post-deployment workload has been observed; a short healthy sample is not a long-run
memory bound.

## Deliberate recovery after an unexpected crash

Use this only when a reachable paused daemon reports that its exact generation
already completed restoration. That checkpoint predates work accepted afterward.
Ordinary `--retry-recovery` cannot reconstruct the lost runtime from it. Failed
controlled preparations, partially claimed generations, corrupt data, and incompatible
formats do not qualify; keep them paused for repair.

Inspect the retained checkpoint, daemon logs, current agent registry, native provider
sessions, and schedule records first. Reconcile effects already performed by providers
and confirm orphan provider execution has stopped. The command cannot discover or stop
unknown workers from the dead process on your behalf.

After accepting the unexpected-crash data loss, use the generation reported by the
paused daemon and its actual state directory:

```sh
PASEO_HOME=/path/to/live-state paseo daemon restart \
  --acknowledge-crash <reported-generation> --orphan-execution-reconciled
```

The acknowledgment also accepts these consequences: old checkpoint continuations are
not replayed; native history is loaded when agents are later opened; Paseo-only system
rows, client message identities, child descriptors, and pending finish notifications
may be missing. Persisted running schedules are marked failed during reconciliation,
even if their orphaned provider had completed. This is a manual recovery decision,
not controlled-restart restoration.

The same daemon stays running. It verifies the exact consumed generation, writes an
attributed audit receipt, initializes current owners, and commits a successor containing
that audit provenance before opening admissions. Check its reported `running` state and successor generation. All
old checkpoint files remain available. A failed initialization uses ordinary
`--retry-recovery` with the retained current state. A process death before the successor
requires a fresh operator decision: audit receipts never authorize boot recovery.
Another crash after success blocks against the new consumed generation.

Never delete or rename `ready.json`, `claimed.json`, or `restored.json` to get past a
failure, and never combine this operation with raw stop/start or `--force`.

The migration requirements and release acceptance criteria are in
[fork-requirements.md](fork-requirements.md). The checkpoint format and controlled-restart
sequencing are in [restart-recovery-plan.md](restart-recovery-plan.md).
