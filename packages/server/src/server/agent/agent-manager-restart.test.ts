import { cancelAgentRunCommand } from "./lifecycle-command.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { ProviderInitializationCleanupError } from "./provider-initialization-cleanup-error.js";
import { AgentManager, RESTART_RESUME_TIMEOUT_MS } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { buildTimelinePromptIndex } from "./timeline-prompt-index.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createCheckpointAgentClient } from "../test-utils/checkpoint-agent-client.js";
import { RestartInProgressError } from "../restart/restart-errors.js";
import { RESTART_RESTORE_TIMEOUT_MS } from "../shutdown-checkpoint.js";
import type { AgentCheckpoint } from "../restart/agent-checkpoint.js";
import type { AgentClient, AgentSession, AgentStreamEvent } from "./agent-sdk-types.js";
import { AgentTurnStartUncertainError } from "./agent-turn-start-uncertain-error.js";
import { CodexAppServerAgentSession } from "./providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./providers/codex/test-utils/fake-app-server.js";
import {
  drainFinishNotificationWatches,
  restoreFinishNotificationWatch,
  retryPendingFinishNotifications,
  snapshotFinishNotificationWatches,
} from "./agent-prompt.js";

async function manager(
  home: string,
  client: AgentClient = createCheckpointAgentClient(),
  options: { logger?: pino.Logger; restartResumeMs?: number } = {},
) {
  const logger = options.logger ?? createTestLogger();
  const registry = new AgentStorage(join(home, "agents"), logger);
  await registry.initialize();
  return new AgentManager({
    clients: { codex: client },
    registry,
    logger,
    ...(options.restartResumeMs
      ? { rescueTimeouts: { restartResumeMs: options.restartResumeMs } }
      : {}),
  });
}

interface LoggedLine {
  level: number;
  msg: string;
  agentId?: string;
  agentIds?: string[];
  err?: { message: string };
}

function warningLogger() {
  const lines: LoggedLine[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as LoggedLine);
      },
    },
  );
  return { logger, warnings: () => lines.filter((line) => line.level >= 40) };
}

test.each(["no native events", "staged output", "late completion", "transport loss"] as const)(
  "ordinary written Codex start timeout retains its owner and input through %s",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-codex-uncertain-start-"));
    const response = recoveryGate();
    const codex = createFakeCodexAppServer({
      "turn/start": async () => {
        await response.promise;
        return {};
      },
    });
    const client = createCheckpointAgentClient();
    client.createSession = async (config) => {
      const session = new CodexAppServerAgentSession(
        config,
        null,
        createTestLogger(),
        async () => codex.child,
        { turnStartTimeoutMs: 10 },
      );
      await session.connect();
      return session;
    };
    const instance = await manager(home, client);
    const agent = await instance.createAgent(
      { provider: "codex", cwd: home, model: "gpt-5.4", modeId: "auto" },
      undefined,
      { workspaceId: "workspace" },
    );
    const running = instance.streamAgent(agent.id, "keep accepted input", {
      clientMessageId: "written-input",
    });
    const rejected = expect(running.next()).rejects.toBeInstanceOf(AgentTurnStartUncertainError);
    try {
      await codex.waitForRequest("turn/start");
      if (mode === "staged output") {
        codex.startsTurn({ threadId: "thread-1", turnId: "native-start" });
        codex.says({ threadId: "thread-1", itemId: "staged-output", text: "before timeout" });
      }
      if (mode === "transport loss") codex.disconnect();
      await rejected;
      expect(instance.recoveryPhase).toBe("running");
      expect(instance.getRunOutcome(agent.id)).toMatchObject({
        type: "uncertain",
        runId: "written-input",
      });
      expect(() => instance.streamAgent(agent.id, "unsafe successor")).toThrow(
        "already has an active run",
      );
      if (mode === "late completion") {
        const completed = recoveryGate();
        const unsubscribe = instance.subscribeRunOutcome(agent.id, (outcome) => {
          if (outcome.type === "completed") completed.resolve();
        });
        codex.startsTurn({ threadId: "thread-1", turnId: "native-start" });
        codex.says({
          threadId: "thread-1",
          itemId: "completed-output",
          text: "completed after timeout",
        });
        codex.completeTurn({ threadId: "thread-1", turnId: "native-start" });
        await completed.promise;
        unsubscribe();
        expect(instance.getRunOutcome(agent.id)).toMatchObject({
          type: "completed",
          runId: "written-input",
        });
      }
      const saved = await instance.quiesceForRestart();
      expect(saved.agents[0]).toMatchObject({
        runId: "written-input",
        continue: mode !== "late completion",
      });
      expect(saved.agents[0]!.inputs.map((input) => input.id)).toEqual(
        mode === "late completion" ? [] : ["written-input"],
      );
      const items = saved.timelines[agent.id]!.rows.map((row) => row.item);
      expect(items.filter((item) => item.type === "user_message")).toMatchObject([
        { text: "keep accepted input", clientMessageId: "written-input" },
      ]);
      let expectedOutput: string[] = [];
      if (mode === "staged output") expectedOutput = ["before timeout"];
      if (mode === "late completion") expectedOutput = ["completed after timeout"];
      expect(
        items.filter((item) => item.type === "assistant_message").map((item) => item.text),
      ).toEqual(expectedOutput);
      expect(codex.requests().filter((request) => request.method === "turn/start")).toHaveLength(1);
      codex.assertNoErrors();
    } finally {
      response.resolve();
      await instance.quiesceForRestart();
      await running.return(undefined);
    }
  },
);

