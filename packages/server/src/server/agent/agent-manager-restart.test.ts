import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createCheckpointAgentClient } from "../test-utils/checkpoint-agent-client.js";
import { RestartInProgressError } from "../restart/restart-errors.js";
import type { AgentClient, AgentStreamEvent } from "./agent-sdk-types.js";

async function manager(home: string, client: AgentClient = createCheckpointAgentClient()) {
  const logger = createTestLogger();
  const registry = new AgentStorage(join(home, "agents"), logger);
  await registry.initialize();
  return new AgentManager({ clients: { codex: client }, registry, logger });
}

test("restart preserves late output and user identity without native overwrite or visible continuation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-manager-restart-"));
  const before = await manager(home);
  const agent = await before.createAgent(
    { provider: "codex", cwd: home },
    "54d45fd1-71f4-4c51-8206-7e90bbf6244a",
    { workspaceId: "workspace" },
  );
  const run = before.streamAgent(agent.id, "keep this request", { clientMessageId: "user-1" });
  await run.next();
  const saved = await before.quiesceForRestart();
  expect(saved.agents.map((entry) => [entry.record.id, entry.continue])).toEqual([
    [agent.id, true],
  ]);
  expect(saved.timelines[agent.id]!.rows.map((row) => row.item)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "user_message",
        text: "keep this request",
        clientMessageId: "user-1",
      }),
      expect.objectContaining({ type: "assistant_message", text: "late-close-output" }),
    ]),
  );
  expect(() =>
    before.streamAgent(agent.id, "must not enter", { clientMessageId: "rejected" }),
  ).toThrow(RestartInProgressError);
  await expect(before.closeAgent(agent.id)).rejects.toThrow(RestartInProgressError);
  await expect(before.archiveAgent(agent.id)).rejects.toThrow(RestartInProgressError);
  await expect(before.reloadAgentSession(agent.id)).rejects.toThrow(RestartInProgressError);
  await expect(before.deleteAgentState(agent.id)).rejects.toThrow(RestartInProgressError);
  expect((await before.quiesceForRestart()).timelines).toEqual(saved.timelines);
  const after = await manager(home);
  await after.installRestartCheckpoint(saved);
  await after.resumeRestartCheckpoint(saved);
  await after.flush();
  const again = await after.quiesceForRestart();
  const rows = again.timelines[agent.id]!.rows;
  expect(rows.slice(0, saved.timelines[agent.id]!.rows.length)).toEqual(
    saved.timelines[agent.id]!.rows,
  );
  expect(again.timelines[agent.id]!.epoch).toBe(saved.timelines[agent.id]!.epoch);
  expect(rows.filter((row) => row.item.type === "user_message")).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("must not enter");
  expect(JSON.stringify(rows)).not.toContain("<paseo-system>");
  expect(again.agents[0]!.continue).toBe(false);
});

test("a delayed terminal event for an older turn cannot erase newer recovery input", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-stale-terminal-"));
  const client = createCheckpointAgentClient();
  let publish!: (event: AgentStreamEvent) => void;
  let firstTurn = "";
  const originalCreate = client.createSession.bind(client);
  client.createSession = async (...args) => {
    const session = await originalCreate(...args);
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (listener) => {
      publish = listener;
      return subscribe(listener);
    };
    const start = session.startTurn.bind(session);
    session.startTurn = async (...input) => {
      const result = await start(...input);
      firstTurn ||= result.turnId;
      return result;
    };
    return session;
  };
  const before = await manager(home, client);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.runAgent(agent.id, "finish", { clientMessageId: "finished" });
  const active = before.streamAgent(agent.id, "still working", { clientMessageId: "active" });
  await active.next();
  publish({ type: "turn_completed", provider: "codex", turnId: firstTurn });
  const snapshot = await before.quiesceForRestart();
  expect(snapshot.agents[0]!.continue).toBe(true);
  expect(snapshot.agents[0]!.inputs.map((input) => input.id)).toEqual(["active"]);
  expect(snapshot.agents[0]!.inputs[0]!.prompt).toBe("still working");
});

