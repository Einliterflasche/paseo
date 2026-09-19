import { cancelAgentRunCommand } from "./lifecycle-command.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProviderInitializationCleanupError } from "./provider-initialization-cleanup-error.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createCheckpointAgentClient } from "../test-utils/checkpoint-agent-client.js";
import { RestartInProgressError } from "../restart/restart-errors.js";
import type { AgentClient, AgentSession, AgentStreamEvent } from "./agent-sdk-types.js";

async function manager(home: string, client: AgentClient = createCheckpointAgentClient()) {
  const logger = createTestLogger();
  const registry = new AgentStorage(join(home, "agents"), logger);
  await registry.initialize();
  return new AgentManager({ clients: { codex: client }, registry, logger });
}

test("failed durable completion keeps admissions closed after restoring history", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-recovery-completion-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.runAgent(agent.id, "finish", { clientMessageId: "saved-input" });
  const saved = await before.quiesceForRestart();
  const after = await manager(home);
  await after.installRestartCheckpoint(saved);
  await expect(
    after.resumeRestartCheckpoint(saved, undefined, async () => {
      expect(() => after.assertAcceptingWork()).toThrow(RestartInProgressError);
      throw new Error("completion fsync failed");
    }),
  ).rejects.toThrow("completion fsync failed");
  expect(after.recoveryPhase).toBe("paused");
  await expect(after.createAgent({ provider: "codex", cwd: home })).rejects.toThrow(
    RestartInProgressError,
  );
  expect(() => after.streamAgent(agent.id, "must not dispatch")).toThrow(RestartInProgressError);
  expect((await after.quiesceForRestart()).timelines).toEqual(saved.timelines);
});

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

test("a failed close remains blocked until a fresh provider stop certifies cessation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-close-failure-"));
  const client = createCheckpointAgentClient();
  const create = client.createSession.bind(client);
  client.createSession = async (...args) => {
    const session = await create(...args);
    let attempts = 0;
    const close = session.close.bind(session);
    session.close = async () => {
      attempts++;
      if (attempts < 3) throw new Error("provider teardown failed");
      await close();
    };
    return session;
  };
  const before = await manager(home, client);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "retained", { clientMessageId: "keep" }).next();
  await expect(before.quiesceForRestart()).rejects.toMatchObject({
    message: "Cannot certify provider teardown and event drain",
    errors: expect.arrayContaining([
      expect.objectContaining({ message: "provider teardown failed" }),
    ]),
  });
  await expect(before.quiesceForRestart()).rejects.toThrow(
    "Cannot certify provider teardown and event drain",
  );
  const successor = await before.quiesceForRestart();
  expect(successor.agents[0]?.continue).toBe(true);
  expect(before.recoveryBlockedAgents()).toEqual([]);
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

test("an active restoration's failed completion closes capture before pause and preserves late output", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-active-restore-failure-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "original task", { clientMessageId: "original" }).next();
  const saved = await before.quiesceForRestart();
  const after = await manager(
    home,
    createCheckpointAgentClient(undefined, { keepResumedActive: true }),
  );
  await after.installRestartCheckpoint(saved);
  await expect(
    after.resumeRestartCheckpoint(saved, undefined, async () => {
      throw new Error("restored marker fsync failed");
    }),
  ).rejects.toThrow("restored marker fsync failed");
  expect(after.recoveryPhase).toBe("paused");
  expect(after.getRunOutcome(agent.id)).toMatchObject({ type: "suspended", agentId: agent.id });
  const current = await after.quiesceForRestart();
  expect(current.agents[0]!.continue).toBe(true);
  expect(current.agents[0]!.inputs.map((input) => input.id)).toEqual(["original"]);
  expect(
    current.timelines[agent.id]!.rows.slice(0, saved.timelines[agent.id]!.rows.length),
  ).toEqual(saved.timelines[agent.id]!.rows);
  expect(
    current.timelines[agent.id]!.rows.filter((row) => row.item.type === "user_message"),
  ).toHaveLength(1);
  expect(after.getTimeline(agent.id).filter((item) => item.type === "assistant_message")).toEqual([
    { type: "assistant_message", text: "partial-output" },
    { type: "assistant_message", text: "late-close-output" },
    { type: "assistant_message", text: "continued-output" },
    { type: "assistant_message", text: "late-close-output" },
  ]);
});

