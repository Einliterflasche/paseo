import { mkdtemp, readFile, mkdir, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { projectTimelineRows } from "../agent/timeline-projection.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import {
  dispatches,
  harnessLog,
  launchCheckpointDaemon,
  readyGeneration,
  restartCheckpointDaemon,
} from "./test-utils/checkpoint-daemon.js";

const RESTART_STEP_FAILED = "Restart step failed; continuing without it";

async function failedRestartSteps(home: string): Promise<unknown[]> {
  return (await harnessLog(home))
    .filter((line) => line.msg === RESTART_STEP_FAILED)
    .map((line) => line.step);
}

test("two real process replacements preserve the prefix and never duplicate or resurrect requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-controlled-process-"));
  const old = await launchCheckpointDaemon(home);
  const active = await old.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  const stopped = await old.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await old.client.sendAgentMessage(active.id, "same text", { messageId: "active-1" });
  await old.client.sendAgentMessage(stopped.id, "same text", { messageId: "stopped-1" });
  await old.client.cancelAgent(stopped.id);
  const nativeSessionId = (await dispatches(home))[0]!.sessionId;
  const checkpoint = await restartCheckpointDaemon(old);
  expect(checkpoint).toMatchObject({ generationId: expect.any(String), exitCode: 0 });
  const saved = JSON.parse(
    await readFile(
      join(home, "restart-checkpoints", checkpoint.generationId!, "snapshot.json"),
      "utf8",
    ),
  );
  const prefix = saved.agents.timelines[active.id];
  expect(prefix.rows.map((row: { item: { text?: string } }) => row.item.text)).toContain(
    "late-close-output",
  );

  const next = await launchCheckpointDaemon(home, { port: old.port });
  expect(next.client.getLastServerInfoMessage()?.restartRecoveryGeneration).toBe(
    checkpoint.generationId,
  );
  await next.client.waitForFinish(active.id, 5000);
  // Retrying an acknowledged ID must return its old receipt without provider dispatch.
  await next.client.sendAgentMessage(active.id, "same text", { messageId: "active-1" });
  const calls = await dispatches(home);
  expect(calls).toHaveLength(3);
  expect(calls.filter((call) => call.resumed)).toHaveLength(1);
  expect(calls[2]!.sessionId).toBe(nativeSessionId);
  expect(calls.filter((call) => call.messageId === "stopped-1")).toHaveLength(1);
  const second = await restartCheckpointDaemon(next);

  const third = await launchCheckpointDaemon(home, { port: old.port });
  expect(third.client.getLastServerInfoMessage()?.restartRecoveryGeneration).toBe(
    second.generationId,
  );
  const timeline = await third.client.fetchAgentTimeline(active.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(timeline.epoch).toBe(prefix.epoch);
  const projectedPrefix = projectTimelineRows({
    rows: prefix.rows as AgentTimelineRow[],
    mode: "projected",
  });
  expect(
    timeline.entries.slice(0, projectedPrefix.length).map((row) => ({
      seqStart: row.seqStart,
      seqEnd: row.seqEnd,
      item: row.item,
      sourceSeqRanges: row.sourceSeqRanges,
      timestamp: row.timestamp,
      turnId: row.turnId,
    })),
  ).toEqual(
    projectedPrefix.map((row) => ({
      seqStart: row.seqStart,
      seqEnd: row.seqEnd,
      item: row.item,
      sourceSeqRanges: row.sourceSeqRanges,
      timestamp: row.timestamp,
      turnId: row.turnId,
    })),
  );
  const thirdCheckpoint = await restartCheckpointDaemon(third);
  const thirdSaved = JSON.parse(
    await readFile(
      join(home, "restart-checkpoints", thirdCheckpoint.generationId!, "snapshot.json"),
      "utf8",
    ),
  );
  expect(thirdSaved.agents.timelines[active.id].rows.slice(0, prefix.rows.length)).toEqual(
    prefix.rows,
  );
  expect(timeline.entries.filter((row) => row.item.type === "user_message")).toHaveLength(2);
  expect(
    timeline.entries.find(
      (row) => row.item.type === "user_message" && row.item.sender?.kind === "system",
    )?.item,
  ).toMatchObject({
    sender: { kind: "system", source: "Restart recovery" },
    text: expect.stringContaining("<paseo-system>"),
  });
  expect(await dispatches(home)).toEqual(calls);
}, 30_000);

