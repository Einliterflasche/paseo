# Controlled restart recovery

Status: implemented and locally validated in the fork; not deployed.
Based on upstream `b8e24677e12b226c7c38c1c3a40649daa9f1152f`. Requirements are in
[fork-requirements.md](fork-requirements.md). On 2026-09-16 Raphael accepted the
controlled-restart limitation. The earlier Fable review covered the superseded
continuous-journal proposal, not this implementation plan.

## Scope and result

A controlled restart interrupts active agents, saves their display and pending
work, replaces the daemon, and continues the same native sessions automatically.
Start immediately; waiting for whole tasks to finish is not the default. Different
continuations and repeated interrupted tools are acceptable. Dropped or reordered
inputs and duplicate logical user messages are not.

Keep the existing supervisor, daemon, provider processes, and in-memory timeline
stores. Add JSON checkpoints written once per controlled restart. No additional
background process, database, continuous transcript writes, or persistent client
outbox. Native files supply the model's execution context; checkpoints preserve
Paseo's displayed history and continuation intent.

Unexpected crashes, forced termination before checkpoint completion, and client
process death/reload are outside the guarantee. Updates must keep clients alive
while they own unsent messages. Preparation depends on history size and provider
shutdown; measure it rather than promise a fixed downtime.

## Ownership

Add `packages/server/src/server/restart/checkpoint-store.ts` and a small
`restart-controller.ts`. The store owns validation and durable file writes; the
controller owns preparation through replacement. Keep agent execution state in
`AgentManager`, notification state with its driver, and schedules with their service.

User-facing operations are **restart** and **deploy**. Callers do not manually pair
save, flush, stop, and start. Concurrent restart requests join the same preparation.
Use a discriminated controller state:

```text
running -> preparing -> ready(generation) -> replacing
                \-> paused(error, retainedState) -> preparing on retry

boot -> validate ready generation -> claim -> restoring -> running
```

A failed checkpoint leaves the daemon paused with its state intact, serving
status/history and rejecting new execution with a typed retryable error. Internal
helpers return typed results; only the checkpoint store can produce readiness.
Never report success after a failed save or silently force replacement.

## 1. Retain inputs and freeze admissions

Extend `agent/agent-run-state.ts` with serializable data alongside its existing
promises. Capture each operation before provider dispatch: stable ID, original
client message ID, acceptance order, full `AgentPromptInput` and attachments,
queue/steer/replace intent, target attempt, run options, and execution state.
Distinguish pending dispatch, active work, accepted steering, completion, explicit
cancellation, and explicit replacement. Replacing work never deletes its input
from the display. Internal inputs receive an ID once at admission.

Do not serialize sessions, promises, or callbacks. The run owner releases settled
payloads while their displayed rows remain. Native session handles and stored-agent
configuration belong in the snapshot too.

Own the admission gate inside `AgentManager`: cover `streamAgent`,
`runSteerAdmission`/`recordAcceptedSteer`, and `tryRunOutOfBand`. Gate all of
`replaceAgentRun` before it cancels the existing run. `streamAgent` registers a
pending run synchronously, so a check only inside its generator is too late.
Use private execution helpers rather than caller-managed begin/end calls or
special recovery flags that every caller must remember.

Apply the same phase check to create/resume, stop, rewind, and configuration
mutations affecting the snapshot. Resolve admitted operations; reject later ones
before side effects. Schedule and agent-to-agent execution already reaches these
manager paths. Ephemeral internal response-loop helpers are not user tasks to revive.

## 2. Quiesce providers and other writers

Add manager-owned `quiesceForRestart`, used only by the controller:

1. Freeze admissions and scheduler ticks. Keep new internal notifications pending.
   Resolve already-admitted handoffs and receipt writes without waiting for model
   turns to finish. Do not send the client's whole queue through the harness.
2. Capture continuation intent, then interrupt/close providers while subscriptions
   remain attached. A real completion settles normally. Restart interruption
   suspends work; it is not user cancellation or a child-finished event.
3. Drain session-event tails, staged admission events, coalescers, and other
   tracked writers. Snapshot stable stores before discarding runtime objects.