test("a later continuation failure preserves every agent and does not retain ambient admission authority", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-partial-continuation-"));
  const before = await manager(home);
  const ids: string[] = [];
  for (const prompt of ["first", "second"]) {
    const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
      workspaceId: "workspace",
    });
    ids.push(agent.id);
    await before.streamAgent(agent.id, prompt, { clientMessageId: prompt }).next();
  }
  const saved = await before.quiesceForRestart();
  const client = createCheckpointAgentClient(undefined, { keepResumedActive: true });
  const resume = client.resumeSession.bind(client);
  let starts = 0;
  client.resumeSession = async (...args) => {
    const session = await resume(...args);
    const start = session.startTurn.bind(session);
    session.startTurn = async (...params) => {
      starts++;
      if (starts === 2) throw new Error("later start failed");
      return start(...params);
    };
    return session;
  };
  const after = await manager(home, client);
  await after.installRestartCheckpoint(saved);
  let rejectedCallback = false;
  after.subscribe((event) => {
    if (event.type !== "agent_stream" || event.event.type !== "turn_started") return;
    try {
      after.assertAcceptingWork();
    } catch (error) {
      rejectedCallback = error instanceof RestartInProgressError;
    }
  });
  await expect(after.resumeRestartCheckpoint(saved)).rejects.toThrow("later start failed");
  const current = await after.quiesceForRestart();
  expect(rejectedCallback).toBe(true);
  expect(
    current.agents.map((entry) => [
      entry.record.id,
      entry.continue,
      entry.inputs.map((input) => input.id),
    ]),
  ).toEqual([
    [ids[0], true, ["first"]],
    [ids[1], true, ["second"]],
  ]);
  expect(after.getRunOutcome(ids[0]!)).toMatchObject({ type: "suspended", agentId: ids[0] });
  expect(after.getRunOutcome(ids[1]!)).toMatchObject({ type: "suspended", agentId: ids[1] });
  await after.resumeRestartCheckpoint(current);
  const resumed = await after.quiesceForRestart();
  expect(
    resumed.timelines[ids[0]!]!.rows.slice(0, current.timelines[ids[0]!]!.rows.length),
  ).toEqual(current.timelines[ids[0]!]!.rows);
  expect(
    resumed.timelines[ids[1]!]!.rows.filter((row) => row.item.type === "user_message"),
  ).toHaveLength(1);
});

test.each(["before rejection", "during close"] as const)(
  "a rejected recovery handoff preserves staged output and a real completion %s",
  async (terminalTiming) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-recovery-rejected-handoff-"));
    const before = await manager(home);
    const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
      workspaceId: "workspace",
    });
    await before
      .streamAgent(agent.id, "original task", { clientMessageId: "original-logical-run" })
      .next();
    const saved = await before.quiesceForRestart();
    const client = createCheckpointAgentClient(undefined, {
      keepResumedActive: terminalTiming === "during close",
    });
    const resume = client.resumeSession.bind(client);
    client.resumeSession = async (...args) => {
      const session = await resume(...args);
      const listeners = new Set<(event: AgentStreamEvent) => void>();
      const subscribe = session.subscribe.bind(session);
      let turnId: string | undefined;
      session.subscribe = (listener) => {
        listeners.add(listener);
        const unsubscribe = subscribe((event) => {
          if (event.type === "turn_started") turnId = event.turnId;
          listener(event);
        });
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      };
      const start = session.startTurn.bind(session);
      session.startTurn = async (...input) => {
        await start(...input);
        throw new Error("handoff receipt rejected after execution");
      };
      const close = session.close.bind(session);
      session.close = async () => {
        if (terminalTiming === "during close")
          for (const listener of listeners)
            listener({ type: "turn_completed", provider: "codex", turnId });
        await close();
      };
      return session;
    };
    const after = await manager(home, client);
    await after.installRestartCheckpoint(saved);
    await expect(after.resumeRestartCheckpoint(saved)).rejects.toThrow(
      "handoff receipt rejected after execution",
    );
    expect(after.getRunOutcome(agent.id)).toMatchObject({
      type: "completed",
      runId: "original-logical-run",
      lastMessage: "partial-outputlate-close-outputcontinued-output",
    });
    const current = await after.quiesceForRestart();
    expect(current.agents[0]!.continue).toBe(false);
    expect(current.agents[0]!.inputs).toEqual([]);
    expect(
      current.timelines[agent.id]!.rows.slice(0, saved.timelines[agent.id]!.rows.length),
    ).toEqual(saved.timelines[agent.id]!.rows);
    expect(after.getTimeline(agent.id).filter((item) => item.type === "user_message")).toHaveLength(
      1,
    );
    expect(
      after
        .getTimeline(agent.id)
        .filter((item) => item.type === "assistant_message")
        .map((item) => item.text),
    ).toEqual([
      "partial-output",
      "late-close-output",
      "continued-output",
      ...(terminalTiming === "during close" ? ["late-close-output"] : []),
    ]);
  },
);

