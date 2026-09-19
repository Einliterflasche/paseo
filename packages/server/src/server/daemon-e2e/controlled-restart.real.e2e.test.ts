import { mkdirSync, mkdtempSync } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import {
  createRealProviderClient,
  getRealProviderConfig,
  type RealProvider,
} from "./real-provider-test-config.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

/**
 * Validates controlled-restart checkpoint/resume against REAL native provider adapters
 * (Claude Code SDK, Codex app-server, Pi RPC) rather than the deterministic fixture in
 * controlled-restart.e2e.test.ts, which already covers the protocol/manager mechanics
 * with a fake provider across two real forked daemon processes.
 *
 * This test stays in-process (`createTestPaseoDaemon` stop + a fresh `createTestPaseoDaemon`
 * on the same `paseoHomeRoot`) rather than forking a second daemon process: it is checking
 * that each native adapter's close/interrupt/resume participates correctly in quiesce and
 * boot-time restore, not exercising the supervisor process-replacement path itself (already
 * covered by controlled-restart.e2e.test.ts).
 *
 * No env-gated skip: missing/broken auth for a provider makes this test FAIL for that
 * provider, not silently pass. Uses the operator's already-configured local CLI/API
 * credentials via real-provider-test-config.ts, the same source agent-reload's real e2e
 * test uses.
 */

const REAL_PROVIDERS = ["claude", "codex", "pi"] as const satisfies readonly RealProvider[];

