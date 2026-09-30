# Fork rebase qualification

This records the completed source integration for the 2026-09-30 upstream update.
The live source pin, host speech configuration, daemon, and state remain unchanged.
Publication and deployment are separate steps. Use [fork maintenance](fork-maintenance.md)
for the checkpointed deployment path and [fork requirements](fork-requirements.md)
for the preservation contract.

## Frozen revisions

| Reference              | Revision                                   | Role                                                                  |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| Deployed package       | `3ceb1c966a0ebf42e6cccd401eaf97ae832543da` | Existing executable baseline; checkpoint format 4                     |
| Archived fork          | `0c64299f5c9a4a9880da6db3a6549da0b90b6b40` | Original 41 logical patches; executable tree matches deployed package |
| Previous upstream base | `b8e24677e12b226c7c38c1c3a40649daa9f1152f` | Original replay boundary                                              |
| Frozen new upstream    | `1f5f5d384e9409240c11fc4491fcdb247ea4bc14` | Actual rebase target                                                  |

The target is five commits newer than the preparation audit's `318a84a57`.
It includes the provider-option fixes, Muse installation and rules, terminal command
rows, usage percentages and host selection, and removal of unreleased Antigravity.
Antigravity stays removed. Upstream Find and Replace, plugin installation and updates,
pane and route ownership, native speeds, provider additions, and newer usage behavior
remain in the integrated tree.

The original series is retained at `archive/fork-20260930T201631Z`. The isolated
candidate is `rebase/fork-20260930T201631Z`; the replay mapping and reviewed range-diff
are retained in the run evidence below. All surviving fork subjects use `fork patch:`.
The 17 old unprefixed subjects were renamed. No upstream merge or unrelated squash
was introduced.

## Retained patch boundaries

| Original patches                                        | Result                     | Preservation boundary                                                                                                                        |
| ------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Restart foundation `1b76b4d10`                          | Adapted                    | Accepted input identities/order, admission freeze, receipts, schedules, notification continuation and checkpointed CLI deployment            |
| Theme `362b91f7e`                                       | Retained                   | Catppuccin defaults and existing explicit choices                                                                                            |
| Login `a7ced8cfe`                                       | Adapted                    | Actual serving origin, HTTPS/nonstandard ports, upstream host-profile credentials and typed hello failures                                   |
| Dictation `53294dde2`, `88b0c97e1`                      | Adapted                    | One voice owner across modal/form/composer fields; upstream stable shortcuts and editor handles                                              |
| Files `3f87b03ca`, `ae040716b`                          | Adapted                    | Source-owned grants, PDF/media previews, byte ranges, downloads and upstream source Find/Replace                                             |
| Heap/history `65f76230e`, `8b30d827b`, `5942258a5`      | Adapted                    | Worker-only 6144 MiB allowance, canonical shared history, projected display/query APIs and exact format-4 snapshots                          |
| Ownership `dda390826`, `77cea0984`                      | Extended                   | Retryable certified teardown for existing adapters, OpenCode v2, plugins and Muse; foreign processes skipped and owned descendants certified |
| Services `02c383686` and follow-ups through `f2949becd` | Adapted                    | Authenticated same-origin catalog/grants, private control listener, prefix mounts, lifecycle controls, thumbnails, workers and Fast Refresh  |
| Service recovery `5de538ac3`, `bbd4e2ae3`               | Retained                   | Format-4 stable workspace/script identities, managed-service relaunch and ordinary-terminal inventory refusal                                |
| Graceful stop `39a68cd53`                               | Strengthened               | Checkpoint before graceful stop; checkpoint failure or timeout retains execution ownership and blocks replacement                            |
| Opus `33b2d1fb3`                                        | Duplicate catalog replaced | Upstream Opus 5.5 definitions/version gates retained; fork Opus 5/high default preserved                                                     |
| Codex `3ceb1c966`                                       | Static list replaced       | Upstream native Speed migration retains saved true/false; new drafts/tasks use Normal                                                        |
| Fork policy/audit and bilingual host documentation      | Retained/integrated        | Archival publication rules, completed qualification and unchanged host speech configuration                                                  |
| New project ranking                                     | Separate focused patch     | Green ready-to-review projects first, blue working next, gray idle last, alphabetical ties; green wins mixed projects                        |
| New web build resource limit                            | Separate build patch       | Reproducible daemon/Nix web export with a build-only heap allowance and one Metro worker; runtime heap policy unchanged                      |

The replaced model implementations keep their logical patch boundaries and equivalent
behavior tests. They are not whole memory/lifecycle patch deletions. Schedules still
use `archiveOnFinish=false`. Sidebar preferences remain local; the new project ranking
changes displayed order only. English/German speech v3 remains host configuration;
audio segmentation is unchanged.

## Tested overlap decisions

Canonical events and upstream projected rows have separate roles in one timeline
owner. Checkpoints retain increasing canonical sequences, exact epochs/cursors and
shared text/backings. Queries derive upstream projected rows with latest tool state
and source ranges. Interleaved projected ending sequences can be non-monotonic;
they never enter the canonical format-4 schema. Native replay cannot overwrite
checkpoint-installed main or provider-child history. Format 4 keeps its existing
meaning; no format-5 writer or in-place semantic rewrite was introduced.

The app and SDK retain upstream OwnedSubscriptions and atomic history replacement.
Recovery freezes queue draining and uses fresh source-owned server information before
retrying accepted sends. Child transcripts use bounded page queries and owned child
target subscriptions. Finish-watch deduplication shares the persisted logical run
registry and receipt owner, including notifications pending across replacement.