test("installed history reads and explicit cancellation do not need a native session", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-paused-history-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "keep history", { clientMessageId: "saved" }).next();
  const saved = await before.quiesceForRestart();
  const client = createCheckpointAgentClient();
  let resumed = 0;
  client.resumeSession = async () => {
    resumed++;
    throw new Error("must not start provider for reads");
  };
  const after = await manager(home, client);
  await after.installRestartCheckpoint(saved);
  expect(after.hasInstalledHistory(agent.id)).toBe(true);
  expect(after.fetchTimeline(agent.id, { limit: 0 }).rows).toEqual(saved.timelines[agent.id]!.rows);
  expect(await after.getLastAssistantMessage(agent.id)).toBe("partial-outputlate-close-output");
  expect(await after.cancelAgentRun(agent.id)).toEqual({ status: "settled" });
  expect((await after.quiesceForRestart()).agents[0]!.continue).toBe(false);
  expect(resumed).toBe(0);
});

test.each(["turn_completed", "turn_failed"] as const)(
  "recovery cancellation preserves a real %s delivered during provider close",
  async (type) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cancel-terminal-"));
    const client = createCheckpointAgentClient();
    const create = client.createSession.bind(client);
    client.createSession = async (...args) => {
      const session = await create(...args);
      const subscribe = session.subscribe.bind(session);
      const listeners = new Set<(event: AgentStreamEvent) => void>();
      let turnId: string | undefined;
      session.subscribe = (listener) => {
        listeners.add(listener);
        const unsubscribe = subscribe((event) => {
          if (event.type === "turn_started") turnId = event.turnId;
          listener(event);
        });
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      };
      const close = session.close.bind(session);
      session.close = async () => {
        for (const listener of listeners)
          listener(
            type === "turn_failed"
              ? { type, provider: "codex", turnId, error: "real provider failure" }
              : { type, provider: "codex", turnId },
          );
        await close();
      };
      return session;
    };
    const instance = await manager(home, client);
    const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
      workspaceId: "workspace",
    });
    const stream = instance.streamAgent(agent.id, "work", { clientMessageId: "logical-input" });
    await stream.next();
    await instance.freezeRestartAdmissions();
    expect(await instance.cancelAgentRun(agent.id)).toEqual({ status: "settled" });
    expect(instance.getRunOutcome(agent.id)).toMatchObject({
      type: type === "turn_completed" ? "completed" : "failed",
      runId: "logical-input",
    });
    expect((await instance.quiesceForRestart()).agents[0]!.continue).toBe(false);
    await stream.return();
  },
);

