# Migration requirements

These are Raphael's decisions from 2026-09-16. They define the target behavior;
they are not a claim that every capability has been implemented or verified.

## Workspaces and clients

Raphael creates and manages one Paseo workspace per thing he is working on.
Agents should not choose an organization scheme or automatically create one
workspace per chat or Slack thread. Git worktrees are separate working copies,
not security sandboxes; filesystem isolation is not a migration requirement.

Paseo is the central agent interface on the VM, including short question chats.
Desktop and mobile clients must reach the same ongoing work and conversation
history, with device handoff during a task.

## Agents and native capabilities

Support both forms of delegation together:

- A Paseo agent can spawn another Paseo agent. Raphael can open, message,
  interrupt, and otherwise interact with that child as an agent.
- An agent can use its harness's native subagents internally. Their activity,
  transcripts, and tool calls must remain inspectable in Paseo.

Retain native harness functionality, including steering, interruption, model
switching, and `/goal` where the harness provides it. Verify each capability
against the current provider and client; do not infer support from a shared UI
label. No order of implementation for remaining gaps has been chosen.

## Updates and recovery

Support controlled restart recovery using a checkpoint prepared before process
replacement. Raphael accepts that an unexpected crash or forced termination before
the checkpoint completes is outside the no-loss guarantee. Continuous crash-safe
transcript persistence is not required for this implementation. Keep the work
inside the existing daemon/lifecycle; do not introduce another background process.

Begin a controlled restart immediately by default, including while agents are working. A brief
client disconnect and reconnect is acceptable. Interrupted work must resume
automatically in the same conversation without Raphael sending a continuation
prompt. Waiting until agents finish is an optional, explicitly selected future
mode; it must not be a prerequisite for safe updates. Completing the restart
checkpoint is required before replacing the process.

Preserve user messages, queued messages, and agent output across the restart.
Preserve the history already produced. The resumed model may continue differently,
and an interrupted tool call may run again. A repeated tool execution is a real
new event and must be recorded honestly; replaying a stored message twice is a
delivery bug. Respect explicit cancellation: automatically resuming interrupted
work must not revive work the user deliberately stopped.

Every accepted user message must remain in the conversation, with its original
identity and ordering. A newer message must never silently discard an older one.
Queued and steered inputs remain pending until delivered or explicitly canceled.
Explicit stop or replacement changes execution, not the retained conversation.

Before deploying controlled restart recovery, exercise active turns, pending messages,
output delivery, and client reconnection across a real controlled daemon update.
The implementation and local validation evidence are recorded in
[restart-recovery-plan.md](restart-recovery-plan.md). Abort replacement
if the checkpoint cannot be completed. Reconcile native session state before continuing;
an uncertain native tool execution may repeat, but this does not permit duplicate
logical user messages or discarding previously recorded history.

Keep the implementation small and centralized. Correct persistence, ordering,
and recovery must be owned by the API implementation, with no paired calls or
special cleanup/retry obligations for each caller.
Independent client-process crash/reload recovery and a shared server-side message
queue are outside this daemon restart change. Keep pending client messages intact
through disconnect and avoid forcing client reload during a controlled update.

## Slack cutover

Keep Slack available until as late as possible in the migration. Retire the
bridge after direct Paseo use and the required recovery behavior are ready.
Preserve existing transcripts and archived conversations.

The fork's commit and upstream-update policy is in
[fork-maintenance.md](fork-maintenance.md).
