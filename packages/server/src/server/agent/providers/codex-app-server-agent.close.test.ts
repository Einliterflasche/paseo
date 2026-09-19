import { expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AgentTurnStartUncertainError } from "../agent-turn-start-uncertain-error.js";

test("Codex treats an explicit native start rejection as settled before a new start", async () => {
  let starts = 0;
  const codex = createFakeCodexAppServer({
    "turn/start": () =>
      ++starts === 1 ? { __jsonRpcError: { code: -32602, message: "invalid model" } } : {},
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => codex.child,
  );
  try {
    const error = await session.startTurn("rejected input").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentTurnStartUncertainError);
    expect(error).toMatchObject({ message: "invalid model" });
    await expect(session.startTurn("corrected input")).resolves.toHaveProperty("turnId");
    expect(starts).toBe(2);
    codex.assertNoErrors();
  } finally {
    await session.close();
  }
});

test("Codex retains ownership after an internal start error that cannot prove nonexecution", async () => {
  const codex = createFakeCodexAppServer({
    "turn/start": () => ({
      __jsonRpcError: { code: -32603, message: "internal error after handoff" },
    }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => codex.child,
  );
  try {
    await expect(session.startTurn("possibly accepted input")).rejects.toBeInstanceOf(
      AgentTurnStartUncertainError,
    );
    await expect(session.startTurn("unsafe successor")).rejects.toThrow(
      "foreground turn is already active",
    );
    expect(codex.requests().filter((request) => request.method === "turn/start")).toHaveLength(1);
  } finally {
    await session.close();
  }
});

test("Codex keeps a written timed-out start owned through its late acknowledgement and native stop", async () => {
  const acknowledged = Promise.withResolvers<{}>();
  const codex = createFakeCodexAppServer({
    "turn/start": () => acknowledged.promise,
    "turn/interrupt": () => ({}),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => codex.child,
    { turnStartTimeoutMs: 10 },
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const start = session.startTurn("written before stop");
    const failedStart = expect(start).rejects.toThrow("request timed out for turn/start");
    await codex.waitForRequest("turn/start");
    let stopped = false;
    const interrupt = session.interrupt().then(() => {
      stopped = true;
      return undefined;
    });
    await failedStart;
    await nextTurn();
    expect(stopped).toBe(false);
    await expect(session.startTurn("unsafe successor")).rejects.toThrow(
      "foreground turn is already active",
    );
    acknowledged.resolve({});
    await nextTurn();
    expect(stopped).toBe(false);
    codex.startsTurn({ threadId: "thread-1", turnId: "late-native" });
    await codex.waitForRequest("turn/interrupt");
    codex.says({ threadId: "thread-1", itemId: "late-output", text: "owned after timeout" });
    codex.completeTurn({ turnId: "late-native", status: "interrupted" });
    await interrupt;
    const canceled = events.find((event) => event.type === "turn_canceled");
    expect(canceled?.turnId).toBe("codex-turn-0");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        turnId: canceled?.turnId,
        item: expect.objectContaining({ type: "assistant_message", text: "owned after timeout" }),
      }),
    );
    expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(1);
    codex.assertNoErrors();
  } finally {
    acknowledged.resolve({});
    await session.close();
  }
});

test("Codex close certifies an already-exited provider after draining its output", async () => {
  const codex = createFakeCodexAppServer();
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => codex.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.startTurn("survive provider exit");
  codex.startsTurn({ threadId: "thread-1", turnId: "native-exiting" });
  codex.child.signalCode = "SIGKILL";
  codex.child.emit("exit", null, "SIGKILL");
  codex.says({ threadId: "thread-1", itemId: "last", text: "buffered before exit" });
  codex.child.stdout.end();
  codex.child.stderr.end();
  codex.child.emit("close", null, "SIGKILL");
  await session.close();
  await session.close();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "timeline",
      item: expect.objectContaining({ type: "assistant_message", text: "buffered before exit" }),
    }),
  );
  codex.assertNoErrors();
});

test("Codex interrupt waits for the accepted turn's terminal output after RPC acknowledgement", async () => {
  const codex = createFakeCodexAppServer({ "turn/interrupt": () => ({}) });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => codex.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const { turnId } = await session.startTurn("wait for cancellation");
    codex.startsTurn({ threadId: "thread-1", turnId: "turn-1" });
    let stopped = false;
    const interrupt = session.interrupt().then(() => {
      stopped = true;
      return undefined;
    });
    await codex.waitForRequest("turn/interrupt");
    await nextTurn();
    expect(stopped).toBe(false);
    codex.completeTurn({ turnId: "older-turn", status: "interrupted" });
    await nextTurn();
    expect(stopped).toBe(false);
    expect(events.filter((event) => event.type === "turn_canceled")).toEqual([]);
    codex.says({ threadId: "thread-1", itemId: "last", text: "before confirmed stop" });
    codex.completeTurn({ turnId: "turn-1", status: "interrupted" });
    await interrupt;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        turnId,
        item: expect.objectContaining({ type: "assistant_message", text: "before confirmed stop" }),
      }),
    );
    expect(events.filter((event) => event.type === "turn_canceled")).toEqual([
      { type: "turn_canceled", provider: "codex", reason: "interrupted", turnId },
    ]);
    codex.assertNoErrors();
  } finally {
    await session.close();
  }
});

test("Codex close keeps final notifications attached to the original accepted turn", async () => {
  const codex = createFakeCodexAppServer();
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => codex.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const { turnId } = await session.startTurn("wait for final output");
  codex.startsTurn({ threadId: "thread-1", turnId: "native-owned-turn" });
  codex.child.kill = () => {
    queueMicrotask(() => {
      codex.child.signalCode = "SIGTERM";
      codex.child.emit("exit", null, "SIGTERM");
      codex.says({ threadId: "thread-1", itemId: "final-message", text: "last owned words" });
      codex.child.stdout.end();
      codex.child.stderr.end();
      codex.child.emit("close", null, "SIGTERM");
    });
    return true;
  };
  const close = session.close();
  expect(session.close()).toBe(close);
  await close;
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "timeline",
      turnId,
      item: expect.objectContaining({ type: "assistant_message", text: "last owned words" }),
    }),
  );
  await session.close();
  codex.assertNoErrors();
});