test("discarded installed history cannot resurrect a deleted or archived agent in a successor", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-recovery-inventory-"));
  const before = await manager(home);
  const deleted = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  const archived = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.runAgent(deleted.id, "finish", { clientMessageId: "deleted-input" });
  await before.runAgent(archived.id, "finish", { clientMessageId: "archived-input" });
  const saved = await before.quiesceForRestart();
  const after = await manager(home);
  await after.installRestartCheckpoint(saved);
  await after.resumeRestartCheckpoint(saved);
  expect(after.hasInstalledHistory(deleted.id)).toBe(true);
  await after.deleteAgentState(deleted.id);
  await after.archiveSnapshot(archived.id, "2026-09-19T12:00:00.000Z");
  const successor = await after.quiesceForRestart();
  expect(successor.agents.map((entry) => entry.record.id)).not.toContain(deleted.id);
  expect(successor.agents.map((entry) => entry.record.id)).not.toContain(archived.id);
  expect(successor.timelines[deleted.id]).toBeUndefined();
  expect(successor.timelines[archived.id]).toBeUndefined();
});

test("failed ordinary close retains the native owner and late output until retry certifies the requested stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-close-owner-"));
  const client = createCheckpointAgentClient();
  const create = client.createSession.bind(client);
  let failClose = true;
  client.createSession = async (...args) => {
    const session = await create(...args);
    const close = session.close.bind(session);
    session.close = async () => {
      if (failClose) throw new Error("cessation unknown");
      await close();
    };
    return session;
  };
  const instance = await manager(home, client);
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await instance.streamAgent(agent.id, "stop me", { clientMessageId: "stop-input" }).next();
  await expect(instance.closeAgent(agent.id)).rejects.toThrow("cessation unknown");
  expect(instance.getAgent(agent.id)).not.toBeNull();
  expect(instance.recoveryBlockedAgents()).toContain(agent.id);
  failClose = false;
  const checkpoint = await instance.quiesceForRestart();
  expect(checkpoint.agents[0]).toMatchObject({ continue: false, inputs: [] });
  expect(checkpoint.timelines[agent.id]!.rows.map((row) => row.item)).toContainEqual({
    type: "assistant_message",
    text: "late-close-output",
  });
  expect(instance.getRunOutcome(agent.id)).toMatchObject({
    type: "user_canceled",
    runId: "stop-input",
  });
  expect(instance.recoveryBlockedAgents()).toEqual([]);
});

test("partial provider initialization remains owned until its cleanup capability certifies cessation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-initialization-owner-"));
  const client = createCheckpointAgentClient();
  let canStop = false;
  let cleanupAttempts = 0;
  const resource = {
    close: async () => {
      cleanupAttempts++;
      if (!canStop) throw new Error("process still active");
    },
  };
  client.createSession = async () => {
    throw new ProviderInitializationCleanupError(
      resource,
      new Error("handshake failed"),
      new Error("abort failed"),
    );
  };
  const instance = await manager(home, client);
  const agentId = "505fb9d0-882e-4fbe-8a89-3980d751d9c7";
  await expect(
    instance.createAgent({ provider: "codex", cwd: home }, agentId, { workspaceId: "workspace" }),
  ).rejects.toBeInstanceOf(ProviderInitializationCleanupError);
  expect(instance.getAgent(agentId)).toBeNull();
  expect(instance.recoveryBlockedAgents()).toEqual([agentId]);
  await expect(instance.quiesceForRestart()).rejects.toThrow("Cannot certify provider teardown");
  expect(cleanupAttempts).toBe(1);
  canStop = true;
  expect((await instance.quiesceForRestart()).agents).toEqual([]);
  expect(cleanupAttempts).toBe(2);
  expect(instance.recoveryBlockedAgents()).toEqual([]);
});

test("same-process recovery retires certified idle handles but keeps their exact history", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-recovery-idle-handle-"));
  const instance = await manager(home);
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await instance.runAgent(agent.id, "finish", { clientMessageId: "before" });
  const saved = await instance.quiesceForRestart();
  await instance.installRestartCheckpoint(saved);
  await instance.resumeRestartCheckpoint(saved);
  expect(instance.getAgent(agent.id)).toBeNull();
  expect(instance.hasInstalledHistory(agent.id)).toBe(true);
  expect((await instance.quiesceForRestart()).timelines).toEqual(saved.timelines);
  instance.openRestartAdmissions();
  const record = saved.agents[0]!.record;
  await instance.resumeAgentFromPersistence(record.persistence!, undefined, agent.id);
  await expect(
    instance.runAgent(agent.id, "finish", { clientMessageId: "after" }),
  ).resolves.toMatchObject({ canceled: false });
});