test("legacy autonomous continuation keeps one logical identity through finish delivery", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-legacy-finish-identity-"));
  const before = await manager(home);
  const caller = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  const child = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(child.id, "legacy autonomous work").next();
  const saved = await before.quiesceForRestart();
  const entry = saved.agents.find((candidate) => candidate.record.id === child.id)!;
  entry.inputs = [];
  delete entry.runId;
  const client = createCheckpointAgentClient();
  const resume = client.resumeSession.bind(client);
  const delivered: string[] = [];
  const callerSessionId = saved.agents.find((candidate) => candidate.record.id === caller.id)!
    .record.persistence!.sessionId;
  client.resumeSession = async (handle, ...args) => {
    const session = await resume(handle, ...args);
    if (handle.sessionId === callerSessionId) {
      const start = session.startTurn.bind(session);
      session.startTurn = (prompt, options) => {
        delivered.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        return start(prompt, options);
      };
    }
    return session;
  };
  const after = await manager(home, client);
  await after.installRestartCheckpoint(saved);
  const originalIdentity = after.getRunIdentity(child.id)!;
  const registry = new AgentStorage(join(home, "agents"), createTestLogger());
  await registry.initialize();
  const completed = after.waitForRunOutcome(child.id, originalIdentity);
  await after.resumeRestartCheckpoint(saved, () =>
    restoreFinishNotificationWatch(
      { agentManager: after, agentStorage: registry, logger: createTestLogger() },
      {
        watchId: "legacy-finish-watch",
        childAgentId: child.id,
        callerAgentId: caller.id,
        requireParentOwnership: false,
        hasSeenRunning: true,
        notifiedPermissionRequestIds: [],
        pending: [],
      },
    ),
  );
  expect(await completed).toMatchObject({ type: "completed", runId: originalIdentity });
  retryPendingFinishNotifications(after);
  await drainFinishNotificationWatches(after);
  expect(snapshotFinishNotificationWatches(after)).toEqual([]);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("continued-output");
  retryPendingFinishNotifications(after);
  await drainFinishNotificationWatches(after);
  expect(delivered).toHaveLength(1);
  const successor = await after.quiesceForRestart();
  expect(successor.agents.find((candidate) => candidate.record.id === child.id)).toMatchObject({
    runId: originalIdentity,
    continue: false,
  });
});

test.each(["completed", "suspended"] as const)(
  "blocking run retains uncertain Codex handoff until %s without holding admission",
  async (terminal) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-codex-uncertain-result-"));
    const response = recoveryGate();
    const codex = createFakeCodexAppServer({
      "turn/start": async () => {
        await response.promise;
        return {};
      },
    });
    const client = createCheckpointAgentClient();
    client.createSession = async (config) => {
      const session = new CodexAppServerAgentSession(
        config,
        null,
        createTestLogger(),
        async () => codex.child,
        { turnStartTimeoutMs: 10 },
      );
      await session.connect();
      return session;
    };
    const instance = await manager(home, client);
    const agent = await instance.createAgent(
      { provider: "codex", cwd: home, model: "gpt-5.4", modeId: "auto" },
      undefined,
      { workspaceId: "workspace" },
    );
    const uncertain = recoveryGate();
    const unsubscribe = instance.subscribeRunOutcome(agent.id, (outcome) => {
      if (outcome.type === "uncertain") uncertain.resolve();
    });
    const result = instance.runAgent(agent.id, "retained result", {
      clientMessageId: "uncertain-result",
    });
    const observedResult = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const handoff = instance.waitForAgentRunStart(agent.id);
    try {
      await codex.waitForRequest("turn/start");
      codex.says({ threadId: "thread-1", itemId: "staged-result", text: "staged result" });
      await uncertain.promise;
      await handoff;
      await instance.freezeRestartAdmissions();
      if (terminal === "completed") {
        codex.startsTurn({ threadId: "thread-1", turnId: "native-result" });
        codex.says({ threadId: "thread-1", itemId: "final-result", text: "final result" });
        codex.completeTurn({ threadId: "thread-1", turnId: "native-result" });
        const completed = await result;
        expect(completed.finalText).toContain("final result");
        expect(
          completed.timeline
            .filter((item) => item.type === "assistant_message")
            .map((item) => item.text),
        ).toEqual(["staged result", "final result"]);
        for (const item of completed.timeline)
          expect(
            (await instance.getCanonicalTimelineRows(agent.id)).map((row) => row.item),
          ).toContainEqual(item);
      } else {
        const saved = await instance.quiesceForRestart();
        expect(await observedResult).toMatchObject({
          error: { name: "AgentRestartSuspendedError" },
        });
        expect(saved.agents[0]).toMatchObject({
          continue: true,
          runId: "uncertain-result",
          inputs: [{ id: "uncertain-result" }],
        });
      }
      expect(codex.requests().filter((request) => request.method === "turn/start")).toHaveLength(1);
    } finally {
      unsubscribe();
      response.resolve();
      await instance.quiesceForRestart();
      await observedResult;
    }
  },
);

