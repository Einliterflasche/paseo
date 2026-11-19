# Controlled restart recovery

The fork saves a restart checkpoint before a restart or a stop. The next boot restores it and
resumes the interrupted agents. Requirements are in [fork requirements](fork-requirements.md).
The fork has run restart recovery since 2026-09-16, with the best-effort policy since 2026-11-19.

## Policy

On 2026-11-19 Raphael removed every gate that blocked a restart, a stop, a boot, or a deployment.
Saving and resuming stay, as best effort. The rules:

- A restart, a stop, and a deployment always complete in bounded time.
- A boot always ends in state `running`, with admissions open.
- The daemon logs and skips a failed or slow step.
- One failed agent, service, file, or schedule never stops the others.
- The daemon never publishes a recovery error state.

Do not add a step that waits for an operator or blocks on an uncertain result. The gates of the
earlier design did not protect against a real failure. On 2026-11-17 the virtual machine was
powered off about 3 seconds into a checkpoint save. The next boots found `ready.json` pointing to
a used checkpoint, and the daemon stayed paused for about 19 hours. No provider failed to stop in
that log window.

`restart/best-effort.ts` provides `attempt` and `attemptWithin`. Every hook of
`restart/restart-controller.ts` runs through them. `bootstrap.ts` wraps each part of a hook
separately, so one failed part does not skip the next part.

## Stops that save a checkpoint

These stops save a checkpoint before the worker exits:

- A restart request, for example `paseo daemon restart`.
- A shutdown request, for example `paseo daemon stop`.
- SIGTERM or SIGINT to the supervisor.

SIGTERM reaches the supervisor through `systemctl stop`, `systemctl restart`, a host shutdown, or
the deployment wrapper. The unit sets `KillMode = "mixed"`, so only the supervisor receives SIGTERM.
The supervisor then asks the worker to save the checkpoint and to stop its agents.

