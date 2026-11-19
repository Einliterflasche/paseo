# Fork maintenance

Keep the upstream source and history intact. Put every customization in a
focused commit whose subject starts with `fork patch: ` followed by a short
description. Customizations may change any part of Paseo; keeping the patch
series reviewable is the constraint.

## Branches

- `origin`: publishing remote for `https://github.com/Einliterflasche/paseo.git`.
  `klaus-botty` has push access.
- `upstream`: fetch remote for `https://github.com/getpaseo/paseo.git`.
- `main`: working branch of our Paseo repository. It tracks `origin/main`.
- `upstream-base`: upstream commit underneath the current patch series.

Use `/home/agent/code/paseo-project` as the project container. It is not a Git repository.
The primary checkout is `/home/agent/code/paseo-project/main`.
Keep additional worktrees under `/home/agent/code/paseo-project/worktrees/`.
The repository name is `paseo`. The former working branch `fork` is now `main`.
The upstream source remains available through `upstream/main`.

The old path `/home/agent/code/paseo` links to the primary checkout.
The laboratory's original managed path links to `worktrees/ideenlabor` in the project container.
Keep these links while existing workspaces, agents and services use the old paths.

The initial upstream base is v0.8.0 revision,
`b8e24677e12b226c7c38c1c3a40649daa9f1152f`. Fetching newer upstream code does
not upgrade the running daemon. Commit and push completed changes to `origin/main`
unless Raphael explicitly requests local-only work. His standing authorization
to push to this repository was given on 2026-09-18.

Raphael requested deletion of the old worktrees and their generated files on 2026-10-04.
He also authorized removal of the old archive, rebase, inspection and Services
branches, both locally and on `origin`, and the remaining backup manifest.
These historical snapshots are no longer retained as branches.

The separate `Paseo Ideenlabor` workspace uses `worktrees/ideenlabor` for experiments.
Its agent develops one prototype per six-hour scheduled turn and retains demo evidence.
Raphael selects experiments for implementation. Keep experiments separate from `main`.

## Update upstream

The current [rebase plan](fork-rebase-plan.md) records deployed behavior, upstream
overlap, patch decisions, and qualification gates. Read it before rewriting the series.

Keep all fork patches directly above the selected upstream revision.
Rebase the entire series on every upstream update. Never merge upstream into
`main`, interleave local patches with upstream commits, or squash unrelated
customizations into one patch.

Start with a clean working tree. Fetch upstream, preserve the current main under
an archival branch name, then rebase. For an update to upstream's main branch:

```sh
git fetch upstream
git switch main
git branch "archive/main-$(date -u +%Y%m%dT%H%M%SZ)"
git rebase --onto upstream/main upstream-base main
```

Resolve conflicts within the affected patch. If upstream adopts a patch,
make sure that the behavior works before dropping its duplicate.
The archival branch retains the previous series.
Keep the `fork patch: ` subjects on surviving commits.

Run the checks required by the changed code. Inspect
`git range-diff upstream-base..<archival-branch> upstream/main..main`
before advancing the base marker:

```sh
git branch -f upstream-base upstream/main
git log --reverse --format='%h %s' upstream-base..main
git rev-list --merges upstream-base..main
```

The final command must produce no commits. Every subject in the patch range must
start with `fork patch: `. Publish rebased history to `origin/main` with
`--force-with-lease`, preserving collaborators' unexpected changes.
Never push our patches to the upstream remote.

On each upstream update and each Codex CLI update, refresh the Codex Daybreak
model list. [Codex Daybreak](codex-daybreak.md) gives the steps. The toggle is
enabled only for the models in that list.

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

This VM uses `parakeet-tdt-0.6b-v3-int8` for dictation and voice input.
Set both `PASEO_DICTATION_LOCAL_STT_MODEL` and `PASEO_VOICE_LOCAL_STT_MODEL`
through `services.paseo.environment`. English and German recognition needs these
overrides because the default v2 model supports only English. Live audio tests
passed after the checkpointed deployment on 2026-09-30.

Switching languages within one recording remains unreliable. Keep the current
auto-commit behavior until a pause-based improvement passes audio-preservation
and lifecycle tests. The deployment and continuity evidence is retained in
`/home/agent/paseo-deployments/voice-bilingual-activation-20260930/`.

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
service restart. Push the committed revision to `origin/main` before deployment.

