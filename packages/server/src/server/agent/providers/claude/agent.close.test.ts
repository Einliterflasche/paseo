import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function queryStream() {
  const entered = deferred<void>();
  let pending = deferred<IteratorResult<SDKMessage, void>>();
  let ended = false;
  let onClose = () => {};
  const query = {
    next: () => {
      entered.resolve();
      return ended ? Promise.resolve({ done: true, value: undefined }) : pending.promise;
    },
    return: async () => {
      ended = true;
      pending.resolve({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
    interrupt: async () => {},
    close: () => onClose(),
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setPermissionMode: async () => {},
    setModel: async () => {},
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
  return {
    query,
    entered: entered.promise,
    onClose: (callback: () => void) => {
      onClose = callback;
    },
    emit: (message: SDKMessage) => {
      const previous = pending;
      pending = deferred();
      previous.resolve({ done: false, value: message });
    },
    fail: (error: Error) => pending.reject(error),
  };
}

test("Claude close preserves final SDK output and its accepted turn identity", async () => {
  const stream = queryStream();
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => stream.query,
    resolveBinary: async () => process.execPath,
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const { turnId } = await session.startTurn("waiting for output");
  await stream.entered;
  stream.onClose(() =>
    stream.emit({
      type: "assistant",
      uuid: "late-message",
      session_id: "closing-session",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "late words" }] },
    } as SDKMessage),
  );
  const close = session.close();
  expect(session.close()).toBe(close);
  await close;
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "timeline",
      turnId,
      item: expect.objectContaining({ type: "assistant_message", text: "late words" }),
    }),
  );
});

test("Claude close rejects a failed output drain instead of reporting a paused runtime", async () => {
  const stream = queryStream();
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => stream.query,
    resolveBinary: async () => process.execPath,
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  await session.startTurn("waiting");
  await stream.entered;
  stream.onClose(() => stream.fail(new Error("stream decoder failed during close")));
  await expect(session.close()).rejects.toThrow("stream decoder failed during close");
  await expect(session.startTurn("replacement")).rejects.toThrow("session is closed");
});

test("Claude retries an unconfirmed process stop and memoizes only its successful certification", async () => {
  const stream = queryStream();
  let child: ChildProcess | undefined;
  let stopAttempts = 0;
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => process.execPath,
    queryFactory: ({ options }) => {
      child = options.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      }) as ChildProcess;
      return stream.query;
    },
    terminateProcess: async (target) => {
      stopAttempts += 1;
      if (stopAttempts === 1) return "kill-timeout";
      if (child!.exitCode === null && child!.signalCode === null) {
        const exit = once(child!, "exit");
        target.kill("SIGTERM");
        await exit;
      }
      await stream.query.return(undefined);
      return "terminated";
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  try {
    await session.startTurn("waiting");
    await stream.entered;
    await expect(session.close()).rejects.toThrow("did not report exit");
    await session.close();
    await session.close();
    expect(stopAttempts).toBe(2);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  }
});

test.skipIf(process.platform === "win32").each(["SIGTERM", "nonzero exit"])(
  "real Claude SDK drains %s output before close certifies cessation",
  async (exitMode) => {
    const fixture = fileURLToPath(new URL("./test-utils/closing-runtime.cjs", import.meta.url));
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => process.execPath,
      runtimeSettings: { command: { mode: "replace", argv: [process.execPath, fixture] } },
    });
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    const ready = deferred<void>();
    session.subscribe((event) => {
      events.push(event);
      if (
        event.type === "timeline" &&
        event.item.type === "assistant_message" &&
        event.item.text === "ready to stop"
      )
        ready.resolve();
    });
    try {
      const { turnId } = await session.startTurn(
        exitMode === "nonzero exit" ? "exit nonzero on shutdown" : "hold this turn",
      );
      await ready.promise;
      await session.close();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          turnId,
          item: expect.objectContaining({
            type: "assistant_message",
            text: "final stdout before exit",
          }),
        }),
      );
      await session.close();
    } finally {
      await session.close();
    }
  },
);

test("Claude cannot spawn after close overtakes asynchronous launch preparation", async () => {
  const binary = deferred<string>();
  const preparing = deferred<void>();
  let spawned = 0;
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: () => {
      preparing.resolve();
      return binary.promise;
    },
    queryFactory: () => {
      spawned += 1;
      return queryStream().query;
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const starting = session.startTurn("accepted before close");
  await preparing.promise;
  await session.close();
  binary.resolve(process.execPath);
  await starting;
  expect(spawned).toBe(0);
});

test("Claude interrupt waits for the result and preserves output after acknowledgement", async () => {
  const stream = queryStream();
  const acknowledgement = deferred<void>();
  stream.query.interrupt = () => acknowledgement.promise;
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => stream.query,
    resolveBinary: async () => process.execPath,
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const delivered = deferred<void>();
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "timeline" && event.item.type === "assistant_message") delivered.resolve();
  });
  const { turnId } = await session.startTurn("stop this turn");
  await stream.entered;
  let settled = false;
  const interrupt = session.interrupt().then(() => {
    settled = true;
    return undefined;
  });
  acknowledgement.resolve();
  stream.emit({
    type: "assistant",
    uuid: "interrupt-tail",
    session_id: "session",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "last output" }] },
  } as SDKMessage);
  await delivered.promise;
  expect(settled).toBe(false);
  expect(events).toContainEqual(
    expect.objectContaining({
      turnId,
      type: "timeline",
      item: expect.objectContaining({ type: "assistant_message", text: "last output" }),
    }),
  );
  await expect(session.startTurn("premature replacement")).rejects.toThrow("still stopping");
  stream.emit({
    type: "result",
    subtype: "error_during_execution",
    terminal_reason: "aborted_streaming",
    errors: ["Request was aborted."],
    session_id: "session",
  } as SDKMessage);
  await interrupt;
  expect(events.filter((event) => event.type === "turn_canceled")).toEqual([
    { type: "turn_canceled", provider: "claude", turnId, reason: "Interrupted" },
  ]);
  await session.close();
});