test("reopening a user-closed session gives a provider-initiated turn fresh recovery ownership", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-reopened-autonomous-"));
  const client = createCheckpointAgentClient(undefined, { keepResumedActive: true });
  const resume = client.resumeSession.bind(client);
  let reopened: AgentSession | undefined;
  client.resumeSession = async (...args) => {
    reopened = await resume(...args);
    return reopened;
  };
  const instance = await manager(home, client);
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await instance.closeAgent(agent.id);
  await instance.resumeAgentFromPersistence(agent.persistence!, { cwd: home }, agent.id);
  const started = new Promise<void>((resolve) => {
    const unsubscribe = instance.subscribe((event) => {
      if (
        event.type === "agent_stream" &&
        event.agentId === agent.id &&
        event.event.type === "turn_started"
      ) {
        unsubscribe();
        resolve();
      }
    });
  });
  await reopened!.startTurn("provider-owned task");
  await started;
  const snapshot = await instance.quiesceForRestart();
  expect(snapshot.agents[0]!).toMatchObject({ continue: true, inputs: [] });
  expect(instance.getRunOutcome(agent.id)).toMatchObject({ type: "suspended" });
  expect(
    instance
      .getTimeline(agent.id)
      .filter((item) => item.type === "assistant_message")
      .map((item) => item.text),
  ).toEqual(["continued-output", "late-close-output"]);
});

function recoveryGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(["accepted input", "legacy autonomous"] as const)(
  "a stop during %s recovery registration closes the new owner without continuing",
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-recovery-register-stop-"));
    const before = await manager(home);
    const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
      workspaceId: "workspace",
    });
    await before.streamAgent(agent.id, "original", { clientMessageId: "original-input" }).next();
    const saved = await before.quiesceForRestart();
    if (kind === "legacy autonomous") {
      saved.agents[0]!.inputs = [];
      delete saved.agents[0]!.runId;
    }
    const client = createCheckpointAgentClient(undefined, { keepResumedActive: true });
    const resume = client.resumeSession.bind(client);
    const entered = recoveryGate();
    const release = recoveryGate();
    let starts = 0;
    let closes = 0;
    client.resumeSession = async (...args) => {
      entered.resolve();
      await release.promise;
      const session = await resume(...args);
      const start = session.startTurn.bind(session);
      const close = session.close.bind(session);
      session.startTurn = async (...input) => {
        starts++;
        return start(...input);
      };
      session.close = async () => {
        closes++;
        await close();
      };
      return session;
    };
    const after = await manager(home, client);
    await after.installRestartCheckpoint(saved);
    const restoring = after.resumeRestartCheckpoint(saved);
    await entered.promise;
    let stopped = false;
    const cancellation = cancelAgentRunCommand(
      { agentManager: after, logger: createTestLogger() },
      agent.id,
    ).then((result) => {
      stopped = true;
      return result;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await restoring;
    await expect(cancellation).resolves.toMatchObject({ cancelled: true });
    expect(starts).toBe(0);
    expect(closes).toBe(1);
    expect(after.getAgent(agent.id)).toBeNull();
    expect(after.getRunOutcome(agent.id)).toMatchObject({
      type: "user_canceled",
      ...(kind === "accepted input" ? { runId: "original-input" } : {}),
    });
    const current = await after.quiesceForRestart();
    expect(current.agents[0]).toMatchObject({ continue: false, inputs: [] });
    expect(current.timelines).toEqual(saved.timelines);
  },
);