Deploy with `scripts/deploy-nixos.sh` after that pin update. It submits the whole job with
`/run/wrappers/bin/sudo systemd-run` as a transient unit named `paseo-deploy-<time>-<pid>`. The unit runs as the
operator, outside `paseo.service`. The launcher prints the unit name and returns after submission.
Follow the job with `journalctl -fu <unit>` until it ends. Submission alone does not mean that the
deployment succeeded.

The job runs these steps:

1. Build with `nixos-rebuild build` in a fresh `/tmp/paseo-deploy.*` directory.
2. Run `timeout <PASEO_DEPLOY_STOP_TIMEOUT> systemctl stop paseo.service` as root.
3. If the stop fails or times out, kill the service with SIGKILL.
4. Run `systemctl reset-failed paseo.service`.
5. Set the system profile, with a 300 s limit.
6. If the profile step succeeds, run the closure's `switch-to-configuration switch`.
7. Run `systemctl start paseo.service`, also after a failed step.
8. If the profile or switch step failed, run `systemctl start multi-user.target`.
9. Poll the new closure's `paseo daemon status --json` every 2 seconds.

If the build fails, the job ends with the build status and nothing stops. The build directory
keeps `build.log`, `build-errors.log`, and the `result` link.

The daemon saves its checkpoint during the stop in step 2. In step 3, the job runs
`systemctl kill --signal=SIGKILL`, then a second bounded `systemctl stop`. It ignores errors in
both. The new daemon then starts with the checkpoint that was saved before the kill. If no
checkpoint was saved, its agents do not resume automatically.

A failed switch can leave other units stopped, for example the public front. Step 8 starts them
again. The job ignores a failure of step 8.

If the status reports `"connectedDaemon": "reachable"`, step 9 ends. The job then prints the
status and exits with the activation status. If the daemon does not answer within
`PASEO_DEPLOY_READY_TIMEOUT`, the job exits with 1. [Time limits](restart-recovery-plan.md#time-limits)
lists every limit and its default.

The journal shows one result line for each step:

- `Build result:`
- `Stop result:`
- `Profile result:`
- `Switch result:`
- `Start result:`
- `System units result:`
- `Activation result: exited with status <n>.`
- `Daemon status:`

`Stop result: forced kill.` means that the stop exceeded its limit. A non-zero exit of the job means
that the build, the profile step, the switch, or the start failed, or that the daemon did not answer. Read the
journal lines to find the failed step. The job runs the start step in every case, so only a failed
start leaves the service stopped.

The VM-wide continuity rules are in `/home/agent/AGENTS.md`. Build and test while the old service
stays available. Use the wrapper as the deployment entry point, because it builds first and runs
outside `paseo.service`. Do not invoke its internal worker or activation script yourself.

On this VM, select the live state directory explicitly. The
detached job also needs the host's `NIX_PATH` and its credential file via `PASEO_DEPLOY_ENV_FILE`.
The script calls the setuid wrapper `/run/wrappers/bin/sudo` by its full path. The `sudo` in an
agent's PATH is not setuid and fails, so the order of PATH does not matter.
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

To restart the installed package, run authenticated `paseo daemon restart` with the same live
`PASEO_HOME`. The daemon always completes the restart. The command waits for the replacement
worker and reports `checkpointRestored`. For a new package or NixOS configuration, use the
deployment wrapper.

After a deployment or a restart, check that the daemon answers `paseo daemon status`. Report its
`recoveryState`, its `restoredGeneration`, and which agents resumed. The daemon log names
the resumed, the superseded, and the skipped agents in one summary line. A skipped agent shows an error row in its
timeline, and a new message continues it. [Check the result](restart-recovery-plan.md#check-the-result)
gives the commands and the log messages.

Before you hand deployment ownership to another agent, record that result. Compare each
previously active agent's native session identity. Make sure that the web client reconnects and
that a scheduled run completes. Save the daemon's memory metrics for the five minutes before
activation and at one and five minutes afterward. Compare worker heap and RSS separately from the
service cgroup, which includes provider subprocesses. Keep the 6144 MiB allowance until you observe
the workload after the deployment. A short healthy sample is not a long-run memory bound.

Keep prior packages available for a rollback. A package that cannot read checkpoint format 4
starts without the checkpoint, so its agents do not resume.

The migration requirements and release acceptance criteria are in
[fork-requirements.md](fork-requirements.md). The checkpoint format and controlled-restart
sequencing are in [restart-recovery-plan.md](restart-recovery-plan.md).