A SIGKILL, a crash, or a power-off saves no checkpoint. [Limits](#limits) describes the result.

`paseo daemon stop --force` sends SIGKILL after its `--timeout`. With `--force`, set a timeout
above the checkpoint limit.

## What a checkpoint saves

A checkpoint is one JSON snapshot of the state that Paseo owns. The provider's native files supply
the model's execution context. The snapshot contains:

- Agent metadata and native session handles.
- Raw timelines, child timelines, epochs, and sequences.
- Accepted inputs that did not settle, in order, with their message IDs.
- Finish-notification obligations.
- Schedule ownership of the active runs whose agents the checkpoint saves for resume.
- The workspace and script identity of each running managed service.

Image bytes and inline attachments are part of the snapshot. Completed uploads stay under
`PASEO_HOME/uploads`. The capture checks the referenced files and logs a missing file.

A boot installs the saved history before it opens admissions. Then it resumes each agent that had
unfinished work. The continuation goes through the `<paseo-system>` envelope with the interrupted
input and every unsettled steer, in order. It keeps the original message IDs and user rows. The
continuation row has its own identity, so it appears once. Never deduplicate by text. Two identical
submissions stay two.

The boot also restores schedules with their original run IDs and reattaches finish notifications.
It relaunches managed services from their saved identities. Ordinary terminals and one-shot scripts
are not restartable work. An explicitly stopped agent does not resume.

An idle restored agent opens over its saved history. Opening it resumes the saved native session,
because only a live session reports its modes and features. Opening never starts a fresh
conversation.

## Phases

Clients read the phase from `server_info.restartRecoveryState` and the stage from
`restartRecoveryStage`.

| Phase       | Stage                    | Meaning                                                           |
| ----------- | ------------------------ | ----------------------------------------------------------------- |
| `running`   | none                     | Admissions are open.                                              |
| `preparing` | `stopping`               | Admissions are frozen. Provider sessions stop.                    |
| `preparing` | `checkpointing`          | The daemon captures and commits the snapshot.                     |
| `paused`    | `ready`                  | Preparation ended, with or without a checkpoint.                  |
| `paused`    | `replacing`              | The old worker waits for the supervisor to start its replacement. |
| `restoring` | `installing`, `starting` | The new worker installs the checkpoint, then resumes its agents.  |

`paused` never means an error. A failed checkpoint also reaches `paused` with stage `ready`, without
a generation. `restartRecoveryGeneration` names the generation that was saved or restored.

## Failures

The daemon logs each failure as a warning with the step name. It then continues as follows.

If a provider session fails to stop, the daemon logs the agent IDs and captures anyway. If the
whole stop phase exceeds its limit, the daemon logs step `stop` and starts the capture. If accepted
cancellations do not settle within the stop limit, the daemon logs step `controls` and continues.

An agent with unfinished work but no native session handle cannot be saved. Nothing can resume it.
Before the save, its timeline gets this error row, quoted from the code:
`The restart interrupted this task before Paseo could save it. Send a message to continue it.`

If the agent capture or the commit fails or exceeds the checkpoint limit, no checkpoint exists. The
restart continues. The replacement starts without a checkpoint. A failed notification or service
capture leaves that part empty and keeps the agents.

A checkpoint keeps the scheduled runs whose agents it saves for resume, and leaves out the rest.
A restored run waits for its agent's outcome. An agent that does not continue never sends one, so
the schedule cannot tick, run, or be deleted. The next boot marks the omitted runs as failed, and
their schedules stay usable.

If the schedule capture fails or is slow, the checkpoint still lists the runs that the schedule
store marks `running`, with the same filter. Without them, the next boot marks those runs as
failed. It then archives their workspaces while their agents resume there.

At boot, `loadAndClaim` can find a used, corrupt, or unreadable checkpoint. The daemon logs the
reason as step `load`, marks that generation as used, and starts without it. [Single-use
checkpoints](#single-use-checkpoints) gives the reason. When a user opens an agent, the agent loads
its native history.

If an agent's session resume fails or exceeds its limit, the daemon abandons that agent. Its run
ends as `failed`. Its timeline gets this error row, quoted from the code:
`Paseo could not resume this task after the restart. Send a message to continue it.` The other
agents still resume.

If the first event of a continuation does not arrive within the limit, the daemon logs it and
continues with the next agent. That agent counts as resumed, and its continuation keeps running.

Admissions can open before the resume reaches every agent, so a user can start new work first. If
an agent already has newer work, it keeps that work. The daemon does not resume the saved task and
writes no error row. Newer work is an active run or turn, or a run that settled after this boot.
A client that opens an agent loads its session, so an open idle session is not newer work. That
agent gets its continuation prompt on the open session.

A restart or a stop can arrive during the boot restore. It does not wait for the restore. The resume
stops, and the next checkpoint carries the agents that did not resume yet. This includes the agent
that the resume worked on at that moment. A failed or late resume of that agent leaves it
suspended. The worker can stop before it reported ready. The supervisor then still starts the
replacement.

If a managed service fails to relaunch, the daemon logs it and launches the next service.

If restoration exceeds its limit, the boot opens admissions. The remaining resume work continues in
the background.

When the worker exits or its exit limit passes, the supervisor kills the worker's process tree with
SIGKILL. If the worker still lives, the supervisor exits with code 1. On a restart, systemd then
clears the service group and starts the service again, because the unit sets `Restart = "on-failure"`.

## Time limits

This section owns every restart and deployment limit. Other docs link here.

| Limit                                    | Default | Covers                                                    | Set by                                    |
| ---------------------------------------- | ------- | --------------------------------------------------------- | ----------------------------------------- |
| `DEFAULT_SHUTDOWN_CHECKPOINT_TIMEOUT_MS` | 120 s   | Freeze, stop, capture, and commit.                        | `PASEO_SHUTDOWN_CHECKPOINT_TIMEOUT_MS`    |
| `RESTART_STOP_TIMEOUT_MS`                | 30 s    | Freeze and provider stop. At most half the checkpoint.    | Constant                                  |
| `RESTART_RESTORE_TIMEOUT_MS`             | 120 s   | Resume wait before a boot opens admissions.               | Constant                                  |
| `SHUTDOWN_STOP_GRACE_MS`                 | 30 s    | `daemon.stop()` after the checkpoint.                     | Constant                                  |
| `SHUTDOWN_CLEANUP_GRACE_MS`              | 25 s    | Service cgroup cleanup after the stop.                    | Constant                                  |
| `RESTART_SCHEDULE_CAPTURE_TIMEOUT_MS`    | 10 s    | Schedule part of the capture.                             | Constant                                  |
| `RESTART_RESUME_TIMEOUT_MS`              | 60 s    | Each agent's session resume and first continuation event. | `rescueTimeouts.restartResumeMs` in tests |
| `resolveWorkerGracefulExitMs`            | 180 s   | Supervisor wait for the worker exit.                      | Checkpoint limit + 30 s + 25 s + 5 s      |
| `WORKER_TERMINATION_GRACE_MS`            | 10 s    | Each supervisor kill, exit, and output wait.              | Constant                                  |
| `TimeoutStopSec`                         | 240 s   | Whole `paseo.service` stop.                               | Checkpoint limit + 120 s                  |
| `PASEO_DEPLOY_STOP_TIMEOUT`              | 300 s   | Deployment wrapper's `systemctl stop`.                    | Environment variable                      |
| `PASEO_DEPLOY_READY_TIMEOUT`             | 300 s   | Deployment wrapper's wait for an answering daemon.        | Environment variable                      |
| `paseo daemon restart --timeout`         | 600 s   | CLI wait for the replacement worker.                      | Option                                    |
| `paseo daemon stop --timeout`            | 15 s    | CLI wait for the daemon exit.                             | Option                                    |

The first five constants live in `packages/server/src/server/shutdown-checkpoint.ts`. The schedule
limit lives in `bootstrap.ts`. The resume limit lives in `agent/agent-manager.ts`. The supervisor
limit lives in `packages/server/scripts/supervisor.ts`.

Keep the resume limit below `RESTART_RESTORE_TIMEOUT_MS`. Otherwise one slow agent can use the whole
restore limit.

The NixOS option `services.paseo.shutdownCheckpointTimeout` sets the checkpoint limit in seconds.
It writes `PASEO_SHUTDOWN_CHECKPOINT_TIMEOUT_MS` and `TimeoutStopSec`. The worker and the supervisor
derive their limits from that variable.

`scripts/deploy-nixos.sh` also uses fixed limits:

- 60 s for the stop after its SIGKILL.
- 300 s for the system profile step.
- 1800 s for the switch.
- 120 s for the start of `paseo.service`.
- 120 s for the start of `multi-user.target`.
- 30 s for each status probe.

With the defaults, the supervisor waits 180 s and systemd waits 240 s. The wrapper waits 300 s, so
it kills only a stop that systemd did not end. If you raise `shutdownCheckpointTimeout` above 180,
raise `PASEO_DEPLOY_STOP_TIMEOUT` above the new `TimeoutStopSec`.

Measured on this VM, a save takes 0.5 to 18 s (median 5 s) for snapshots of 19 to 353 MB. A
restore with agent resume takes 3 to 92 s (median 10 s).

## Single-use checkpoints

A boot writes `claimed.json` before it runs any recovered work. A claimed generation is never
replayed. Without the marker, a crash after a restore replays the old checkpoint. That sends the
continuation prompts again and overwrites newer work. A checkpoint that fails at every boot also
causes a boot loop. The boot writes `restored.json` before it opens admissions.

If a boot cannot load the ready checkpoint, `abandonReady` writes `claimed.json` for that
generation. The boot then starts without the checkpoint and accepts new work. A later boot must
never replay the old continuation prompts over that work. If the pointer or the generation
directory is missing or unreadable, `abandonReady` does nothing. If a claim marker exists, it also
does nothing.

Never delete or rename the checkpoint files to force a replay.

## Limits

A crash, a SIGKILL, or a power-off loses everything that was not saved. The daemon then starts
normally. Agents load their native history on demand, but nothing resumes automatically. Paseo-only
rows and accepted inputs that were not saved can be lost.

A resumed model can continue differently. An interrupted tool can run again. A repeated tool run is
a new event in the timeline. A failed resume leaves an error row in that agent's timeline.

## Check the result

After a restart or a deployment, run `paseo daemon status` against the daemon's state directory:

```sh
paseo daemon status --home /home/agent/.local/state/paseo --json
```

Read these fields:

- `connectedDaemon`: `reachable` means that the daemon answers.
- `recoveryState`: `running` means that admissions are open.
- `restoredGeneration`: the restored checkpoint. A boot without a checkpoint omits it.

`paseo daemon restart` reports `checkpointRestored`. The value `true` means that the replacement
restored the generation that this restart saved.

Then search the daemon log, `$PASEO_HOME/daemon.log`. The log rotates into dated files in the same
directory.

```sh
grep -E 'Shutdown checkpoint|Shutdown step failed|Restart checkpoint loaded|Starting without a restart checkpoint|Restart recovery|Restart step failed|Could not resume agent' \
  /home/agent/.local/state/paseo/daemon.log
```

| Message (`msg`)                                                                          | Meaning                                                                                   |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Shutdown checkpoint committed; the next start restores it`                              | The old worker saved generation `generationId`.                                           |
| `Shutdown checkpoint missing; stopping without it, agents will not resume automatically` | The old worker saved no checkpoint.                                                       |
| `Shutdown step failed; continuing the stop`                                              | The old worker skipped a failed or slow `stop` or `cleanup`.                              |
| `Restart checkpoint loaded; restoring after the listener starts`                         | The new worker claimed generation `generationId`.                                         |
| `Starting without a restart checkpoint`                                                  | The new worker found no usable checkpoint.                                                |
| `Restart step failed; continuing without it`                                             | Step `step` failed or ran out of time. `err` gives the reason.                            |
| `Restart recovery resumed agents`                                                        | `resumed`, `superseded`, and `skipped` list agent IDs. `interrupted` marks a new restart. |
| `Could not resume agent after the restart`                                               | The daemon abandoned agent `agentId`.                                                     |
| `Restart recovery ended`                                                                 | Recovery is over. `restoredGeneration` is `null` without a checkpoint.                    |

Report the resumed and the skipped agents to the user. A skipped agent continues after a new
message. A superseded agent already had newer work, so the daemon did not resume its saved task.

## Old clients

Old clients can still send the removed recovery operations. The daemon answers each one with an
`rpc_error` with code `restart_operation_removed`. This covers a `restart_server_request` with
`prepareOnly`, `retryRecovery`, or `acknowledgeCrash`, and a `daemon.restart_anyway.request`.

A plain `restart_server_request` still restarts the daemon. `server_info` keeps
`features.restartRecovery`, `restartRecoveryState`, `restartRecoveryStage`,
`restartRecoveryGeneration`, and `restartCheckpointFormat`. It no longer sends the recovery error,
the emergency restart ID, or the affected agents. The protocol schemas keep those fields as optional
fields. `COMPAT(restartRecoveryOperations)` in `session.ts` marks the shim for removal.

## Checkpoint files

The store writes versioned JSON under `PASEO_HOME/restart-checkpoints/`:

```text
<generation>/manifest.json
<generation>/snapshot.json
<generation>/claimed.json
<generation>/restored.json
ready.json
```

The manifest records the format version, the generation ID, and the snapshot checksum. The store
flushes the generation files, then atomically replaces `ready.json`. It keeps older generations and
has no retention sweep.

The store writes the snapshot as compact JSON, without indentation. V8 cannot build a string above
about 512 MB, and the largest indented snapshot measured 353 MB. The readers accept both forms.

The writer uses format 4. The readers accept formats 1 to 4:

| Format | Adds                                                        |
| ------ | ----------------------------------------------------------- |
| 1      | Inline strings.                                             |
| 2      | Shared text leaves.                                         |
| 3      | Owned text backings and range references.                   |
| 4      | Stable workspace and script identities of managed services. |

A package that cannot read the current format starts without the checkpoint. Its agents do not
resume.

## Client sends during a restart

While admissions are frozen, the daemon rejects a mutation with the RPC error `restart_in_progress`
before any side effect. `packages/client/src/daemon-client.ts` keeps the payload and the message ID
of `sendAgentMessage` and sends it again after the reconnect. Each attempt uses a fresh request ID.
The receipt store in `agent/requests/index.ts` matches the message ID and fingerprint, so a retry
after a lost acknowledgment returns the first outcome.

The app passes the queue item's ID through dispatch. `runtime/host-runtime.ts` keeps the queue until
the restored agent permits it to drain. Validation errors and payload conflicts stay terminal.

## Validation

| Test                                         | Evidence                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `controlled-restart.e2e.test.ts`             | Two real process replacements keep the saved history prefix and epoch, never duplicate a send, and never revive an explicit stop. |
| `recovery-never-blocks.e2e.test.ts`          | A boot with a used or corrupt checkpoint reaches `running` and replays nothing.                                                   |
| `controlled-restart-reconnect.e2e.test.ts`   | A live SDK client holds a frozen send, reconnects, and dispatches its original message ID once.                                   |
| `controlled-restart-obligations.e2e.test.ts` | A suspended child sends no false completion and notifies its parent once after recovery.                                          |
| `controlled-restart-schedule.e2e.test.ts`    | An active scheduled run keeps its run ID through two restarts and completes once.                                                 |
| `controlled-restart-service.e2e.test.ts`     | A running workspace service is relaunched after the restart.                                                                      |
| `controlled-restart.real.e2e.test.ts`        | Real Claude, Codex, and Pi resume their original native sessions after an interrupted shell tool call.                            |
| `scripts/deploy-nixos.test.mjs`              | A failed build stops nothing, and activation always starts the service again.                                                     |

Run each test from its workspace. The real Pi run on this VM used
`PI_REAL_TEST_MODEL=openrouter/z-ai/glm-5.3-flash`. The real-provider tests use unattended permission
modes. They do not test an interactive approval across a restart.