test("a failed recovery completion step is logged and admissions open after restoring history", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-recovery-completion-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.runAgent(agent.id, "finish", { clientMessageId: "saved-input" });
  const saved = await before.quiesceForRestart();
  const log = warningLogger();
  const after = await manager(home, createCheckpointAgentClient(), { logger: log.logger });
  await after.installRestartCheckpoint(saved);
  await after.resumeRestartCheckpoint(saved, undefined, async () => {
    expect(() => after.assertAcceptingWork()).toThrow(RestartInProgressError);
    throw new Error("completion fsync failed");
  });
  expect(log.warnings()).toContainEqual(
    expect.objectContaining({
      err: expect.objectContaining({ message: "completion fsync failed" }),
    }),
  );
  expect(after.recoveryPhase).toBe("running");
  expect(await after.getCanonicalTimelineRows(agent.id)).toEqual(saved.timelines[agent.id]!.rows);
  const fresh = await after.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await expect(
    after.runAgent(fresh.id, "finish", { clientMessageId: "after-restart" }),
  ).resolves.toMatchObject({ canceled: false });
});

test("restart preserves late output and user identity without native overwrite and records the attributed continuation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-manager-restart-"));
  const before = await manager(home);
  const agent = await before.createAgent(
    { provider: "codex", cwd: home },
    "54d45fd1-71f4-4c51-8206-7e90bbf6244a",
    { workspaceId: "workspace" },
  );
  const sender = { kind: "agent", agentId: "reviewer", title: "Reviewer" } as const;
  const run = before.streamAgent(agent.id, "keep this request", {
    clientMessageId: "user-1",
    sender,
  });
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
  expect(rows.filter((row) => row.item.type === "user_message")).toHaveLength(2);
  const recovery = rows.find(
    (row) => row.item.type === "user_message" && row.item.sender?.kind === "system",
  );
  expect(recovery?.item).toMatchObject({
    sender: { kind: "system", source: "Restart recovery" },
    text: expect.stringContaining("<paseo-system>"),
  });
  expect(rows[0]?.item).toMatchObject({ sender, clientMessageId: "user-1" });
  expect(buildTimelinePromptIndex(again.timelines[agent.id]!.epoch, rows).prompts).toEqual([]);
  expect(after.getAgent(agent.id)?.lastUserMessageAt).toBeNull();
  expect(JSON.stringify(rows)).not.toContain("must not enter");

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

test("a failed close is logged, keeps the agent resumable, and a later stop retries it", async () => {
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
  const log = warningLogger();
  const before = await manager(home, client, { logger: log.logger });
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "retained", { clientMessageId: "keep" }).next();
  for (let attempt = 0; attempt < 2; attempt++) {
    const unconfirmed = await before.quiesceForRestart();
    expect(unconfirmed.agents[0]).toMatchObject({ continue: true, inputs: [{ id: "keep" }] });
    expect(before.recoveryBlockedAgents()).toEqual([agent.id]);
  }
  const successor = await before.quiesceForRestart();
  expect(successor.agents[0]?.continue).toBe(true);
  expect(before.recoveryBlockedAgents()).toEqual([]);
  expect(before.recoveryPhase).toBe("paused");
  expect(before.getTimeline(agent.id).filter((item) => item.type === "user_message")).toMatchObject(
    [{ clientMessageId: "keep", text: "retained" }],
  );
  expect(
    log
      .warnings()
      .filter((line) => line.agentIds?.includes(agent.id) && line.msg.includes("teardown")),
  ).toHaveLength(2);
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
  const users = again.timelines[agent.id]!.rows.filter(
    (row) => row.item.type !== "user_message" || row.item.sender?.kind !== "system",
  ).flatMap((row) => (row.item.type === "user_message" ? [row.item] : []));
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

test("an active restoration's failed completion is logged and the continued agent stays live", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-active-restore-failure-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "original task", { clientMessageId: "original" }).next();
  const saved = await before.quiesceForRestart();
  const log = warningLogger();
  const after = await manager(
    home,
    createCheckpointAgentClient(undefined, { keepResumedActive: true }),
    { logger: log.logger },
  );
  await after.installRestartCheckpoint(saved);
  await after.resumeRestartCheckpoint(saved, undefined, async () => {
    throw new Error("restored marker fsync failed");
  });
  expect(log.warnings()).toContainEqual(
    expect.objectContaining({
      err: expect.objectContaining({ message: "restored marker fsync failed" }),
    }),
  );
  expect(after.recoveryPhase).toBe("running");
  expect(after.isRestartSuspended(agent.id)).toBe(false);
  expect(after.getAgent(agent.id)?.lifecycle).toBe("running");
  const current = await after.quiesceForRestart();
  expect(after.getRunOutcome(agent.id)).toMatchObject({ type: "suspended", agentId: agent.id });
  expect(current.agents[0]!.continue).toBe(true);
  expect(current.agents[0]!.inputs.map((input) => input.id)).toEqual(["original"]);
  expect(
    current.timelines[agent.id]!.rows.slice(0, saved.timelines[agent.id]!.rows.length),
  ).toEqual(saved.timelines[agent.id]!.rows);
  expect(
    current.timelines[agent.id]!.rows.filter(
      (row) => row.item.type === "user_message" && row.item.sender?.kind !== "system",
    ),
  ).toHaveLength(1);
  expect(
    (await after.getCanonicalTimelineRows(agent.id))
      .map((row) => row.item)
      .filter((item) => item.type === "assistant_message"),
  ).toEqual([
    { type: "assistant_message", text: "partial-output" },
    { type: "assistant_message", text: "late-close-output" },
    { type: "assistant_message", text: "continued-output" },
    { type: "assistant_message", text: "late-close-output" },
  ]);
});