/** Restoration installs an idle agent's history without resuming its native session. */
async function restartWithIdleAgent(behavior?: string) {
  const home = await mkdtemp(join(tmpdir(), "paseo-restored-idle-"));
  const old = await launchCheckpointDaemon(home, { behavior });
  const agent = await old.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await old.client.sendAgentMessage(agent.id, "finish", { messageId: "idle-1" });
  await old.client.waitForFinish(agent.id, 5000);
  const before = await old.client.fetchAgentTimeline(agent.id, { limit: 0 });
  expect(before.agent?.features).toHaveLength(1);
  expect(before.agent?.availableModes).not.toHaveLength(0);
  const checkpoint = await restartCheckpointDaemon(old);

  const next = await launchCheckpointDaemon(home, { port: old.port, behavior });
  expect(next.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
    restartRecoveryGeneration: checkpoint.generationId,
  });
  return { home, agentId: agent.id, before, next };
}

test("opening an idle restored agent exposes its live controls over the saved history", async () => {
  const { home, agentId, before, next } = await restartWithIdleAgent();
  const opened = await next.client.fetchAgentTimeline(agentId, { limit: 0 });
  expect({
    features: opened.agent?.features,
    availableModes: opened.agent?.availableModes,
    currentModeId: opened.agent?.currentModeId,
  }).toEqual({
    features: before.agent?.features,
    availableModes: before.agent?.availableModes,
    currentModeId: "full-access",
  });
  expect(opened.epoch).toBe(before.epoch);
  expect(opened.entries).toEqual(before.entries);
  expect(await dispatches(home)).toEqual([
    expect.objectContaining({ text: "finish", resumed: false, messageId: "idle-1" }),
  ]);
}, 30_000);

test("an idle restored agent whose native session cannot resume keeps its saved history readable", async () => {
  const { agentId, before, next } = await restartWithIdleAgent("fail-resume");
  const opened = await next.client.fetchAgentTimeline(agentId, { limit: 0 });
  expect(opened.epoch).toBe(before.epoch);
  expect(opened.entries).toEqual(before.entries);
  expect(opened.agent).toMatchObject({ id: agentId, availableModes: [] });
}, 30_000);

test("opening an idle restored agent without a native session handle never replaces its saved history", async () => {
  const { home, agentId, before, next } = await restartWithIdleAgent("without-session-handle");
  expect(before.agent?.persistence ?? null).toBeNull();
  const opened = await next.client.fetchAgentTimeline(agentId, { limit: 0 });
  expect(opened.epoch).toBe(before.epoch);
  expect(opened.entries).toEqual(before.entries);
  expect(opened.agent).toMatchObject({ id: agentId, availableModes: [] });
  expect(await dispatches(home)).toEqual([
    expect.objectContaining({ text: "finish", resumed: false, messageId: "idle-1" }),
  ]);
}, 30_000);