test("Claude preserves a result-only success and usage when completion wins the Stop race", async () => {
  const stream = queryStream();
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => stream.query,
    resolveBinary: async () => process.execPath,
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const { turnId } = await session.startTurn("/usage");
  await stream.entered;
  const interrupt = session.interrupt();
  stream.emit({
    type: "result",
    subtype: "success",
    terminal_reason: "completed",
    session_id: "session",
    uuid: "result-only",
    result: "final usage report",
    usage: { input_tokens: 17, output_tokens: 0 },
  } as SDKMessage);
  await interrupt;
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "timeline",
      turnId,
      item: expect.objectContaining({ type: "assistant_message", text: "final usage report" }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: "turn_completed", turnId, usage: expect.any(Object) }),
  );
  expect(events.filter((event) => event.type === "turn_canceled")).toEqual([]);
  await session.close();
});

test.each(["interrupt", "close"] as const)(
  "Claude preserves native failure while %s is pending",
  async (operation) => {
    const stream = queryStream();
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: () => stream.query,
      resolveBinary: async () => process.execPath,
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("receive genuine failure");
    await stream.entered;
    const message = {
      type: "result",
      subtype: "error_during_execution",
      terminal_reason: "api_error",
      errors: ["database transaction aborted"],
      session_id: "session",
    } as SDKMessage;
    if (operation === "close") stream.onClose(() => stream.emit(message));
    const stopping = session[operation]();
    if (operation === "interrupt") stream.emit(message);
    await stopping;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn_failed",
        turnId,
        error: "database transaction aborted",
      }),
    );
    expect(events.filter((event) => event.type === "turn_canceled")).toEqual([]);
    await session.close();
  },
);

test("Claude recognizes structured tool abort during close without treating its diagnostic as failure", async () => {
  const stream = queryStream();
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => stream.query,
    resolveBinary: async () => process.execPath,
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const { turnId } = await session.startTurn("hold tool until shutdown");
  await stream.entered;
  stream.onClose(() =>
    stream.emit({
      type: "result",
      subtype: "error_during_execution",
      terminal_reason: "aborted_tools",
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      session_id: "session",
    } as SDKMessage),
  );
  await session.close();
  expect(events.filter((event) => event.type === "turn_canceled")).toEqual([
    { type: "turn_canceled", provider: "claude", turnId, reason: "Interrupted" },
  ]);
  expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
});

test("Claude interrupt fences a startup paused in binary discovery", async () => {
  const binary = deferred<string>();
  const stream = queryStream();
  const prompts: unknown[] = [];
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: () => binary.promise,
    queryFactory: ({ prompt }) => {
      if (typeof prompt !== "string") {
        void (async () => {
          for await (const message of prompt) prompts.push(message);
        })();
      }
      return stream.query;
    },
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const startup = session.startTurn("must never run");
  const interrupt = session.interrupt();
  binary.resolve(process.execPath);
  const { turnId } = await startup;
  await interrupt;
  expect(prompts).toEqual([]);
  expect(events.filter((event) => event.type === "turn_canceled")).toEqual([
    { type: "turn_canceled", provider: "claude", turnId, reason: "Interrupted" },
  ]);
  await session.close();
});

test("Claude rejects an uncertain interrupt and retries without discarding its owner", async () => {
  const stream = queryStream();
  stream.query.interrupt = async () => {
    throw new Error("interrupt transport failed");
  };
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => stream.query,
    resolveBinary: async () => process.execPath,
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.startTurn("still active");
  await stream.entered;
  await expect(session.interrupt()).rejects.toThrow("interrupt transport failed");
  expect(events.some((event) => event.type === "turn_canceled")).toBe(false);
  stream.query.interrupt = async () => {};
  const retry = session.interrupt();
  stream.emit({
    type: "result",
    subtype: "error_during_execution",
    terminal_reason: "aborted_streaming",
    errors: ["Request was aborted."],
    session_id: "session",
  } as SDKMessage);
  await retry;
  expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(1);
  await session.close();
});

test("real Claude SDK certifies a process which exited before close", async () => {
  const fixture = fileURLToPath(new URL("./test-utils/closing-runtime.cjs", import.meta.url));
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => process.execPath,
    runtimeSettings: { command: { mode: "replace", argv: [process.execPath, fixture] } },
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const terminal = deferred<void>();
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "turn_failed") terminal.resolve();
  });
  try {
    const { turnId } = await session.startTurn("exit before close");
    await terminal.promise;
    await session.close();
    await session.close();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        turnId,
        item: expect.objectContaining({
          type: "assistant_message",
          text: "final output before natural exit",
        }),
      }),
    );
  } finally {
    await session.close();
  }
});