const MARKER_TEXT = "PHASE_MARKER";
const WAIT_FOR_MARKER_TIMEOUT_MS = 90_000;
const WAIT_FOR_FINISH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for the marker file, but fails fast (with the provider's own error) if the turn
 * errors out instead of sitting through the full timeout waiting on a marker that a failed
 * turn will never write.
 */
async function waitForMarkerOrTurnFailure(
  manager: AgentManager,
  agentId: string,
  markerPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(markerPath)) return;
    const record = manager.getAgent(agentId);
    if (record?.lifecycle === "error") {
      throw new Error(
        `Agent ${agentId} turn failed before writing its marker: ${record.lastError}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${markerPath} to exist`);
}

function buildPhasePrompt(markerPath: string, releasePath: string): string {
  return [
    "Use your shell/bash tool to run one command that does all of the following, then wait for it to finish before replying:",
    `1. Write the exact text ${MARKER_TEXT} to the file "${markerPath}" (overwrite if it exists).`,
    `2. Poll once per second, for up to 150 seconds, until the file "${releasePath}" exists.`,
    `3. Once it exists, print its exact contents.`,
    "After the command completes, reply with exactly the command's final printed output and nothing else — no extra words, no markdown.",
  ].join("\n");
}

interface NativeCheckpointHarness {
  root: string;
  cwd: string;
  paseoHomeRoot: string;
  markerPath: string;
  releasePath: string;
  stoppedMarkerPath: string;
  stoppedReleasePath: string;
}

function setupHarness(provider: RealProvider): NativeCheckpointHarness {
  const root = mkdtempSync(path.join(tmpdir(), `paseo-controlled-restart-${provider}-`));
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const paseoHomeRoot = path.join(root, "home");
  mkdirSync(paseoHomeRoot, { recursive: true });
  return {
    root,
    cwd,
    paseoHomeRoot,
    markerPath: path.join(cwd, "phase-marker.txt"),
    releasePath: path.join(cwd, "release.txt"),
    stoppedMarkerPath: path.join(cwd, "stopped-phase-marker.txt"),
    stoppedReleasePath: path.join(cwd, "stopped-release.txt"),
  };
}

async function launchDaemon(
  provider: RealProvider,
  harness: NativeCheckpointHarness,
): Promise<TestPaseoDaemon> {
  // Keep native terminal evidence when a shutdown/resume assertion fails. Each
  // harness has its own retained directory; production logging is unchanged.
  const logger = pino(
    { level: "trace" },
    pino.destination(path.join(harness.root, "provider-trace.log")),
  );
  return createTestPaseoDaemon({
    agentClients: { [provider]: createRealProviderClient(provider, logger) },
    logger,
    pluginsEnabled: false,
    paseoHomeRoot: harness.paseoHomeRoot,
    cleanup: false,
  });
}

async function runControlledRestartCheck(provider: RealProvider): Promise<void> {
  const harness = setupHarness(provider);
  let first: TestPaseoDaemon | undefined;
  let firstClient: DaemonClient | undefined;
  let second: TestPaseoDaemon | undefined;
  let secondClient: DaemonClient | undefined;
  try {
    // --- Phase 1: start the original daemon, put a real turn mid-tool-call, and a
    //     second agent in an explicitly-stopped state that must never auto-resume. ---
    first = await launchDaemon(provider, harness);
    firstClient = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.7.2" });
    await firstClient.connect();

    const config = getRealProviderConfig(provider);
    const agent = await firstClient.createAgent({ ...config, cwd: harness.cwd });
    const stopped = await firstClient.createAgent({ ...config, cwd: harness.cwd });

    await firstClient.sendAgentMessage(
      agent.id,
      buildPhasePrompt(harness.markerPath, harness.releasePath),
      { messageId: "phase-1" },
    );
    // The "stopped" agent gets the SAME kind of genuinely-active mid-tool-call turn as
    // `agent`, with its own marker/release pair — cancellation must interrupt real active
    // work, not a turn that already finished on its own.
    await firstClient.sendAgentMessage(
      stopped.id,
      buildPhasePrompt(harness.stoppedMarkerPath, harness.stoppedReleasePath),
      { messageId: "stopped-1" },
    );

    const firstManager = first.daemon.agentManager;
    await waitForMarkerOrTurnFailure(
      firstManager,
      agent.id,
      harness.markerPath,
      WAIT_FOR_MARKER_TIMEOUT_MS,
    );
    expect((await readFile(harness.markerPath, "utf8")).trim()).toBe(MARKER_TEXT);
    await waitForMarkerOrTurnFailure(
      firstManager,
      stopped.id,
      harness.stoppedMarkerPath,
      WAIT_FOR_MARKER_TIMEOUT_MS,
    );
    expect((await readFile(harness.stoppedMarkerPath, "utf8")).trim()).toBe(MARKER_TEXT);

    // Cancel while the stopped agent's tool call is genuinely still in flight (it is
    // polling for a release file we deliberately never write) — an explicit stop of
    // real active work, not a race against a turn that had already completed.
    await firstClient.cancelAgent(stopped.id);
    // cancelAgent() resolves once the cancellation is accepted, not once the provider has
    // finished appending its own settled cancellation timeline rows (e.g. a rejected-tool
    // result). Wait for that to fully land before taking the "before" snapshot below, or
    // the post-restart comparison would flag legitimate pre-restart settling as drift.
    await firstClient.waitForFinish(stopped.id, WAIT_FOR_FINISH_TIMEOUT_MS);

    const nativeSessionId = firstManager.getAgent(agent.id)?.persistence?.sessionId;
    expect(nativeSessionId).toBeTruthy();
    const stoppedMarkerStatBefore = await stat(harness.stoppedMarkerPath);

    // --- Phase 2: checkpoint the daemon while the tool call is genuinely in flight,
    //     then replace the process (stop + fresh instance, same PASEO_HOME). ---
    // Quiesce-for-restart closes every still-open provider session, including an
    // already-cancelled-but-not-yet-closed one. That close can legitimately append its
    // own settling rows (e.g. a rejected-tool result), same as the deterministic fixture's
    // "late-close-output". Snapshot AFTER prepareRestart, not before, so this checkpoint
    // is the baseline compared against post-restart — matching how `prefix` below is taken.
    const checkpoint = await firstClient.prepareRestart("controlled-restart real e2e");
    expect(checkpoint.generationId).toBeTruthy();

    const stoppedTimelineBefore = await firstClient.fetchAgentTimeline(stopped.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });

    const prefix = await firstClient.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(prefix.entries.filter((row) => row.item.type === "user_message")).toHaveLength(1);

    await firstClient.close();
    await first.daemon.stop();

    second = await launchDaemon(provider, harness);
    secondClient = new DaemonClient({
      url: `ws://127.0.0.1:${second.port}/ws`,
      appVersion: "0.7.2",
    });
    await secondClient.connect();
    expect(secondClient.getLastServerInfoMessage()?.restartRecoveryGeneration).toBe(
      checkpoint.generationId,
    );

    // --- Phase 3: only now let the resumed tool call finish, and confirm it does so
    //     on the SAME native session/handle with no duplicated or resurrected input. ---
    await writeFile(harness.releasePath, `RELEASE_OK_${provider.toUpperCase()}`, "utf8");
    await secondClient.waitForFinish(agent.id, WAIT_FOR_FINISH_TIMEOUT_MS);

    const manager2 = second.daemon.agentManager;
    expect(manager2.getAgent(agent.id)?.persistence?.sessionId).toBe(nativeSessionId);

    const finalTimeline = await secondClient.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(finalTimeline.epoch).toBe(prefix.epoch);
    // The pre-restart prefix is preserved verbatim, not replaced by a fresh native hydration.
    expect(
      finalTimeline.entries
        .slice(0, prefix.entries.length)
        .map((row) => ({ seq: row.seqStart, item: row.item })),
    ).toEqual(prefix.entries.map((row) => ({ seq: row.seqStart, item: row.item })));
    expect(finalTimeline.entries.filter((row) => row.item.type === "user_message")).toHaveLength(1);
    const finalText = finalTimeline.entries
      .filter((row) => row.item.type === "assistant_message")
      .map((row) => (row.item as { text: string }).text)
      .join("");
    expect(finalText).toContain(`RELEASE_OK_${provider.toUpperCase()}`);

    // No duplicate: retrying the original client message ID must not produce a second turn.
    await secondClient.sendAgentMessage(
      agent.id,
      buildPhasePrompt(harness.markerPath, harness.releasePath),
      { messageId: "phase-1" },
    );
    const afterRetry = await secondClient.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(afterRetry.entries.filter((row) => row.item.type === "user_message")).toHaveLength(1);

    // Not-resume-stopped: the explicitly-cancelled agent's real mid-tool-call turn must
    // never auto-continue after restart. Give any wrongly-resumed work a beat to run,
    // then assert both the transcript AND the marker file (which a re-issued tool call
    // would rewrite) are byte-for-byte/mtime-for-mtime unchanged.
    await sleep(5_000);
    const stoppedTimelineAfter = await secondClient.fetchAgentTimeline(stopped.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(stoppedTimelineAfter.entries).toEqual(stoppedTimelineBefore.entries);
    const stoppedMarkerStatAfter = await stat(harness.stoppedMarkerPath);
    expect(stoppedMarkerStatAfter.mtimeMs).toBe(stoppedMarkerStatBefore.mtimeMs);
    expect(await fileExists(harness.stoppedReleasePath)).toBe(false);
  } finally {
    await firstClient?.close().catch(() => undefined);
    await secondClient?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    // `first` was already stopped explicitly; close() here only ends its process (both
    // daemons were created with cleanup:false, so neither call deletes any files).
    if (!second) await first?.close().catch(() => undefined);
    // Deliberately not removed: no auto-cleanup/deletion of test state, so a failure's
    // PASEO_HOME, provider transcripts, and marker/release files stay inspectable.
    process.stdout.write(`${provider}: retained test state at ${harness.root}\n`);
  }
}

test.each(REAL_PROVIDERS)(
  "%s: controlled restart interrupts an in-flight tool call and autoresumes the same native session",
  async (provider) => {
    await runControlledRestartCheck(provider);
  },
  300_000,
);
