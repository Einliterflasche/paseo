# Fork rebase plan

This is the preparation audit for the 2026-09-30 upstream update. It records deployed
behavior, overlapping implementations, and the checks that a rebase must pass.
The audit does not establish that rebased code works. No rebased package is deployed.

The preservation requirements remain in [fork requirements](fork-requirements.md).
Use [fork maintenance](fork-maintenance.md) for branch publication and deployment.

## Source baseline and target

| Reference              | Revision                                   | Role                                      |
| ---------------------- | ------------------------------------------ | ----------------------------------------- |
| Deployed fork          | `3ceb1c966a0ebf42e6cccd401eaf97ae832543da` | Immutable source pin; 39 custom commits   |
| Existing upstream base | `b8e24677e12b226c7c38c1c3a40649daa9f1152f` | v0.8.0                                    |
| Stable candidate       | `919c737c1948c5a16220307403a82e90d3e27ea0` | v0.10.2; 197 commits absent from the fork |
| Main candidate         | `318a84a5703b41a05792495c348eb9510e4efab6` | 240 commits absent from the fork          |

Prepare against the frozen main candidate. This is the proposed target because it
includes automatic Codex speed discovery and the newer provider and usage interfaces.
Stable still needs the difficult history, recovery, authentication, and OpenCode v2
integration. It does not include automatic Codex speed discovery.

Compare release trees and behavior. Stable releases use cherry-picks, so ancestry
alone can incorrectly classify an upstream feature as missing.

## Deployed behavior

The installed Nix package and served web asset match the deployed fork above.
The daemon reports `running`, checkpoint format 4, and the restored generation
from the latest deployment. The source working copy is clean and matches `origin/fork`
at the start of this audit.

| Capability                                                         | Current deployment   | Evidence and limit                                                                                                                                         |
| ------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled restart and automatic continuation                      | Deployed and enabled | The latest deployment restored the same native session and the browser reconnected. Accepted inputs and existing history remain preservation gates.        |
| Graceful shutdown checkpoints                                      | Deployed             | The deployed source includes `39a68cd53`. The earlier shutdown preparation report predates activation. This audit did not stop the live daemon.            |
| Managed service restoration                                        | Deployed, format 4   | Services are relaunched with stable workspace/script identity. Their PIDs do not survive replacement. Ordinary terminals still block activation.           |
| Services catalog and authenticated previews                        | Deployed and enabled | A fresh browser displays the catalog, registration control, and 11 managed definitions. All are stopped during this audit; no active preview is exercised. |
| Service controls, logs, thumbnails, prefix mounts and Fast Refresh | Deployed             | Source and retained earlier validation cover these paths. Live running-service behavior is not retested during this read-only audit.                       |
| Shared dictation across text fields                                | Deployed and enabled | Live voice readiness advertises dictation. Audio recognition and native microphone permission are separate from readiness.                                 |
| File previews and downloads                                        | Deployed             | Session-scoped grants, media byte ranges, and preview UI are installed. No private document is opened during the audit.                                    |
| Catppuccin default                                                 | Deployed             | A fresh browser saves `syntaxTheme: catppuccin`. Existing explicit preferences remain authoritative.                                                       |
| Shared timeline text and recovery memory fixes                     | Deployed             | The installed source contains the shared backing and checkpoint implementation. A short status audit cannot establish a long-run memory bound.             |
| Opus 5.5 and GPT-6.1 Sol Fast                                      | Deployed             | Catalog entries, earlier real provider requests, and the current Fast control establish availability.                                                      |
| Restart inspection prototype                                       | Not deployed         | Five unfinished files in the separate inspection working copy have no production integration.                                                              |

Claude Code 2.1.280, Codex 0.159.2, and Pi 0.84.4 are ready on this VM.
Copilot, OpenCode, and Oh My Pi are disabled and unavailable in the live provider
snapshot. Rebase support for another provider does not install its executable.

The fork lacks upstream pane Find for chat, files, and terminals, plus source Find
and Replace. It also lacks npm plugin installation and updates, and automatic
pull-request tabs.
It also lacks OpenCode v2, Pi extension adapters, Sonnet 5.5, expanded Claude launch
configuration, relay password improvements, and reorganized Settings.
Existing History search, basic plugins, legacy OpenCode/Pi support, local password
login, and provider usage remain available. The missing entries are their newer
implementations, not the absence of those whole areas.

Both upstream target trees include Sonnet 5.5. Its minimum Claude Code version is
2.1.284, so rebasing the catalog alone does not expose it on the installed 2.1.280.
Main additionally includes account-following usage, sidebar plugin contributions,
chat width controls, first-class plugin providers, Muse, Antigravity, and automatic
Codex speeds. None of those newer implementations is deployed in this fork.

## Conflict measurements

Three-way tree probes compare the net fork changes with each target, using the
existing upstream base. They do not modify a working copy or move branch references.

| Target      | Changed files on both sides | Files with textual conflicts |
| ----------- | --------------------------- | ---------------------------- |
| v0.10.2     | 139                         | 61                           |
| Frozen main | 149                         | 72                           |