test("a provider close failure cannot become checkpoint readiness on an idempotent retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-close-failure-"));
  const client = createCheckpointAgentClient();
  const create = client.createSession.bind(client);
  client.createSession = async (...args) => {
    const session = await create(...args);
    let closed = false;
    session.close = async () => {
      if (closed) return;
      closed = true;
      throw new Error("provider teardown failed");
    };
    return session;
  };
  const before = await manager(home, client);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "retained", { clientMessageId: "keep" }).next();
  await expect(before.quiesceForRestart()).rejects.toThrow("provider teardown failed");
  await expect(before.quiesceForRestart()).rejects.toThrow(
    "Cannot checkpoint unprocessed provider events",
  );
  expect(before.recoveryPhase).toBe("paused");
  expect(before.getTimeline(agent.id).filter((item) => item.type === "user_message")).toMatchObject(
    [{ clientMessageId: "keep", text: "retained" }],
  );
});

test("an explicit stop never acquires restart continuation intent", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-manager-stopped-"));
  const before = await manager(home);
  const agent = await before.createAgent(
    { provider: "codex", cwd: home },
    "532887fe-050c-41a0-b0ae-05f34a836649",
    { workspaceId: "workspace" },
  );
  const run = before.streamAgent(agent.id, "do not resurrect", {
    clientMessageId: "stopped-input",
  });
  await run.next();
  await before.cancelAgentRun(agent.id);
  const snapshot = await before.quiesceForRestart();
  expect(snapshot.agents[0]!.continue).toBe(false);
  const after = await manager(home);
  await after.installRestartCheckpoint(snapshot);
  await after.resumeRestartCheckpoint(snapshot);
  expect(after.listAgents()).toEqual([]);
  const again = await after.quiesceForRestart();
  expect(again.timelines).toEqual(snapshot.timelines);
});

test("restart retains the active input and every accepted steer in order without text deduplication", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-steering-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "same text", { clientMessageId: "original" }).next();
  for (const clientMessageId of ["steer-first", "steer-second"]) {
    expect(await before.steerAgentRun(agent.id, "same text", { clientMessageId })).toEqual({
      status: "accepted",
    });
  }
  const snapshot = await before.quiesceForRestart();
  expect(snapshot.agents[0]!.inputs.map((input) => [input.id, input.intent, input.prompt])).toEqual(
    [
      ["original", "run", "same text"],
      ["steer-first", "steer", "same text"],
      ["steer-second", "steer", "same text"],
    ],
  );
  const after = await manager(home);
  await after.installRestartCheckpoint(snapshot);
  await after.resumeRestartCheckpoint(snapshot);
  const again = await after.quiesceForRestart();
  const users = again.timelines[agent.id]!.rows.flatMap((row) =>
    row.item.type === "user_message" ? [row.item] : [],
  );
  expect(users.map((row) => row.clientMessageId)).toEqual([
    "original",
    "steer-first",
    "steer-second",
  ]);
  expect(users.map((row) => row.text)).toEqual(["same text", "same text", "same text"]);
  expect(JSON.stringify(users)).not.toContain("paseo-system");
});

test.each([0, 1, 2, 3, 4])(
  "message identity/order is invariant when restart occurs after %i of four identical inputs",
  async (cut) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-restart-order-"));
    let current = await manager(home);
    const agent = await current.createAgent({ provider: "codex", cwd: home }, undefined, {
      workspaceId: "workspace",
    });
    for (let index = 0; index <= 4; index++) {
      if (index === cut) {
        const saved = await current.quiesceForRestart();
        current = await manager(home);
        await current.installRestartCheckpoint(saved);
        await current.resumeRestartCheckpoint(saved);
        const record = saved.agents[0]!.record;
        await current.resumeAgentFromPersistence(
          { provider: record.provider, sessionId: record.persistence!.sessionId },
          { cwd: home },
          agent.id,
          { workspaceId: "workspace" },
        );
      }
      if (index < 4) {
        const stream = current.streamAgent(agent.id, "finish", {
          clientMessageId: `distinct-${index}`,
        });
        for await (const _event of stream) {
          /* finish each independent request */
        }
      }
    }
    const final = await current.quiesceForRestart();
    const rows = final.timelines[agent.id]!.rows;
    const users = rows.flatMap((row) => (row.item.type === "user_message" ? [row.item] : []));
    expect(users.map((row) => row.clientMessageId)).toEqual([
      "distinct-0",
      "distinct-1",
      "distinct-2",
      "distinct-3",
    ]);
    expect(users.map((row) => row.text)).toEqual(["finish", "finish", "finish", "finish"]);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(rows.length);
    expect(final.agents[0]!.continue).toBe(false);
    expect(JSON.stringify(users)).not.toContain("paseo-system");
  },
);