In `agent-manager.ts`, move unsubscribe/reset after provider teardown and event
drain. Its current `prepareAgentForClosure` removes the agent before `session.close`;
restart must not reuse the permanent-close semantics. In Claude's
`providers/claude/agent.ts` and Codex's `providers/codex-app-server-agent.ts`, retain
subscribers and event translation through awaited teardown. Check early `closed`
guards as well as subscriber clearing. Verify Pi with the same late-event contract.

Record cancellation at the explicit stop initiator. Do not infer it from the final
`idle` status or a free-text cancellation reason. Preserve whether a terminal event
was genuine completion, explicit cancellation, or restart-induced interruption.

Track out-of-band commands and worktree setup until their existing operations
settle. `emitLiveTimelineItem` publishes provisional worktree output without a
stored row; provider coalescer draining alone misses it. In the first version,
wait for setup and its final canonical append before checkpoint commit. Do not
make every provisional delta permanent or replay an uncertain slash command as a
model prompt. A writer that cannot settle blocks preparation or reports failure,
never permits replacement. This may extend preparation during workspace setup;
it does not wait for an agent's entire task. Add no arbitrary timeout/history caps.

## 3. Commit the snapshot

Add snapshot/restore methods to `agent-timeline-store.ts` and
`provider-subagents/store.ts`. Export raw rows, epochs, next sequences, timestamps,
message IDs, provider correlations, and child descriptors/timelines. Include child
timeline keys not yet associated with a descriptor. Do not snapshot a paginated
or projected UI response.

Use versioned JSON under `PASEO_HOME/restart-checkpoints/`:

```text
<generation>/manifest.json
<generation>/snapshot.json
<generation>/claimed.json
ready.json
```

The manifest records the format version, generation ID, and snapshot checksum.
One snapshot contains agent metadata/native handles, raw timelines and child
timelines, unsettled inputs, notification obligations, and schedule ownership.
A single file keeps the commit boundary small. Existing Zod schemas validate the
whole generation before it can replace live state; incompatible versions fail closed.

Image bytes and inline attachments are part of the snapshot. Completed file uploads
already live under `PASEO_HOME/uploads` without expiry; checkpoint creation verifies
the referenced file and size and flushes its bytes. Missing or incomplete files block
replacement. Native resume reissues permission requests under the saved permission
mode; the checkpoint never serializes a callback or grants approval.

The store writes and flushes files, writes and flushes the manifest and generation
directory, then atomically replaces and flushes `ready.json` and its parent directory.
`atomic-file.ts` currently provides rename without this durability barrier. Errors
propagate; preserve prior generations. Flush required registry, receipt, and schedule
writes and verify native handles before readiness. Do not swallow flush failures.

Carry forward restored histories even when their agents were not reopened, using
immutable file references or current snapshots. Rewind invalidates the inherited
reference for that agent. Add no retention, expiry, or automatic deletion.

At boot, validate then write/flush `claimed.json` before executing any recovered
or new work. Never automatically replay a claimed generation after an unrelated
crash. Incomplete, corrupt, or incompatible ready state blocks recovery visibly;
do not silently replace it with shorter native history. Retain files for deliberate
recovery. A crash during restoration is outside the controlled-restart guarantee.

## 4. Restore work and its completion obligations

In `bootstrap.ts`, install saved stores and recovery ownership before admissions,
client queue draining, and schedule recovery. Start the listener without waiting
for every provider to launch. Expose restoring/paused state so an intermediate
`idle` cannot trigger client queue delivery.

Use `ensureAgentLoaded` and existing native resume with the saved handles. Seed
exact epochs/sequences and set `historyPrimed` for checkpoint-owned history;
`agent-loading.ts` must not force native hydration over it. Agents without a
checkpoint retain native loading. An unusable native session leaves its saved
history and blocked task visible; never silently create a fresh conversation.

