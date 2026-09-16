# Fork maintenance

Keep the upstream source and history intact. Put every customization in a
focused commit whose subject starts with `fork patch: ` followed by a short
description. Customizations may change any part of Paseo; keeping the patch
series reviewable is the constraint.

## Branches

- `upstream`: fetch remote for `https://github.com/getpaseo/paseo.git`.
- `main`: unmodified mirror of `upstream/main`.
- `upstream-base`: upstream commit underneath the current patch series.
- `fork`: working branch; all commits after `upstream-base` are fork patches.

The checkout is `/home/agent/code/paseo`. The initial upstream base is v0.8.0 revision,
`b8e24677e12b226c7c38c1c3a40649daa9f1152f`. Fetching newer upstream code does
not upgrade the running daemon. This repository is local to the VM; a publishing
remote has not been configured.

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
start with `fork patch: `. If a fork remote is configured later, publish rebased
history with `--force-with-lease`, preserving collaborators' unexpected changes.
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
service restart. A publishing remote is optional.

What the CLI now owns is the activation step after that pin update: `paseo daemon
deploy -- <activation argv>` prepares a checkpoint on the _running_ daemon, runs the
given argv (executed directly, no shell) only once that checkpoint is ready, and only
reports success once the replacement daemon confirms it is running that exact
checkpoint generation. It never runs the activation command without a ready
generation, never force-kills anything on failure, and serializes concurrent deploys
with a `deploy.lock` file in `PASEO_HOME`. Investigate its owner if a previous attempt
failed; never delete state to force a deployment through. `scripts/deploy-nixos.sh` wraps the whole sequence for a
NixOS host: it builds the closure with `nixos-rebuild build` (never `switch` directly),
then hands activation of that exact closure to `paseo daemon deploy --`. Only after
the checkpoint succeeds does activation update the system profile and switch the
configuration. If NixOS leaves the service unchanged, activation replaces the
paused service once; if NixOS already replaced it, activation does not restart it again.
The complete build and activation run in a finite `systemd-run` unit as the operator,
outside `paseo.service`, with build logs and the result link retained. Readiness has no
default deadline; `--wait-timeout` adds one explicitly and never kills a process.

The VM-wide continuity rules are in `/home/agent/AGENTS.md`. Build and test while
the old service stays available, use the wrapper as the sole deployment entry
point, and follow its detached job until it reports the restored generation.
Do not invoke its internal worker or generated activation script yourself.

On this VM, use the installed recovery-capable CLI or build the checkout's CLI
first (`npm run build:server`). Select the live state directory explicitly. The
detached job also needs the host's `NIX_PATH`, a PATH that finds
`/run/wrappers/bin/sudo`, and its credential file via `PASEO_DEPLOY_ENV_FILE`.
The current credential source is `/home/agent/.config/slack-bridge/raphaels_agent.env`;
systemd loads it privately, so do not print or put its contents in command arguments.
An exported password alone is not forwarded to the detached job. Use `--flake`
only for a separate NixOS flake, never the Paseo development flake:

```sh
PASEO_HOME=/home/agent/.local/state/paseo \
PASEO_CLI=/run/current-system/sw/bin/paseo \
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
schema-compatible rollback.

The migration requirements and release acceptance criteria are in
[fork-requirements.md](fork-requirements.md). The checkpoint format and controlled-restart
sequencing are in [restart-recovery-plan.md](restart-recovery-plan.md).