test("a later continuation failure abandons only that agent and does not retain ambient admission authority", async () => {
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
  await after.resumeRestartCheckpoint(saved);
  expect(rejectedCallback).toBe(true);
  expect(after.recoveryPhase).toBe("running");
  expect(after.getAgent(ids[0]!)?.lifecycle).toBe("running");
  expect(after.isRestartSuspended(ids[0])).toBe(false);
  expect(after.getRunOutcome(ids[1]!)).toMatchObject({
    type: "failed",
    runId: "second",
    error: "later start failed",
  });
  expect(after.isRestartSuspended(ids[1])).toBe(false);
  expect(after.getAgent(ids[1]!)?.lifecycle).toBe("idle");
  expect(after.getTimeline(ids[1]!).at(-1)).toEqual({
    type: "error",
    message: "Paseo could not resume this task after the restart. Send a message to continue it.",
  });
  const current = await after.quiesceForRestart();
  expect(
    current.agents.map((entry) => [
      entry.record.id,
      entry.continue,
      entry.inputs.map((input) => input.id),
    ]),
  ).toEqual([
    [ids[0], true, ["first"]],
    [ids[1], false, []],
  ]);
  expect(current.timelines[ids[0]!]!.rows.slice(0, saved.timelines[ids[0]!]!.rows.length)).toEqual(
    saved.timelines[ids[0]!]!.rows,
  );
  expect(
    current.timelines[ids[1]!]!.rows.filter(
      (row) => row.item.type === "user_message" && row.item.sender?.kind !== "system",
    ),
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
    await after.resumeRestartCheckpoint(saved);
    // A completion that arrived before the rejection settled the run; otherwise it is abandoned
    // until the real completion that the provider delivers when it closes.
    expect(after.getRunOutcome(agent.id)).toMatchObject(
      terminalTiming === "before rejection"
        ? { type: "completed", runId: "original-logical-run" }
        : { type: "failed", runId: "original-logical-run" },
    );
    const current = await after.quiesceForRestart();
    expect(after.getRunOutcome(agent.id)).toMatchObject({
      type: "completed",
      runId: "original-logical-run",
      lastMessage: "partial-outputlate-close-outputcontinued-output",
    });
    expect(current.agents[0]!.continue).toBe(false);
    expect(current.agents[0]!.inputs).toEqual([]);
    expect(
      current.timelines[agent.id]!.rows.slice(0, saved.timelines[agent.id]!.rows.length),
    ).toEqual(saved.timelines[agent.id]!.rows);
    expect(
      after
        .getTimeline(agent.id)
        .filter((item) => item.type === "user_message" && item.sender?.kind !== "system"),
    ).toHaveLength(1);
    expect(
      (await after.getCanonicalTimelineRows(agent.id))
        .map((row) => row.item)
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
  expect(await after.getCanonicalTimelineRows(agent.id)).toEqual(saved.timelines[agent.id]!.rows);
  expect(after.fetchTimeline(agent.id, { limit: 0 }).rows.map((row) => row.item)).toEqual(
    after.getTimeline(agent.id),
  );
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

test("partial provider initialization stays owned and a later quiesce retries its cleanup", async () => {
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
  expect((await instance.quiesceForRestart()).agents).toEqual([]);
  expect(cleanupAttempts).toBe(1);
  expect(instance.recoveryBlockedAgents()).toEqual([agentId]);
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
    (await instance.getCanonicalTimelineRows(agent.id))
      .map((row) => row.item)
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

test("a failed direct catalog probe transfers cleanup ownership to the next restart stop", async () => {
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
  await instance.quiesceForRestart();
  expect(instance.recoveryBlockedAgents()).toEqual([expect.stringMatching(/^draft:codex:/)]);
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
  const failedSteps: string[] = [];
  const controller = new RestartController({
    store,
    freeze: () => after.freezeRestartAdmissions(),
    stop: () => after.quiesceRestartExecution(),
    capture: () => after.captureRestartCheckpoint(),
    install: (snapshot) => after.installRestartCheckpoint(snapshot),
    resume: (snapshot) => after.resumeRestartCheckpoint(snapshot),
    finalize: () => after.finalizeRestartRestoration(),
    open: () => {
      opened = true;
      after.openRestartAdmissions();
    },
    failed: (step) => failedSteps.push(step),
    prepareTimeoutMs: 10_000,
    stopTimeoutMs: 5_000,
    restoreTimeoutMs: 10_000,
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
  expect(failedSteps).toEqual([]);
  expect(after.getAgent(agent.id)).toBeNull();
  expect(after.getRunOutcome(agent.id)).toMatchObject({
    type: "user_canceled",
    runId: "marker-original",
  });
  expect(
    after
      .getTimeline(agent.id)
      .filter((item) => item.type === "user_message" && item.sender?.kind !== "system"),
  ).toHaveLength(1);
  expect(
    (await after.getCanonicalTimelineRows(agent.id))
      .map((row) => row.item)
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

test("checkpoint and ordinary reload resume with native replay fenced until an explicit rehydrate", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-checkpoint-native-replay-"));
  const before = await manager(home);
  const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await before.streamAgent(agent.id, "preserved", { clientMessageId: "preserved" }).next();
  const saved = await before.quiesceForRestart();
  const client = createCheckpointAgentClient();
  const resume = client.resumeSession.bind(client);
  const options: Array<Parameters<AgentClient["resumeSession"]>[3]> = [];
  let historyReads = 0;
  client.resumeSession = async (...args) => {
    options.push(args[3]);
    const session = await resume(...args);
    session.streamHistory = async function* () {
      historyReads++;
      if (args[3]?.replayHistory === false) throw new Error("Checkpoint owns native history");
      yield {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "explicit native history" },
      };
    };
    return session;
  };
  const after = await manager(home, client);
  await after.installRestartCheckpoint(saved);
  await after.resumeRestartCheckpoint(saved);
  await after.flush();
  expect(options[0]).toMatchObject({ purpose: "interactive", replayHistory: false });
  await after.reloadAgentSession(agent.id);
  expect(options[1]?.replayHistory).toBe(false);
  expect(historyReads).toBe(0);
  expect(
    (await after.getCanonicalTimelineRows(agent.id)).slice(
      0,
      saved.timelines[agent.id]!.rows.length,
    ),
  ).toEqual(saved.timelines[agent.id]!.rows);
  const submitted = after.getTimeline(agent.id).filter((item) => item.type === "user_message");
  await after.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
  expect(options[2]?.replayHistory).not.toBe(false);
  await after.hydrateTimelineFromProvider(agent.id);
  expect(historyReads).toBe(1);
  expect(after.getTimeline(agent.id)).toEqual([
    { type: "assistant_message", text: "explicit native history" },
    ...submitted,
  ]);
  await after.closeAgentsForShutdown();
});

async function checkpointWithRunningAgents(home: string, prompts: string[]) {
  const before = await manager(home);
  const ids: string[] = [];
  for (const prompt of prompts) {
    const agent = await before.createAgent({ provider: "codex", cwd: home }, undefined, {
      workspaceId: "workspace",
    });
    ids.push(agent.id);
    await before.streamAgent(agent.id, prompt, { clientMessageId: prompt }).next();
  }
  return { ids, saved: await before.quiesceForRestart() };
}

const ABANDONED_ROW = {
  type: "error",
  message: "Paseo could not resume this task after the restart. Send a message to continue it.",
};

test("unfinished work without a native session handle is saved without continuation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-no-handle-"));
  const log = warningLogger();
  const instance = await manager(
    home,
    createCheckpointAgentClient(undefined, { withoutSessionHandle: true }),
    { logger: log.logger },
  );
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await instance.streamAgent(agent.id, "no handle yet", { clientMessageId: "unsaved" }).next();
  const saved = await instance.quiesceForRestart();
  expect(saved.agents).toMatchObject([{ record: { id: agent.id }, continue: false, inputs: [] }]);
  expect(saved.timelines[agent.id]!.rows.map((row) => row.item)).toContainEqual(
    expect.objectContaining({ type: "user_message", clientMessageId: "unsaved" }),
  );
  expect(log.warnings()).toContainEqual(
    expect.objectContaining({
      agentIds: [agent.id],
      msg: "Agents without a native session handle will not resume after the restart",
    }),
  );
});

test("a session resume that fails abandons the agent with a failed outcome and an error row", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-abandon-"));
  const { ids, saved } = await checkpointWithRunningAgents(home, ["abandoned"]);
  const agentId = ids[0]!;
  const after = await manager(home, createCheckpointAgentClient(undefined, { failResume: true }));
  await after.installRestartCheckpoint(saved);
  const outcome = after.waitForRunOutcome(agentId, "abandoned");
  const states: string[] = [];
  after.subscribe((event) => {
    if (event.type === "agent_state" && event.agent.id === agentId)
      states.push(event.agent.lifecycle);
  });
  expect(after.getAgentLifecycle(agentId)?.lifecycle).toBe("running");
  await after.resumeRestartCheckpoint(saved);
  expect(await outcome).toMatchObject({
    type: "failed",
    runId: "abandoned",
    error: "Native session cannot be resumed",
  });
  expect(after.isRestartSuspended(agentId)).toBe(false);
  expect(after.getAgentLifecycle(agentId)?.lifecycle).toBe("idle");
  expect(states).toEqual(["closed"]);
  expect(after.getTimeline(agentId).at(-1)).toEqual(ABANDONED_ROW);
  expect(after.recoveryPhase).toBe("running");
  const successor = await after.quiesceForRestart();
  expect(successor.agents[0]).toMatchObject({ continue: false, inputs: [] });
  expect(successor.timelines[agentId]!.rows.at(-1)?.item).toEqual(ABANDONED_ROW);
});

test("a session resume that never settles is abandoned after the resume limit and the next agent resumes", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-resume-limit-"));
  const { ids, saved } = await checkpointWithRunningAgents(home, ["stuck", "next"]);
  const stuckSessionId = saved.agents.find((entry) => entry.record.id === ids[0])!.record
    .persistence!.sessionId;
  const client = createCheckpointAgentClient();
  const resume = client.resumeSession.bind(client);
  const neverSettles = recoveryGate();
  client.resumeSession = async (handle, ...args) => {
    if (handle.sessionId === stuckSessionId) await neverSettles.promise;
    return resume(handle, ...args);
  };
  const after = await manager(home, client, { restartResumeMs: 50 });
  await after.installRestartCheckpoint(saved);
  await after.resumeRestartCheckpoint(saved);
  expect(after.getRunOutcome(ids[0]!)).toMatchObject({
    type: "failed",
    runId: "stuck",
    error: "Restart step 'resume agent " + ids[0] + "' did not finish within 50 ms",
  });
  expect(after.isRestartSuspended(ids[0])).toBe(false);
  expect(after.getTimeline(ids[0]!).at(-1)).toEqual(ABANDONED_ROW);
  expect(after.isRestartSuspended(ids[1])).toBe(false);
  expect(after.getTimeline(ids[1]!)).toContainEqual({
    type: "assistant_message",
    text: "continued-output",
  });
  expect(after.recoveryPhase).toBe("running");
});

test("checkpoint capture does not wait for a provider stop that never settles", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-hung-stop-"));
  const client = createCheckpointAgentClient();
  const create = client.createSession.bind(client);
  const closeEntered = recoveryGate();
  client.createSession = async (...args) => {
    const session = await create(...args);
    session.close = () => {
      closeEntered.resolve();
      return new Promise<void>(() => undefined);
    };
    return session;
  };
  const instance = await manager(home, client);
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await instance.streamAgent(agent.id, "still working", { clientMessageId: "hung" }).next();
  void instance.quiesceRestartExecution();
  await closeEntered.promise;
  const saved = await instance.captureRestartCheckpoint();
  expect(saved.agents).toMatchObject([
    { record: { id: agent.id }, continue: true, inputs: [{ id: "hung" }] },
  ]);
});

test("a restart quiesce stops a running resume from starting more agents and keeps them suspended", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-resume-interrupted-"));
  const { ids, saved } = await checkpointWithRunningAgents(home, ["first", "second"]);
  const client = createCheckpointAgentClient(undefined, { keepResumedActive: true });
  const resume = client.resumeSession.bind(client);
  const entered = recoveryGate();
  const release = recoveryGate();
  let resumes = 0;
  let starts = 0;
  client.resumeSession = async (...args) => {
    resumes++;
    entered.resolve();
    await release.promise;
    const session = await resume(...args);
    const start = session.startTurn.bind(session);
    session.startTurn = async (...input) => {
      starts++;
      return start(...input);
    };
    return session;
  };
  const after = await manager(home, client);
  await after.installRestartCheckpoint(saved);
  const restoring = after.resumeRestartCheckpoint(saved);
  await entered.promise;
  const quiescing = after.quiesceRestartExecution();
  release.resolve();
  await restoring;
  await quiescing;
  expect(resumes).toBe(1);
  expect(starts).toBe(0);
  expect(after.isRestartSuspended(ids[0])).toBe(true);
  expect(after.isRestartSuspended(ids[1])).toBe(true);
  expect(after.recoveryPhase).toBe("paused");
  expect(after.getRunOutcome(ids[1]!)).toBeUndefined();
  const successor = await after.captureRestartCheckpoint();
  expect(
    successor.agents.map((entry) => [
      entry.record.id,
      entry.continue,
      entry.inputs.map((i) => i.id),
    ]),
  ).toEqual([
    [ids[0], true, ["first"]],
    [ids[1], true, ["second"]],
  ]);
});

test("a continuation that starts during the checkpoint inventory is saved to continue", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-late-continuation-"));
  const logger = createTestLogger();
  const registry = new AgentStorage(join(home, "agents"), logger);
  await registry.initialize();
  const instance = new AgentManager({
    clients: { codex: createCheckpointAgentClient() },
    registry,
    logger,
  });
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  const get = registry.get.bind(registry);
  const entered = recoveryGate();
  const release = recoveryGate();
  let holdNextRead = true;
  registry.get = async (id) => {
    if (holdNextRead) {
      holdNextRead = false;
      entered.resolve();
      await release.promise;
    }
    return get(id);
  };
  const capturing = instance.captureRestartCheckpoint();
  await entered.promise;
  await instance.streamAgent(agent.id, "late work", { clientMessageId: "late" }).next();
  release.resolve();
  const saved = await capturing;
  expect(saved.agents).toMatchObject([
    { record: { id: agent.id }, continue: true, inputs: [{ id: "late" }] },
  ]);
});

test.each(["active", "settled"] as const)(
  "an agent with an %s newer run before the resume loop reaches it keeps that work",
  async (newerRun) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-restart-newer-work-"));
    const { ids, saved } = await checkpointWithRunningAgents(home, ["first", "second"]);
    const [firstId, secondId] = [ids[0]!, ids[1]!];
    const sessionIdOf = (agentId: string) =>
      saved.agents.find((entry) => entry.record.id === agentId)!.record.persistence!.sessionId;
    const client = createCheckpointAgentClient(undefined, {
      keepResumedActive: newerRun === "active",
    });
    const resume = client.resumeSession.bind(client);
    const entered = recoveryGate();
    const release = recoveryGate();
    client.resumeSession = async (handle, ...args) => {
      if (handle.sessionId === sessionIdOf(firstId)) {
        entered.resolve();
        await release.promise;
      }
      return resume(handle, ...args);
    };
    const after = await manager(home, client);
    await after.installRestartCheckpoint(saved);
    const outcomes: string[] = [];
    after.subscribeRunOutcome(secondId, (outcome) => outcomes.push(outcome.type));
    const restoring = after.resumeRestartCheckpoint(saved);
    await entered.promise;
    // The boot's restore limit opened admissions while the loop still waits on the first agent.
    after.openRestartAdmissions();
    await after.resumeAgentFromPersistence(
      { provider: "codex", sessionId: sessionIdOf(secondId) },
      { cwd: home },
      secondId,
      { workspaceId: "workspace" },
    );
    await after.streamAgent(secondId, "newer work", { clientMessageId: "newer" }).next();
    release.resolve();
    await restoring;
    expect(outcomes).not.toContain("failed");
    expect(after.getRunOutcome(secondId)?.type).not.toBe("failed");
    expect(after.isRestartSuspended(secondId)).toBe(false);
    expect(after.getTimeline(secondId)).not.toContainEqual(ABANDONED_ROW);
    expect(after.getTimeline(secondId)).toContainEqual(
      expect.objectContaining({ type: "user_message", clientMessageId: "newer" }),
    );
    // Only the newer run reached the provider; no continuation followed it.
    expect(
      after
        .getTimeline(secondId)
        .filter((item) => item.type === "assistant_message" && item.text === "continued-output"),
    ).toHaveLength(1);
    expect(after.isRestartSuspended(firstId)).toBe(false);
    expect(after.getTimeline(firstId)).toContainEqual({
      type: "assistant_message",
      text: "continued-output",
    });
  },
);