Continue interrupted attempts through the existing hidden system-envelope
convention, including the active input and all unsettled accepted steers in order.
Reuse logical IDs and existing user rows. Filter provider echoes of the envelope;
do not create a visible continuation request or deduplicate by text. Two independent
identical submissions remain two. A repeated real tool execution is a new event.
Dispatch pending operations with their original queue/steer/replace semantics.
Restore active work before permitting a client queue to drain.

Check provider-child replay separately from top-level hydration. Use native
identities or explicitly suppress historical replay on checkpoint resume; do not
append old child history over a snapshot or guess duplicates by text.

In `agent-prompt.ts`, turn `setupFinishNotification` closure state into records:
watch ID, parent/child IDs, ownership rule, observed run, notified permission IDs,
and pending notification identity/payload. Keep delivery pending until parent
admission is confirmed; the current terminal `stopped` flag and log-and-drop catch
are insufficient. Reattach subscriptions before children run. Restart suspension
must not emit a false completion. An already-finished child with an undelivered
obligation still notifies once.

In `schedule/service.ts`, retain original schedule/run/agent/workspace IDs and
manual-run/cadence context. Exclude checkpoint-owned runs from
`recoverInterruptedRuns`, which currently fails them at boot. Reattach completion
to `finishRun` for the original run. Typed restart suspension bypasses shutdown
failure and workspace archival. Do not create a replacement scheduled run or agent.

## 5. Preserve client sends across reconnect

Extend `agent/requests/index.ts`, the existing receipt store. Match message ID and
fingerprint; a retry after a lost acknowledgement returns the completed outcome.
A frozen-admission rejection must occur before writing a pending receipt or write
an explicit known-not-dispatched state that permits retry. Unknown provider effect
is not rejection; do not blindly replay every pending receipt. Before ready, wait
for admitted send handlers and their receipt writes.

In `packages/client/src/daemon-client.ts`, let `sendAgentMessage` retain its payload
and message ID across transport attempts, using a fresh wire request ID each time.
Retry reconnect/restart-in-progress failures with the existing connection policy.
Do not replay arbitrary RPC mutations. Validation errors and ID/payload conflicts
remain terminal; disconnection alone must not reject the optimistic message.

In `packages/app/src/composer/actions.ts`, pass the queue item's existing ID through
dispatch instead of generating another. Retain encoded attachments until a definite
outcome. In `runtime/host-runtime.ts`, defer queue draining until the restored agent
permits it. Preserve `session-store.ts`'s existing live queue across reconnect.

Add an optional restart-recovery capability and preparation/restoration status in
`packages/protocol/src/messages.ts`. Use typed RPC errors for retryable rejection;
keep the successful send response compatible. Gate new behavior on the capability
and regenerate protocol validators through the existing script.

## 6. Connect restart and Nix deployment

For app/RPC restart, await checkpoint readiness before `daemon-worker.ts` sends
`paseo:restart`. Return preparation errors to the caller. Worker and supervisor
shutdown timers start only after readiness. Move plugin/provider teardown in
`bootstrap.ts` after checkpointing; currently it starts before agent closure.

Change CLI `daemon/restart.ts` to use this operation instead of SIGTERM followed by
automatic forced stop on timeout. A running old daemon without the capability
reports unsupported; an unreachable running daemon is not automatically killed.
Explicit force remains outside the guarantee. A stopped daemon can start normally.

Add one local CLI-owned `daemon deploy -- <activation argv>` operation and a thin
`scripts/deploy-nixos.sh` wrapper:

1. Build/validate the immutable fork package and system closure while agents run.
2. Request checkpoint preparation from the old daemon and verify its ready
   generation. Keep that daemon paused.
3. Only after success, run the built closure's `switch-to-configuration switch`
   with the operator's normal sudo access. Execute an argument array, not a shell
   string. The daemon never runs privileged commands.
4. Wait for the replacement daemon to report restoration of that generation.
   Surface failures; serialize deployments and allow retry of a paused attempt.

Run the finite deployment command outside `paseo.service`'s process group using
the VM's existing detached `systemd-run` convention. This is not a resident process.
Systemd/Nix stop timers then run after the checkpoint is secure. Increasing
`TimeoutStopSec`, or failing an `ExecStop`, cannot alone abort a systemd restart.
Raw signals, `systemctl restart`, and uncoordinated `nixos-rebuild switch` therefore
are not the safe deployment entrypoint. The command owns preparation plus activation;
the user never performs a two-command handoff.