test("a failed checkpoint save still replaces the daemon, and the next boot runs with durable history", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-controlled-failure-"));
  const current = await launchCheckpointDaemon(home);
  const agent = await current.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await current.client.sendAgentMessage(agent.id, "preserve me", { messageId: "original" });
  await mkdir(join(home, "restart-checkpoints", "ready.json"), { recursive: true });
  const startedAt = Date.now();
  const restart = await restartCheckpointDaemon(current);
  expect(Date.now() - startedAt).toBeLessThan(15_000);
  expect(restart).toEqual({ generationId: undefined, exitCode: 0 });
  expect(await failedRestartSteps(home)).toContain("checkpoint");

  const next = await launchCheckpointDaemon(home, { port: current.port });
  const info = next.client.getLastServerInfoMessage();
  expect(info?.restartRecoveryState).toBe("running");
  expect(info?.restartRecoveryGeneration).toBeUndefined();
  // Without a checkpoint the agent comes back from its stored record, stopped.
  const recovered = await next.client.fetchAgent(agent.id);
  expect(recovered?.agent).toMatchObject({ id: agent.id, title: "preserve me" });
  expect(recovered?.agent.status).not.toBe("running");
  expect(await dispatches(home)).toHaveLength(1);
  // The stored receipt still answers a retry of the accepted message without a new dispatch.
  await next.client.sendAgentMessage(agent.id, "preserve me", { messageId: "original" });
  expect(await dispatches(home)).toHaveLength(1);
  const fresh = await next.client.createAgent({ provider: "codex", cwd: home });
  await next.client.sendAgentMessage(fresh.id, "finish", { messageId: "after-failure" });
  await next.client.waitForFinish(fresh.id, 5000);
  expect((await dispatches(home)).map((call) => call.messageId)).toEqual([
    "original",
    "after-failure",
  ]);
}, 30_000);

test("a failed restored marker is logged, the boot still ends running, and nothing retries", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-marker-failure-"));
  const old = await launchCheckpointDaemon(home, { env: { PASEO_TEST_HOLD_EXIT: "1" } });
  const agent = await old.client.createAgent({
    provider: "codex",
    cwd: home,
    modeId: "full-access",
  });
  await old.client.sendAgentMessage(agent.id, "keep this input", { messageId: "marker-input" });
  const { generationId } = await old.client.restartServer();
  expect(generationId).toBeTruthy();
  // Actual filesystem failure after resume, without replacing a persistence function.
  await mkdir(join(home, "restart-checkpoints", generationId!, "restored.json"));
  old.child.send("release");
  expect(await old.exited).toBe(0);
  await old.client.close();

  const next = await launchCheckpointDaemon(home, {
    port: old.port,
    behavior: "keep-resumed-active",
  });
  expect(next.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
    restartRecoveryGeneration: generationId,
  });
  expect(await failedRestartSteps(home)).toEqual(["mark-restored"]);
  const history = await next.client.fetchAgentTimeline(agent.id, {
    projection: "canonical",
    limit: 0,
  });
  expect(history.error).toBe(null);
  expect(
    history.entries.filter(
      (entry) =>
        entry.item.type === "user_message" && entry.item.clientMessageId === "marker-input",
    ),
  ).toHaveLength(1);
  expect((await dispatches(home)).filter((call) => call.resumed)).toHaveLength(1);
  await expect(next.client.createAgent({ provider: "codex", cwd: home })).resolves.toHaveProperty(
    "id",
  );
  await next.client.cancelAgent(agent.id);
}, 30_000);

test("a ready generation that one boot could not load is never restored by a later boot", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-fenced-generation-"));
  const old = await launchCheckpointDaemon(home);
  const agent = await old.client.createAgent({ provider: "codex", cwd: home });
  await old.client.sendAgentMessage(agent.id, "unfinished work", { messageId: "fenced-input" });
  const { generationId } = await restartCheckpointDaemon(old);
  const generationDir = join(home, "restart-checkpoints", generationId!);
  const snapshot = join(generationDir, "snapshot.json");
  await rename(snapshot, `${snapshot}.hidden`);

  const skipped = await launchCheckpointDaemon(home, { port: old.port });
  expect(skipped.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
  });
  expect(skipped.client.getLastServerInfoMessage()?.restartRecoveryGeneration).toBeUndefined();
  expect(await failedRestartSteps(home)).toEqual(["load"]);
  expect(await readdir(generationDir)).toContain("claimed.json");
  // A crash keeps ready.json pointing at the skipped generation for the next boot.
  skipped.child.kill("SIGKILL");
  await skipped.exited;
  await skipped.client.close();
  await rename(`${snapshot}.hidden`, snapshot);
  expect(await readyGeneration(home)).toBe(generationId);

  const later = await launchCheckpointDaemon(home, { port: old.port });
  expect(later.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
  });
  expect(later.client.getLastServerInfoMessage()?.restartRecoveryGeneration).toBeUndefined();
  expect(await dispatches(home)).toEqual([
    expect.objectContaining({ messageId: "fenced-input", resumed: false }),
  ]);
  expect((await later.client.fetchAgent(agent.id))?.agent.status).not.toBe("running");
  expect(await failedRestartSteps(home)).toEqual(["load", "load"]);
}, 30_000);

