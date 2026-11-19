import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { dispatches, spawnCheckpointDaemon } from "./test-utils/checkpoint-daemon.js";

/**
 * Companion to controlled-restart.e2e.test.ts, which proves receipt/timeline recovery
 * across two independently-connecting clients. This file proves the client-side half of
 * the contract: a single, already-connected DaemonClient survives the real process
 * replacement on its own (auto-reconnect) and resumes a send that was frozen by the
 * admission gate, without duplicating the provider dispatch or losing the pending promise.
 */

function settle(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  promise.then(markSettled, markSettled);
  return { settled: () => settled };
}

test("a single DaemonClient auto-reconnects across a real process replacement and resumes a frozen send exactly once", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-controlled-reconnect-"));
  // The old process holds its saved checkpoint, frozen, until the test releases it.
  const first = await spawnCheckpointDaemon(home, { env: { PASEO_TEST_HOLD_EXIT: "1" } });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${first.port}/ws`,
    reconnect: { enabled: true, baseDelayMs: 25, maxDelayMs: 100 },
  });
  onTestFinished(() => client.close());
  await client.connect();
  await client.observeEvents(["status.server_info"]).ready;

  const agent = await client.createAgent({ provider: "codex", cwd: home, modeId: "full-access" });
  // "finish" settles the turn immediately so the checkpoint has no active input to
  // replay on restore — keeping the dispatch count in this test limited to the two
  // sends we make, independent of the restart-recovery continuation behavior that
  // controlled-restart.e2e.test.ts already covers.
  await client.sendAgentMessage(agent.id, "finish", { messageId: "baseline-1" });
  expect(await dispatches(home)).toHaveLength(1);

  const checkpoint = await client.restartServer();
  expect(checkpoint.generationId).not.toBeUndefined();
  await expect.poll(() => client.getLastServerInfoMessage()?.restartRecoveryState).toBe("paused");

  // Admissions are frozen on the old process: this call must be rejected as
  // retryable (restart_in_progress) internally and retried by the client itself.
  // From the caller's perspective the promise just stays pending — never
  // rejected, never resolved early — while the daemon reports paused/restoring.
  const pending = client.sendAgentMessage(agent.id, "reconnect test", {
    messageId: "reconnect-1",
  });
  const pendingState = settle(pending);

  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(pendingState.settled()).toBe(false);
  // Frozen: no second provider dispatch happened yet.
  expect(await dispatches(home)).toHaveLength(1);

  first.child.send("release");
  expect(await first.exited).toBe(0);

  await spawnCheckpointDaemon(home, { port: first.port });

  // No manual reconnect call: the same client instance notices the transport
  // loss, reconnects to the replacement process on the same port on its own
  // (existing connection policy), sees restartRecoveryState clear, and resends
  // the frozen message with its original client message ID.
  await pending;
  expect(pendingState.settled()).toBe(true);
  expect(client.getConnectionState().status).toBe("connected");

  const calls = await dispatches(home);
  expect(calls).toHaveLength(2);
  expect(calls.filter((call) => call.messageId === "reconnect-1")).toHaveLength(1);
  expect(calls[1]?.messageId).toBe("reconnect-1");
});