OpenCode v2 helper generations/leases, plugin sessions/workers and Muse processes
retain retry ownership until native work, descendants and final output are certified.
Plugin probes are drained before immutable readiness. The SDK resume option suppresses
native history replay only where checkpoint history owns the timeline.

Services authorization is tied to the verified same-origin password session and
physical connection source, including modern hello authentication. Status catalog
projection and revocation follow the same source owner. The centralized app projection
carries preview registry and recovery metadata; a new snapshot clears absent fields.
Preview and lifecycle controls have separate press targets, so an unavailable preview
does not disable Start or Stop. Upstream environment ownership accepts the existing
preview configuration keys. New mutation paths join their central admission owner;
cleanup remains available during preparation.

The Expo development helper keeps public bundle, Worker and development socket URLs
under the configured prefix. HMR registration removes that prefix only from Metro's
filesystem-facing entrypoints and retains their query options. Its streaming byte
transform preserves UTF-8 chunk boundaries without buffering the bundle. Actual Expo
Fast Refresh retains React counter and input state through the authenticated prefix.

Graceful-stop failure previously fell through to timed worker/systemd termination.
The integrated worker, supervisor and NixOS module retain the daemon instead.
`SendSIGKILL=false` and an unlimited unit stop wait prevent the checkpoint deadline
from becoming a replacement shortcut. Diagnose a pending failed stop and retry the
checkpointed deployment path. A VM host can still impose its own external shutdown
limit; prepare before host maintenance.

## Qualification evidence and limits

Evidence is retained at `/home/agent/paseo-rebase-runs/20260930T201631Z/`.
`baseline.json`, `old-patches.txt`, `target-delta.txt`, `rewritten-list.txt` and the
final mapping/range-diff preserve the inputs and history review. The separate working
copies and earlier audit evidence under `/home/agent/paseo-rebase-audits/20260930/`
remain available; no diagnostic tree was copied over the fork.

Candidate dependencies were installed in the isolated worktree. Owning protocol,
client, plugin, server, CLI and native-audio declarations were rebuilt before type
checks. Full workspace typecheck, lint and formatting checks passed after integration.
Focused affected files were run separately under the shared validation lock; the full
local suite was not run. Specialist green results were trusted without duplicate runs.

Metro's transform of the generated protocol validator exhausted Node's default
heap in both local and immutable Nix exports. The shared daemon-web export now
owns a build-only 6144 MiB allowance and one Metro worker. Nix uses that same
entry point; the installed wrappers and runtime worker heap scope stay unchanged.

Focused evidence covers queue/reconnect/authentication, projected/canonical timeline
history, shared backing memory, exact snapshots, checkpoint-owned replay, input receipt
ambiguity, admission, schedules/watch receipts, native close/probe/retry ownership,
real OpenCode v2 helper leases and detached descendants, external/builtin plugin
workers, worker heap scope, service gateway/prefix/worker policies, terminal inventory,
managed-service restoration and graceful checkpoint refusal/retry. App reports retain
unit counts and packaged browser results separately. Packaged Chromium checks passed
password onboarding, shared dictation, file/media downloads, upstream Find/Replace,
Services lifecycle and source switching, authenticated thumbnails, preserve/strip
prefix panes with Workers/WebSockets, independent standalone preview tabs, and Expo
Fast Refresh with retained component state. The
standalone question component fixture had an Expo Router/native-module optimizer
failure; the packaged dictation path passed. Firefox, native devices and an installable
Electron distribution were not qualified.

The installed provider versions were read without prompts or authentication checks:
Claude Code 2.1.280, Codex 0.159.2 and Pi 0.84.4. Sonnet 5.5 remains gated below
Claude 2.1.284. Actual owned Codex model discovery advertises native Fast tier
`priority`; the public catalog intentionally omits that per-session metadata.
Copilot, OpenCode, Oh My Pi and Muse executables were unavailable on the active PATH;
isolated native protocol/process fixtures qualify their ownership changes. Paid
provider execution and native microphone/device behavior were not exercised.

Actual isolated old-to-new replacement uses the installed old executable and candidate
bootstrap with deterministic native-session boundaries. Retained qualification homes
record accepted original and steered inputs, queued sends across reconnect, stopped
work, unopened histories/children, logical schedule identity, notification delivery,
exact format-4 canonical history/epochs/backings and managed-service relaunch/refusals.
Check the exact package paths and generations in each `qualification.json`.
The first basic orchestrator completed every assertion, then reported an unsettled
cleanup await after its stop process exited; the cleanup fixture was corrected and the
passed generation evidence retained. Immutable package qualification uses that correction.

The frozen upstream CI passed at
[upstream run 36770606867](https://github.com/getpaseo/paseo/actions/runs/36770606867).
That is upstream baseline evidence. Fork Actions exposed no registered workflow and
workflow enable/dispatch returned 404. Raphael explicitly authorized publication
“after focused checks without full CI.” Record this exception; do not claim fork
full-suite coverage.

## Publication and deployment gates

Source publication uses the captured remote lease after the patch mapping, prefix,
merge and range-diff review. The user waived full CI for this publication only.
The immutable host-matching Nix package must preserve Services, the worker heap scope
and node-pty overrides, recalculate the new lockfile dependency hash, and pass the exact
old-to-new format-4 package qualification before claiming production compatibility.
The existing source pin and live service stay unchanged by this source rebase.

A later authorized deployment must run outside `paseo.service`, validate the exact
prepared generation with the replacement CLI, and use the checkpointed wrapper.
Verify restored generation, continuation and browser reconnect before reporting
activation success. Keep old packages, checkpoints and logs. Never use vanilla upstream
as an intermediate package or force replacement after preparation failure.