test("out-of-band command completion drains after close without holding restart admission", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-side-command-restart-"));
  const client = createCheckpointAgentClient();
  const create = client.createSession.bind(client);
  const commandReleased = recoveryGate();
  let commandSettled = false;
  let closes = 0;
  client.createSession = async (...args) => {
    const session = await create(...args);
    const close = session.close.bind(session);
    session.tryHandleOutOfBand = () => ({
      run: async ({ emit }) => {
        await commandReleased.promise;
        emit({
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "side command stopped durably" },
        });
        commandSettled = true;
      },
    });
    session.close = async () => {
      closes++;
      await close();
      commandReleased.resolve();
    };
    return session;
  };
  const instance = await manager(home, client);
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  expect(instance.tryRunOutOfBand(agent.id, "/compact", { clientMessageId: "compact-input" })).toBe(
    true,
  );
  await instance.freezeRestartAdmissions();
  expect(commandSettled).toBe(false);
  expect(closes).toBe(0);
  const checkpoint = await instance.quiesceForRestart();
  expect(commandSettled).toBe(true);
  expect(closes).toBe(1);
  expect(checkpoint.timelines[agent.id]!.rows.map((row) => row.item)).toContainEqual({
    type: "assistant_message",
    text: "side command stopped durably",
  });
  expect(checkpoint.agents[0]!.continue).toBe(false);
});

test.each(["commands", "features"] as const)(
  "draft %s probes cannot start provider work after freeze",
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-draft-probe-admission-"));
    const client = createCheckpointAgentClient();
    const entered = recoveryGate();
    const release = recoveryGate();
    let calls = 0;
    const probe = async (
      _config: unknown,
      context?: import("./agent-sdk-types.js").AgentProbeContext,
    ) => {
      calls++;
      const cleanup = {
        close: async () => {
          release.resolve();
        },
      };
      const disown = context!.own(cleanup);
      entered.resolve();
      await release.promise;
      await cleanup.close();
      disown();
      return [];
    };
    client.listCommands = probe;
    client.listFeatures = probe;
    const instance = await manager(home, client);
    const invoke = () =>
      kind === "commands"
        ? instance.listDraftCommands({ provider: "codex", cwd: home, model: "test-model" })
        : instance.listDraftFeatures({ provider: "codex", cwd: home, model: "test-model" });
    const pending = invoke();
    await entered.promise;
    await instance.freezeRestartAdmissions();
    await expect(invoke()).rejects.toBeInstanceOf(RestartInProgressError);
    expect(calls).toBe(1);
    await instance.quiesceForRestart();
    await pending;
  },
);

test("a failed direct catalog probe transfers cleanup ownership to recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-probe-cleanup-"));
  const client = createCheckpointAgentClient();
  let canClose = false;
  let closes = 0;
  const cleanup = {
    close: async () => {
      closes++;
      if (!canClose) throw new Error("probe still running");
    },
  };
  client.listFeatures = async () => {
    throw new ProviderInitializationCleanupError(
      cleanup,
      new Error("catalog failed"),
      new Error("probe close failed"),
    );
  };
  const instance = await manager(home, client);
  await expect(instance.listDraftFeatures({ provider: "codex", cwd: home })).rejects.toBeInstanceOf(
    ProviderInitializationCleanupError,
  );
  expect(instance.recoveryBlockedAgents()).toEqual([expect.stringMatching(/^draft:codex:/)]);
  await expect(instance.quiesceForRestart()).rejects.toThrow("Cannot certify provider teardown");
  canClose = true;
  await instance.quiesceForRestart();
  expect(closes).toBe(3);
  expect(instance.recoveryBlockedAgents()).toEqual([]);
});

test.each([
  ["freeze", "before freeze"],
  ["freeze", "after freeze"],
  ["quiesce", "before freeze"],
  ["quiesce", "after freeze"],
] as const)(
  "accepted commands cannot deadlock %s with catalog acquisition %s",
  async (method, timing) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-nested-probe-freeze-"));
    const instance = await manager(home);
    const commandEntered = recoveryGate();
    const acquire = recoveryGate();
    const catalogEntered = recoveryGate();
    const catalogStopped = recoveryGate();
    let acquisitions = 0;
    let closes = 0;
    const command = instance.runRequestAdmission(async () => {
      commandEntered.resolve();
      await acquire.promise;
      await instance.runProviderProbe("nested-catalog", async (context) => {
        acquisitions++;
        context.own({
          close: async () => {
            closes++;
            catalogStopped.resolve();
          },
        });
        catalogEntered.resolve();
        await catalogStopped.promise;
        context.signal.throwIfAborted();
      });
    });
    const result = command.then(
      () => "completed",
      (error: unknown) => error,
    );
    await commandEntered.promise;
    if (timing === "before freeze") {
      acquire.resolve();
      await catalogEntered.promise;
    }
    const freezing =
      method === "freeze" ? instance.freezeRestartAdmissions() : instance.quiesceForRestart();
    acquire.resolve();
    await freezing;
    expect(await result).toBeInstanceOf(Error);
    if (timing === "after freeze") expect(await result).toBeInstanceOf(RestartInProgressError);
    expect(acquisitions).toBe(timing === "before freeze" ? 1 : 0);
    expect(closes).toBe(acquisitions);
    expect(instance.recoveryBlockedAgents()).toEqual([]);
    await instance.quiesceForRestart();
  },
);