test("the default resume limit for one agent stays below the boot's restore limit", () => {
  expect(RESTART_RESUME_TIMEOUT_MS).toBe(60_000);
  expect(RESTART_RESUME_TIMEOUT_MS).toBeLessThan(RESTART_RESTORE_TIMEOUT_MS);
});

const UNSAVED_ROW = {
  type: "error",
  message:
    "The restart interrupted this task before Paseo could save it. Send a message to continue it.",
};

test("unfinished work without a native session handle gets one error row across captures", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-no-handle-row-"));
  const instance = await manager(
    home,
    createCheckpointAgentClient(undefined, { withoutSessionHandle: true }),
  );
  const agent = await instance.createAgent({ provider: "codex", cwd: home }, undefined, {
    workspaceId: "workspace",
  });
  await instance.streamAgent(agent.id, "no handle yet", { clientMessageId: "unsaved" }).next();
  const unsavedRows = (snapshot: AgentCheckpoint) =>
    snapshot.timelines[agent.id]!.rows.filter(
      (row) => JSON.stringify(row.item) === JSON.stringify(UNSAVED_ROW),
    );
  const first = await instance.quiesceForRestart();
  expect(unsavedRows(first)).toHaveLength(1);
  const second = await instance.captureRestartCheckpoint();
  expect(unsavedRows(second)).toHaveLength(1);
});