The deployed upstream binary cannot prepare a checkpoint. First installation needs
an idle handover and export through existing history read APIs, validated into the
new checkpoint format before replacement. Pause producers and settle accepted sends
for that handover. Test it against an isolated old-version instance first; if a
complete stable export cannot be established, block rollout and preserve the old
daemon. Keep Slack active and preserve the packaging overrides in
[fork-maintenance.md](fork-maintenance.md). Updating fork maintenance with the
actual deploy command is part of implementation.

## Validation and rollout

Keep the changes as `fork patch:` commits above the upstream base: snapshot storage,
client/protocol support, daemon recovery, and restart/deployment operations. Their tests belong
with the behavior they verify.

Local validation covers these boundaries:

| Test                                         | Evidence                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controlled-restart.e2e.test.ts`             | Real daemon process replacement twice on the same state and port; exact saved history prefix and epoch; unopened history survives; duplicate send does not dispatch; explicit stop does not resume; failed commit leaves the old daemon alive.                   |
| `controlled-restart-reconnect.e2e.test.ts`   | One live SDK client holds a frozen send, reconnects automatically, and dispatches its original message ID once. No dispatch occurs while paused.                                                                                                                 |
| `controlled-restart-obligations.e2e.test.ts` | A child sends no false completion while suspended, notifies its parent once after recovery, and does not notify again after a second restart.                                                                                                                    |
| `controlled-restart-schedule.e2e.test.ts`    | An active scheduled task keeps its original run ID through two restarts, completes once, and is never falsely failed or archived.                                                                                                                                |
| `controlled-restart.real.e2e.test.ts`        | Real Claude, Codex, and Pi are interrupted inside a shell tool call and resume their original native session after a fresh daemon boot. Saved prefixes and epochs remain, retried user IDs do not duplicate, and a separately stopped active tool stays stopped. |
| `deploy-activation.e2e.test.ts`              | CLI deployment uses real sockets and an activation subprocess to replace an isolated daemon. The replacement reports the prepared generation. Mismatched generations and failed checkpoint commits never touch the old process.                                  |
| `scripts/deploy-nixos.test.mjs`              | Shell command ordering with substituted executables: build failure never prepares a restart; activation preserves exact argv; the complete operation runs outside the daemon's process group.                                                                    |

Targeted manager/store/controller/client/app/provider/schedule tests cover sequence and
attachment round trips, identical but distinct ordered inputs at every cut in a short
message sequence, late close output, stale turn events, lost acknowledgements, stable
retry payloads, stopped work, scheduled run ownership, frozen admissions, notification
capture, corrupt manifests, concurrent claims, failed writes and fsync, and refusal to
replace partially restored state. Repository typecheck, lint, formatting, and the server/CLI
build also run before committing. Checkpoint generations are retained; no retention
sweep is introduced.

Run tests from their workspace to use that workspace's Vitest configuration. The real Pi
run on this VM used `PI_REAL_TEST_MODEL=openrouter/z-ai/glm-5.3-flash`, matching the
operator's configured model; the shared provider-test helper's automatic default did not
select the configured backend. Native provider tests require the normal operator setup
and fail visibly when it is unavailable.

These checks do not claim a production NixOS switch or first installation onto the old
upstream daemon. The isolated activation subprocess is a process-replacement test, not
Nix evaluation. Before production rollout, validate the immutable Nix package and the
old-version idle export/handover described in [fork-maintenance.md](fork-maintenance.md),
then test a separate Nix/systemd service with isolated state and port. Benchmark large
histories before promising a preparation time. Permission prompts retain their provider
policy and must be reissued by the native provider; the real-provider tests above use
unattended permission modes and do not verify an interactive approval across restart.

Deferred features remain wait-until-idle restart, unexpected-crash recovery, persistent
client outbox, shared multi-device queue, and a checkpoint-management UI.