These are combined tree comparisons, not per-commit rebase conflict counts.
Automatically merged files still need behavioral review. New providers and mutation
entry points can bypass recovery ownership without producing a textual conflict.

## Overlapping implementations

### Timeline history and memory

Upstream `cdc669fde` stores projected display rows, merged text, latest tool state,
and source sequence ranges. Our `8b30d827b` and `5942258a5` retain canonical events
through shared text backings and export exact restart snapshots.

Upstream removes the fork's snapshot APIs. Projected rows can have non-monotonic
ending sequence numbers after interleaved tool updates. Our current snapshot schema
requires increasing canonical row sequences. Copying projected rows into that schema
will not preserve its contract.

Resolve this representation before ordinary conflict editing. The preferred first
integration retains canonical checkpoint data and shared text in one timeline owner,
then adapts upstream projection and query interfaces around that owner. This is a
design proposal, not a proven implementation. Measure memory with both behaviors.

If projection becomes the stored representation, define an explicit format-4 reader
and a compatible new writer. Do not change the meaning of format 4 in place.
Qualify the exact rollback package against the chosen writer before deployment.
Keep displayed history, message identities, epochs, sequence coverage, unopened agents,
and child histories through conversion. Do not drop either whole memory patch.

Upstream `897a0abb1` replaces rehydrated history atomically. Preserve that correction,
but prevent native replay from overwriting checkpoint-installed history. Integrate
`b21c004ff` and `9696f4226` subscription ownership with the fork's recovery banner,
directory refresh, and pending client sends.

### Restart and provider execution

Neither upstream target supplies our checkpointed restart or deployment contract.
Keep the admission freeze, accepted-input ledger, certified teardown, schedule and
notification continuation, graceful shutdown checkpoint, and exact-generation handoff.
Upstream lifecycle, PID publication, and logging fixes complement these guarantees.

OpenCode v2 selects a new implementation, bypassing the modified legacy adapter.
Its close path releases a session lease while a shared helper can remain running.
Port restart ownership and teardown certification to that path. Review Pi extension
activity and main's plugin-provider sessions for the same issue. A failed close must
retain enough execution ownership for an explicit retry.

Upstream `8cd989529` deduplicates completion watches by child/caller pair. Our watches
also retain logical run identity, pending notification IDs, and checkpoint receipts.
Add the deduplication rule to the existing owner. Do not replace the persisted registry
with an uncheckpointed watch map.

### Claude and Codex models

Both targets already contain Opus 5.5. Use their model definitions and normalization
fixes, then preserve the deployed defaults in a small explicit fork patch. Upstream
selects Opus 5.5 by default with medium effort; the fork retains Opus 5 and high effort.
Existing explicit model and effort choices must remain unchanged.

Keep `3ceb1c966` if the final target is stable. Stable's static Fast list still omits
GPT-6.1 Sol. On main, retire the static list addition after migration tests pass.
Upstream `60aff2346` discovers native service tiers and replaces Fast with a Speed
selector. The current account advertises Fast with request ID `priority`.

Preserve saved Fast-on and Fast-off choices across model changes and checkpoints.
Normal must explicitly override a previous faster tier. New agents and scheduled jobs
remain Normal unless Raphael requests Fast. Advertise Ultrafast only when the native
account catalog offers it.

### Passwords and preview authority

Upstream `e1c769c01` moves saved passwords to host profiles and adds hello authentication,
local credentials, and relay pairing. It does not replace our serving-daemon discovery
and password screen. Keep discovery from the actual browser origin, including HTTPS
and nondefault ports. Adapt that flow to upstream credential migration and errors.

The authenticated Services catalog has no upstream equivalent. Upstream's existing
public service proxy cannot replace control-session-bound preview grants. Preserve
the private control listener, gateway, source admission, revocation, and prefix mounts.
Merge Services tab and sidebar registration with upstream browser, pull-request tab,
and plugin contributions.

### Dictation and file access

Shared dictation and session-scoped PDF/media previews have no upstream equivalents.
Keep their owners while adopting upstream composer, form, shortcut, and editor changes.
Source Find and Replace complements file previews. Preserve both workflows and grant
invalidation after reconnect.

The read-only speech audit identifies English-only local Parakeet v2 as the German
recognition constraint. Deployed code already accepts multilingual Parakeet v3.
That change needs separate model files and speech configuration; a rebase alone does
not enable German. Preserve shared dictation and keep untested speech model changes
outside the rebase. The detailed language audit is retained in `voice/report.md`.

## Preserve older working copies

The Services MVP working copy has 175 changed files: 122 deployed matches, 32 earlier
committed versions, and 21 distinct combinations. Those combinations remove later
recovery and preview integration. They add no missing deployed capability. Retain
the working copy as provenance; do not apply its directory over the fork.

The five-file continuity-inspection prototype is separate unfinished work. Preserve
its diff and files before branch operations. Reassess useful race tests after the
rebase. It is not a replacement for the current restart coordinator.

The clean Services release working copy adds no unique code. The detached memory
baseline's untracked reproducer exactly matches the deployed tracked script.
Dependencies and build output in diagnostic baselines are not additional features.
Do not delete any working copy or retained evidence as part of preparation.