test("recovery drains a cancellation accepted during marker publication and retires its closed handle", async () => {
  const { RestartController } = await import("../restart/restart-controller.js");
  const { CheckpointStore } = await import("../restart/checkpoint-store.js");
  const { AgentCheckpointSchema } = await import("../restart/agent-checkpoint.js");
  const home = await mkdtemp(join(tmpdir(), "paseo-marker-cancellation-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "original", { clientMessageId: "marker-original" }).next();
  const saved = await before.quiesceForRestart();
  const markerEntered = recoveryGate();
  const markerRelease = recoveryGate();
  const closeEntered = recoveryGate();
  const closeRelease = recoveryGate();
  class HeldMarkerStore extends CheckpointStore<typeof saved> {
    override async markRestored(id: string) {
      await super.markRestored(id);
      markerEntered.resolve();
      await markerRelease.promise;
    }
  }
  const store = new HeldMarkerStore(home, AgentCheckpointSchema.parse);
  await store.commit(saved);
  const client = createCheckpointAgentClient(undefined, { keepResumedActive: true });
  const resume = client.resumeSession.bind(client);
  client.resumeSession = async (...args) => {
    const session = await resume(...args);
    const close = session.close.bind(session);
    session.close = async () => {
      closeEntered.resolve();
      await closeRelease.promise;
      await close();
    };
    return session;
  };
  const after = await manager(home, client);
  let opened = false;
  const controller = new RestartController({
    store,
    freeze: () => after.freezeRestartAdmissions(),
    stop: () => after.quiesceRestartExecution(),
    capture: () => after.quiesceForRestart(),
    install: (snapshot) => after.installRestartCheckpoint(snapshot),
    resume: (snapshot) => after.resumeRestartCheckpoint(snapshot),
    finalize: () => after.finalizeRestartRestoration(),
    open: () => {
      opened = true;
      after.openRestartAdmissions();
    },
  });
  after.bindRecoveryLifecycle(controller);
  const claim = (await controller.claim())!;
  const restoring = controller.restore(claim);
  await markerEntered.promise;
  const cancellation = cancelAgentRunCommand(
    { agentManager: after, logger: createTestLogger() },
    agent.id,
  );
  await closeEntered.promise;
  markerRelease.resolve();
  await Promise.resolve();
  expect(opened).toBe(false);
  expect(controller.status.state).toBe("restoring");
  closeRelease.resolve();
  await cancellation;
  await restoring;
  expect(opened).toBe(true);
  expect(after.getAgent(agent.id)).toBeNull();
  expect(after.getRunOutcome(agent.id)).toMatchObject({
    type: "user_canceled",
    runId: "marker-original",
  });
  expect(after.getTimeline(agent.id).filter((item) => item.type === "user_message")).toHaveLength(
    1,
  );
  expect(
    after
      .getTimeline(agent.id)
      .filter((item) => item.type === "assistant_message")
      .map((item) => item.text),
  ).toEqual(["partial-output", "late-close-output", "continued-output", "late-close-output"]);
  // The next request can reopen an actual provider instead of finding a closed handle.
  await after.resumeAgentFromPersistence(
    saved.agents[0]!.record.persistence!,
    { cwd: home },
    agent.id,
  );
  expect(after.getAgent(agent.id)?.session).toBeTruthy();
  await after.closeAgent(agent.id);
});