test("one agent that cannot resume does not stop the other agent from continuing", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-partial-resume-"));
  const old = await launchCheckpointDaemon(home);
  const healthy = await old.client.createAgent({ provider: "codex", cwd: home });
  const broken = await old.client.createAgent({ provider: "codex", cwd: home });
  await old.client.sendAgentMessage(healthy.id, "healthy work", { messageId: "healthy-1" });
  await old.client.sendAgentMessage(broken.id, "broken work", { messageId: "broken-1" });
  const calls = await dispatches(home);
  const healthySession = calls.find((call) => call.messageId === "healthy-1")!.sessionId;
  const brokenSession = calls.find((call) => call.messageId === "broken-1")!.sessionId;
  const { generationId } = await restartCheckpointDaemon(old);

  const next = await launchCheckpointDaemon(home, {
    port: old.port,
    env: { PASEO_TEST_FAIL_RESUME_SESSIONS: brokenSession },
  });
  expect(next.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
    restartRecoveryGeneration: generationId,
  });
  await next.client.waitForFinish(healthy.id, 5000);
  const resumed = (await dispatches(home)).filter((call) => call.resumed);
  expect(resumed.map((call) => call.sessionId)).toEqual([healthySession]);
  const failed = await next.client.fetchAgentTimeline(broken.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(failed.agent?.status).not.toBe("running");
  expect(failed.entries.at(-1)?.item).toEqual({
    type: "error",
    message: "Paseo could not resume this task after the restart. Send a message to continue it.",
  });
}, 30_000);

test("a provider session that never stops does not block a restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-hanging-provider-"));
  const old = await launchCheckpointDaemon(home, {
    behavior: "hang-close",
    env: {
      PASEO_TEST_RESTART_PREPARE_TIMEOUT_MS: "4000",
      PASEO_TEST_SHUTDOWN_STOP_TIMEOUT_MS: "2000",
    },
  });
  const agent = await old.client.createAgent({ provider: "codex", cwd: home });
  await old.client.sendAgentMessage(agent.id, "never stops", { messageId: "hanging-1" });
  const startedAt = Date.now();
  const restart = await restartCheckpointDaemon(old);
  expect(Date.now() - startedAt).toBeLessThan(12_000);
  expect(restart).toEqual({ generationId: expect.any(String), exitCode: 0 });
  expect(await failedRestartSteps(home)).toContain("stop");

  const next = await launchCheckpointDaemon(home, { port: old.port });
  expect(next.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
    restartRecoveryGeneration: restart.generationId,
  });
  expect((await dispatches(home)).filter((call) => call.resumed)).toHaveLength(1);
  await expect(next.client.createAgent({ provider: "codex", cwd: home })).resolves.toHaveProperty(
    "id",
  );
}, 30_000);