## Patch decisions and order

Keep the original series as the integration reference. Resolve each patch in its
dependency order. Rename the 17 subjects that lack `fork patch: ` during the history
rewrite. Fold a fixup only into the patch that owns the same behavior, with a reviewed
range-diff. Do not squash unrelated customizations.

| Patch group                                            | Main-target decision               | Preservation boundary                                                                  |
| ------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| Restart foundation `1b76b4d10`                         | Adapt and retain                   | Accepted inputs, history, lifecycle, scheduler, and deployment ownership               |
| Theme `362b91f7e`                                      | Retain                             | Defaults and explicit preference migration                                             |
| Login `a7ced8cfe`                                      | Adapt and retain                   | Actual serving origin and authenticated onboarding                                     |
| Dictation `53294dde2`, `88b0c97e1`                     | Retain and adapt integration       | One microphone owner and focused insertion                                             |
| File access `3f87b03ca`, `ae040716b`                   | Retain                             | Session grants, previews, downloads, and byte ranges                                   |
| Heap/history/ownership `65f76230e` through `dda390826` | Adapt and retain                   | Worker-only heap allowance, exact snapshot state, and certified close                  |
| Services foundation and follow-ups                     | Retain and adapt integration       | Authenticated previews, tab lifetime, controls, health, and prefix development servers |
| Foreign-owned teardown `77cea0984`                     | Retain                             | Do not signal foreign processes; certify owned descendants                             |
| Service checkpoint `5de538ac3`, `bbd4e2ae3`            | Retain together                    | Format-4 restoration and accurate format advertisement                                 |
| Shutdown `39a68cd53`                                   | Adapt and retain                   | Checkpoint before graceful stop and matching supervisor/Nix timing                     |
| Opus catalog `33b2d1fb3`                               | Replace duplicate definition       | Keep explicit default behavior and model tests                                         |
| Codex Fast `3ceb1c966`                                 | Replace static implementation      | Preserve preferences through native speed discovery                                    |
| Publishing policy `e5ea44be8`                          | Retain in its owning documentation | Fork-only publication and archival history                                             |

## Integration and qualification

1. Preserve the deployed revision, patch inventory, live source pin, and dirty working-copy diffs.
2. Create an archival fork reference and a separate preparation worktree on the frozen target.
3. Define timeline/checkpoint conversion and its preservation assertions before replaying the lifecycle patches.
4. Rebase the series in order, reviewing new provider and mutation paths for recovery ownership.
5. Replace proven duplicate model implementations, preserving defaults and saved speed choices.
6. Integrate authentication, Services, file access, dictation, and upstream interface changes around their existing owners.
7. Rebuild workspace declarations before diagnosing cross-package types.
8. Run focused affected tests, typecheck, lint, formatting, and CI coverage before publishing rewritten history.
9. Review the range-diff, surviving patch subjects, and absence of merge commits before advancing `upstream-base`.
10. Publish with `--force-with-lease` after checking for unexpected remote changes.
11. Build an immutable Nix package and qualify isolated old-to-new recovery before changing the live pin.
12. Deploy through the detached checkpointed wrapper and retain the exact restored-generation evidence.

Focused recovery validation is owned by
[restart recovery](restart-recovery-plan.md#validation-and-rollout). Add coverage for
format-4 conversion, projected history cursors, shared OpenCode v2 helpers, plugin
provider close, completion-watch deduplication, and saved Codex speeds.

Use real isolated replacements with accepted queued and steered inputs, stopped work,
child notifications, scheduled runs, and managed services. Require the same native
sessions, original logical user identities, displayed history, and service identities.
Preparation failure must leave activation unexecuted.

Use focused Chromium and Firefox checks for the served login, Services, preview
revocation, pane moves, standalone tabs, prefix mounts, workers, and Fast Refresh.
Exercise dictation insertion and file Find with previews. Record native device gaps
separately. Run broader suites in CI, not on this VM.

Keep the worker-only 6144 MiB allowance and node-pty packaging overrides. Recalculate
the Nix npm dependency hash from the new lockfile. Build before activation. Never
deploy vanilla upstream as an intermediate package: it lacks `daemon checkpoint-check`
and the live recovery contract. A format-3 package cannot restore the current format-4
checkpoint. A new writer can further restrict rollback; test the exact package pair.

## Audit evidence

Raw read-only reports are retained under `/home/agent/paseo-rebase-audits/20260930/`.
`deployment/` contains the live catalog, bundle comparison, and browser observations.
`patches/` contains all 39 commit inventories and the uncommitted classifications.
`overlap/findings.json` records exact upstream commits, paths, and acceptance criteria.
`conflict-probes.json` and the target-specific path files retain both tree probes.
`voice/report.md` records the read-only English/German speech investigation and its
proposed configuration, with redacted evidence and vendor references.

Earlier activation and service recovery evidence remains in
`/home/agent/paseo-deployments/20260919-services/`,
`/home/agent/paseo-deployments/20260920-service-recovery/`, and the latest model/Fast
deployment directories. The current audit performs no restart, service lifecycle
mutation, model prompt, or speech configuration change.