test.each([
  "session resume rejects",
  "session resume succeeds late",
  "continuation start rejects",
  "continuation start succeeds late",
] as const)(
  "a quiesce that begins while the %s keeps the agent suspended for the next checkpoint",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-restart-quiesce-mid-agent-"));
    const { ids, saved } = await checkpointWithRunningAgents(home, ["held"]);
    const agentId = ids[0]!;
    const client = createCheckpointAgentClient(undefined, { keepResumedActive: true });
    const resume = client.resumeSession.bind(client);
    const entered = recoveryGate();
    const release = recoveryGate();
    client.resumeSession = async (...args) => {
      if (mode.startsWith("session resume")) {
        entered.resolve();
        await release.promise;
        if (mode === "session resume rejects") throw new Error("Resume rejected");
      }
      const session = await resume(...args);
      const start = session.startTurn.bind(session);
      session.startTurn = async (...input) => {
        if (mode.startsWith("continuation start")) {
          entered.resolve();
          await release.promise;
          if (mode === "continuation start rejects") throw new Error("Start rejected");
        }
        return start(...input);
      };
      return session;
    };
    const after = await manager(home, client);
    await after.installRestartCheckpoint(saved);
    const outcomes: string[] = [];
    after.subscribeRunOutcome(agentId, (outcome) => outcomes.push(outcome.type));
    const restoring = after.resumeRestartCheckpoint(saved);
    await entered.promise;
    const quiescing = after.quiesceRestartExecution();
    release.resolve();
    await restoring;
    await quiescing;
    expect(outcomes).not.toContain("failed");
    expect(after.getTimeline(agentId)).not.toContainEqual(ABANDONED_ROW);
    expect(after.isRestartSuspended(agentId)).toBe(true);
    const successor = await after.captureRestartCheckpoint();
    expect(successor.agents).toMatchObject([
      { record: { id: agentId }, continue: true, inputs: [{ id: "held" }] },
    ]);
  },
);