test("server_info drops the blocked-recovery surface and removed restart operations leave the daemon alone", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-removed-restart-operations-"));
  const daemon = await launchCheckpointDaemon(home);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
  onTestFinished(() => socket.terminate());
  const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
  socket.on("message", (data: RawData, binary) => {
    if (binary) return;
    const parsed = JSON.parse(data.toString());
    if (parsed.type === "session") received.push(parsed.message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      clientId: "removed-restart-operations",
      clientType: "browser",
      protocolVersion: 1,
    }),
  );
  await expect
    .poll(() => received.some((message) => message.payload?.status === "server_info"))
    .toBe(true);
  const serverInfo = received.find((message) => message.payload?.status === "server_info")!;
  expect(serverInfo.payload).toMatchObject({
    restartRecoveryState: "running",
    features: { restartRecovery: true },
  });
  for (const removed of [
    "restartAnywayId",
    "restartRecoveryError",
    "restartRecoveryPreviousGeneration",
    "restartRecoveryAffectedAgents",
  ]) {
    expect(serverInfo.payload).not.toHaveProperty(removed);
  }
  for (const removed of ["restartAnyway", "restartRecoveryRetry", "restartCrashAcknowledgment"]) {
    expect(serverInfo.payload.features).not.toHaveProperty(removed);
  }

  const requests = [
    { type: "restart_server_request", requestId: "prepare-only", prepareOnly: true },
    { type: "restart_server_request", requestId: "retry-recovery", retryRecovery: true },
    {
      type: "restart_server_request",
      requestId: "acknowledge-crash",
      acknowledgeCrash: { generationId: "any", orphanExecutionReconciled: true },
    },
    {
      type: "daemon.restart_anyway.request",
      requestId: "restart-anyway",
      expectedError: "any",
      expectedGenerationId: null,
    },
  ];
  for (const message of requests) socket.send(JSON.stringify({ type: "session", message }));
  await expect
    .poll(() =>
      received
        .filter((message) => message.type === "rpc_error")
        .map((message) => [message.payload.requestId, message.payload.code]),
    )
    .toEqual(requests.map((request) => [request.requestId, "restart_operation_removed"]));

  expect(daemon.child.exitCode).toBeNull();
  expect(await readyGeneration(home)).toBeNull();
  const status = await daemon.client.getDaemonStatus();
  expect(status.pid).toBe(daemon.child.pid);
  expect(daemon.client.getLastServerInfoMessage()?.restartRecoveryState).toBe("running");
  const agent = await daemon.client.createAgent({ provider: "codex", cwd: home });
  await daemon.client.sendAgentMessage(agent.id, "finish", { messageId: "still-serving" });
  await daemon.client.waitForFinish(agent.id, 5000);
  expect(await dispatches(home)).toHaveLength(1);
}, 30_000);

test("fork context retains the upstream changed-checkpoint guard while canonical history preserves prior tool state", async () => {
  const ctx = await createDaemonTestContext();
  onTestFinished(() => ctx.cleanup());
  const agent = await ctx.client.createAgent({ provider: "codex", cwd: ctx.daemon.paseoHome });
  const manager = ctx.daemon.daemon.agentManager;
  const tool = {
    type: "tool_call" as const,
    callId: "interleaved",
    name: "Sub-agent",
    status: "running" as const,
    error: null,
    detail: { type: "sub_agent" as const, log: "BEFORE_BOUNDARY", description: "work" },
  };
  await manager.appendTimelineItem(agent.id, tool);
  const boundary = await manager.appendTimelineItem(agent.id, {
    type: "assistant_message",
    text: "Boundary message",
  });
  await manager.appendTimelineItem(agent.id, {
    ...tool,
    status: "completed",
    detail: { ...tool.detail, log: "AFTER_BOUNDARY_SECRET" },
  });
  const displayed = await ctx.client.fetchAgentTimeline(agent.id, { limit: 0 });
  expect(JSON.stringify(displayed.entries)).toContain("AFTER_BOUNDARY_SECRET");
  const canonical = await manager.getCanonicalTimelineRows(agent.id);
  expect(canonical.filter((row) => row.seq <= boundary.seq).map((row) => row.item)).toContainEqual(
    tool,
  );
  await expect(
    ctx.client.buildAgentForkContext(agent.id, {
      boundaryCursor: { epoch: boundary.epoch, seq: boundary.seq },
    }),
  ).rejects.toThrow("This checkpoint changed after it was created");
}, 30000);