test("an agent whose session a client loaded before the resume loop reached it continues on that session", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-restart-live-idle-"));
  const { ids, saved } = await checkpointWithRunningAgents(home, ["first", "second"]);
  const [firstId, secondId] = [ids[0]!, ids[1]!];
  const sessionIdOf = (agentId: string) =>
    saved.agents.find((entry) => entry.record.id === agentId)!.record.persistence!.sessionId;
  const client = createCheckpointAgentClient();
  const resume = client.resumeSession.bind(client);
  const entered = recoveryGate();
  const release = recoveryGate();
  let secondResumes = 0;
  const secondPrompts: string[] = [];
  client.resumeSession = async (handle, ...args) => {
    if (handle.sessionId === sessionIdOf(firstId)) {
      entered.resolve();
      await release.promise;
    }
    const session = await resume(handle, ...args);
    if (handle.sessionId === sessionIdOf(secondId)) {
      secondResumes++;
      const start = session.startTurn.bind(session);
      session.startTurn = (prompt, options) => {
        secondPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        return start(prompt, options);
      };
    }
    return session;
  };
  const lines: { msg: string; resumed?: string[]; superseded?: string[] }[] = [];
  const logger = pino(
    { level: "info" },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as (typeof lines)[number]);
      },
    },
  );
  const after = await manager(home, client, { logger });
  await after.installRestartCheckpoint(saved);
  const restoring = after.resumeRestartCheckpoint(saved);
  await entered.promise;
  // The boot's restore limit opened admissions, and the owner opened the second agent.
  after.openRestartAdmissions();
  await after.resumeAgentFromPersistence(
    { provider: "codex", sessionId: sessionIdOf(secondId) },
    { cwd: home },
    secondId,
    { workspaceId: "workspace" },
  );
  expect(after.getAgentLifecycle(secondId)?.lifecycle).toBe("idle");
  release.resolve();
  await restoring;
  expect(secondResumes).toBe(1);
  expect(secondPrompts).toHaveLength(1);
  expect(secondPrompts[0]).toContain("second");
  expect(after.isRestartSuspended(secondId)).toBe(false);
  expect(after.getTimeline(secondId)).toContainEqual({
    type: "assistant_message",
    text: "continued-output",
  });
  expect(lines.find((line) => line.msg === "Restart recovery resumed agents")).toMatchObject({
    resumed: [firstId, secondId],
    superseded: [],
  });
});
