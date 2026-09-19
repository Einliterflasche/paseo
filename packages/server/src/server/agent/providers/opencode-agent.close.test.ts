import { ProviderInitializationCleanupError } from "../provider-initialization-cleanup-error.js";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentProbeContext, AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function setup() {
  const runtime = new TestOpenCodeHarness();
  const sdk = new TestOpenCodeClient();
  runtime.enqueueClient(sdk);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
  return { runtime, sdk, session, client };
}

test("OpenCode keeps subscriptions while abort is pending and retries a rejected abort", async () => {
  const { runtime, sdk, session } = await setup();
  sdk.sessionPromptAsyncEvents = [];
  const events: AgentStreamEvent[] = [];
  const delivered = deferred<void>();
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "usage_updated") delivered.resolve();
  });
  const { turnId } = await session.startTurn("waiting");
  const abort = deferred<{ error: Error }>();
  sdk.sessionAbortImplementation = () => abort.promise;
  const close = session.close();
  expect(session.close()).toBe(close);
  sdk.emitEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "late-usage",
        sessionID: "session-1",
        messageID: "last-assistant",
        type: "step-finish",
        tokens: { input: 100, output: 20, cache: { read: 50 } },
      },
    },
  });
  await delivered.promise;
  expect(events).toContainEqual(expect.objectContaining({ type: "usage_updated", turnId }));
  expect(runtime.acquisitions[0]?.releaseCount).toBe(0);
  abort.resolve({ error: new Error("provider abort failed") });
  await expect(close).rejects.toThrow("Failed to abort");
  expect(runtime.acquisitions[0]?.releaseCount).toBe(0);
  sdk.sessionAbortImplementation = async () => ({});
  await session.close();
  await session.close();
  expect(sdk.calls.sessionAbort).toHaveLength(2);
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
});

test("OpenCode requires runner idle evidence after abort acknowledgement", async () => {
  const { runtime, sdk, session } = await setup();
  const observed = deferred<void>();
  const status = deferred<{ data: Record<string, unknown> }>();
  sdk.sessionStatusImplementation = () => {
    observed.resolve();
    return status.promise;
  };
  const close = session.close();
  await observed.promise;
  expect(runtime.acquisitions[0]?.releaseCount).toBe(0);
  status.resolve({ data: {} });
  await close;
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
});

test("OpenCode transfers its unreleased acquisition when session creation fails", async () => {
  class FailingReleaseHarness extends TestOpenCodeHarness {
    failure: Error | null = new Error("server termination unconfirmed");
    override async acquireCurrent() {
      const acquisition = await super.acquireCurrent();
      return {
        ...acquisition,
        release: async () => {
          if (this.failure) throw this.failure;
          await acquisition.release();
        },
      };
    }
  }
  const runtime = new FailingReleaseHarness();
  const sdk = new TestOpenCodeClient();
  sdk.sessionCreateResponse = { error: new Error("session creation failed") };
  runtime.enqueueClient(sdk);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const failure = await client
    .createSession({ provider: "opencode", cwd: "/workspace/repo" })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ProviderInitializationCleanupError);
  if (!(failure instanceof ProviderInitializationCleanupError))
    throw new Error("Missing cleanup owner");
  expect(runtime.acquisitions[0]?.releaseCount).toBe(0);
  runtime.failure = null;
  await failure.cleanup.close();
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
});

test.each(["completed", "constructor failed", "nested cleanup failed"] as const)(
  "OpenCode command probes retain temporary cleanup when %s",
  async (outcome) => {
    class FailingReleaseHarness extends TestOpenCodeHarness {
      failure: Error | null = new Error("probe server stop unconfirmed");
      override async acquireCurrent() {
        const acquisition = await super.acquireCurrent();
        return {
          ...acquisition,
          release: async () => {
            if (this.failure) throw this.failure;
            await acquisition.release();
          },
        };
      }
    }
    const runtime = new FailingReleaseHarness();
    let previousOwnerClosed = 0;
    const constructorFailure = new Error("SDK construction failed");
    const previousFailure = new ProviderInitializationCleanupError(
      {
        close: async () => {
          previousOwnerClosed += 1;
        },
      },
      constructorFailure,
      new Error("previous owner stop unconfirmed"),
    );
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: (options) => {
        if (outcome === "constructor failed") throw constructorFailure;
        if (outcome === "nested cleanup failed") throw previousFailure;
        return runtime.createClient(options);
      },
    });
    const failure = await client
      .listCommands({ provider: "opencode", cwd: "/workspace/repo" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderInitializationCleanupError);
    if (!(failure instanceof ProviderInitializationCleanupError))
      throw new Error("Missing probe cleanup owner");
    if (outcome === "constructor failed")
      expect(failure.initializationError).toBe(constructorFailure);
    if (outcome === "nested cleanup failed")
      expect(failure.initializationError).toBe(previousFailure);
    expect(runtime.acquisitions[0]?.releaseCount).toBe(0);
    runtime.failure = null;
    await failure.cleanup.close();
    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
    expect(previousOwnerClosed).toBe(outcome === "nested cleanup failed" ? 1 : 0);
  },
);

test("OpenCode catalog abort after acquisition preserves a failed release owner", async () => {
  class FailingReleaseHarness extends TestOpenCodeHarness {
    failure: Error | null = new Error("catalog server stop unconfirmed");
    override async acquireCurrent() {
      const acquisition = await super.acquireCurrent();
      return {
        ...acquisition,
        release: async () => {
          if (this.failure) throw this.failure;
          await acquisition.release();
        },
      };
    }
  }
  const runtime = new FailingReleaseHarness();
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const controller = new AbortController();
  const expired = new Error("catalog deadline expired after acquisition");
  const failure = await client
    .fetchCatalog(
      { scope: "workspace", cwd: "/workspace/repo" },
      {
        signal: controller.signal,
        runActivity: async (_name, operation) => {
          const result = await operation();
          controller.abort(expired);
          controller.signal.throwIfAborted();
          return result;
        },
      },
    )
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ProviderInitializationCleanupError);
  if (!(failure instanceof ProviderInitializationCleanupError))
    throw new Error("Missing catalog cleanup owner");
  expect(failure.initializationError).toBe(expired);
  expect(runtime.clientCreations).toEqual([]);
  runtime.failure = null;
  await failure.cleanup.close();
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
});

test.each(["commands", "catalog", "history"] as const)(
  "OpenCode %s probe owns pending acquisition before a recovery abort",
  async (kind) => {
    const ready = deferred<void>();
    class PendingAcquireHarness extends TestOpenCodeHarness {
      override async acquireCurrent() {
        const acquisition = await super.acquireCurrent();
        await ready.promise;
        return acquisition;
      }
    }
    const runtime = new PendingAcquireHarness();
    const controller = new AbortController();
    const owners = new Set<{ close(): Promise<void> }>();
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const probe = startReadProbe(kind, client, {
      signal: controller.signal,
      own: (owner) => {
        owners.add(owner);
        return () => {
          owners.delete(owner);
        };
      },
    });
    const rejection = expect(probe).rejects.toThrow("recovery freeze");
    expect(owners.size).toBe(1);
    controller.abort(new Error("recovery freeze"));
    const stop = Promise.all([...owners].map((owner) => owner.close()));
    expect(runtime.acquisitions[0]?.releaseCount).toBe(0);
    ready.resolve();
    await stop;
    await rejection;
    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
    expect(runtime.clientCreations).toEqual([]);
    expect(owners.size).toBe(0);
  },
);

test.each(["commands", "catalog", "history"] as const)(
  "OpenCode %s probe forwards cancellation and retains ownership through SDK settlement",
  async (kind) => {
    const runtime = new TestOpenCodeHarness();
    const controller = new AbortController();
    const entered = deferred<void>();
    const owners = new Set<{ close(): Promise<void> }>();
    const waitForCancellation = async (signal?: AbortSignal | null): Promise<never> => {
      if (!signal) throw new Error("Probe signal was not forwarded");
      entered.resolve();
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: (options) => {
        const sdk = runtime.createClient(options);
        return {
          ...sdk,
          command: {
            ...sdk.command,
            list: async (_parameters, requestOptions) =>
              waitForCancellation(requestOptions?.signal),
          },
          provider: {
            ...sdk.provider,
            list: async (_parameters, requestOptions) =>
              waitForCancellation(requestOptions?.signal),
          },
          experimental: {
            ...sdk.experimental,
            session: {
              ...sdk.experimental.session,
              list: async (_parameters, requestOptions) =>
                waitForCancellation(requestOptions?.signal),
            },
          },
        };
      },
    });
    const probe = startReadProbe(kind, client, {
      signal: controller.signal,
      own: (owner) => {
        owners.add(owner);
        return () => {
          owners.delete(owner);
        };
      },
    });
    const rejection = expect(probe).rejects.toThrow("query canceled for recovery");
    await entered.promise;
    expect(owners.size).toBe(1);
    controller.abort(new Error("query canceled for recovery"));
    await Promise.all([...owners].map((owner) => owner.close()));
    await rejection;
    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
    expect(owners.size).toBe(0);
  },
);

test("OpenCode keeps late output ownership when final server release fails", async () => {
  class FailingReleaseHarness extends TestOpenCodeHarness {
    failure: Error | null = new Error("final server stop unconfirmed");
    override async acquireCurrent() {
      const acquisition = await super.acquireCurrent();
      return {
        ...acquisition,
        release: async () => {
          if (this.failure) throw this.failure;
          await acquisition.release();
        },
      };
    }
  }
  const runtime = new FailingReleaseHarness();
  const sdk = new TestOpenCodeClient();
  sdk.sessionPromptAsyncEvents = [];
  runtime.enqueueClient(sdk);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
  const events: AgentStreamEvent[] = [];
  const delivered = deferred<void>();
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "usage_updated") delivered.resolve();
  });
  const { turnId } = await session.startTurn("waiting for final output");
  await expect(session.close()).rejects.toThrow("final server stop unconfirmed");
  sdk.emitEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "after-release-failure",
        sessionID: "session-1",
        messageID: "last-assistant",
        type: "step-finish",
        tokens: { input: 123, output: 45, cache: { read: 0 } },
      },
    },
  });
  await delivered.promise;
  expect(events.filter((event) => event.type === "usage_updated")).toEqual([
    expect.objectContaining({
      turnId,
      usage: expect.objectContaining({ inputTokens: 123, outputTokens: 45 }),
    }),
  ]);
  runtime.failure = null;
  await session.close();
  await session.close();
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
});

test("OpenCode seals ingress after release and drains a second accepted handler before clearing output", async () => {
  const runtime = new TestOpenCodeHarness();
  const sdk = new TestOpenCodeClient();
  runtime.enqueueClient(sdk);
  const subscribe = runtime.events.subscribe;
  let unsubscribeCount = 0;
  runtime.events.subscribe = (listener) => {
    const unsubscribe = subscribe(listener);
    return () => {
      unsubscribeCount += 1;
      unsubscribe();
    };
  };
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  const first = deferred<{ data: unknown[] }>();
  const second = deferred<{ data: unknown[] }>();
  let requests = 0;
  sdk.questionListImplementation = () => {
    requests += 1;
    if (requests === 1) {
      firstEntered.resolve();
      return first.promise;
    }
    secondEntered.resolve();
    return second.promise;
  };
  const question = (id: string) => ({
    id,
    sessionID: "session-1",
    questions: [{ question: "Preserve this output?", header: id, options: [] }],
  });

  sdk.emitEvent({ type: "server.connected", properties: {} });
  await firstEntered.promise;
  let closed = false;
  const close = session.close().then(() => {
    closed = true;
    return undefined;
  });
  await vi.waitFor(() => expect(sdk.calls.sessionStatus).toHaveLength(1));
  // The first accepted handler is still blocking the initial output drain.
  // Appending another handler must extend the work close is responsible for.
  sdk.emitEvent({ type: "server.connected", properties: {} });
  first.resolve({ data: [question("first-before-stop")] });
  await secondEntered.promise;
  await vi.waitFor(() => expect(unsubscribeCount).toBe(1));
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
  expect(closed).toBe(false);

  // Once native stop is certified, this event cannot extend the sealed queue.
  sdk.emitEvent({ type: "server.connected", properties: {} });
  second.resolve({ data: [question("second-before-stop")] });
  await close;
  expect(requests).toBe(2);
  expect(
    events.flatMap((event) => (event.type === "permission_requested" ? [event.request.id] : [])),
  ).toEqual(["first-before-stop", "second-before-stop"]);
  await session.close();
  expect(unsubscribeCount).toBe(1);
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
});

test("OpenCode close joins subscription-started hydration and preserves its accepted snapshot", async () => {
  const { runtime, sdk, session } = await setup();
  sdk.sessionChildrenResponses = [
    { data: [{ id: "closing-child", parentID: "session-1", directory: "/workspace/repo" }] },
    { data: [] },
  ];
  const reading = deferred<void>();
  const messages = deferred<{ data: unknown[] }>();
  sdk.sessionMessagesImplementation = () => {
    reading.resolve();
    return messages.promise;
  };
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await reading.promise;
  let closed = false;
  const close = session.close().then(() => {
    closed = true;
    return undefined;
  });
  await vi.waitFor(() => expect(runtime.acquisitions[0]?.releaseCount).toBe(1));
  expect(closed).toBe(false);
  messages.resolve({
    data: [
      {
        info: {
          id: "snapshot-message",
          sessionID: "closing-child",
          role: "assistant",
          time: { created: 1, completed: 2 },
        },
        parts: [
          {
            id: "snapshot-part",
            sessionID: "closing-child",
            messageID: "snapshot-message",
            type: "text",
            text: "accepted snapshot survives close",
            time: { start: 1, end: 2 },
          },
        ],
      },
    ],
  });
  await close;
  expect(
    events.filter((event) => event.type === "provider_subagent" && event.event.type === "timeline"),
  ).toEqual([
    expect.objectContaining({
      type: "provider_subagent",
      event: expect.objectContaining({
        id: "closing-child",
        type: "timeline",
        item: expect.objectContaining({
          type: "assistant_message",
          text: "accepted snapshot survives close",
        }),
      }),
    }),
  ]);
  const delivered = events.length;
  sdk.emitEvent({ type: "server.connected", properties: {} });
  await session.close();
  expect(events).toHaveLength(delivered);
});

test("OpenCode close joins the external status read started by subscription", async () => {
  const { runtime, sdk, session: parent, client } = await setup();
  const childRegistered = deferred<void>();
  parent.subscribe((event) => {
    if (
      event.type === "provider_subagent" &&
      event.event.type === "upsert" &&
      event.event.id === "external-closing-child"
    )
      childRegistered.resolve();
  });
  sdk.emitEvent({
    type: "session.created",
    properties: {
      info: { id: "external-closing-child", parentID: "session-1", directory: "/workspace/repo" },
    },
  });
  await childRegistered.promise;
  const childSdk = new TestOpenCodeClient();
  runtime.enqueueClient(childSdk);
  const reading = deferred<void>();
  const status = deferred<{ data: Record<string, unknown> }>();
  let reads = 0;
  childSdk.sessionStatusImplementation = () => {
    reads += 1;
    if (reads === 1) {
      reading.resolve();
      return status.promise;
    }
    return Promise.resolve({ data: {} });
  };
  const child = await client.resumeSession({
    provider: "opencode",
    sessionId: "external-closing-child",
    metadata: { cwd: "/workspace/repo" },
  });
  child.subscribe(() => undefined);
  await reading.promise;
  let closed = false;
  const close = child.close().then(() => {
    closed = true;
    return undefined;
  });
  await vi.waitFor(() => expect(runtime.acquisitions[1]?.releaseCount).toBe(1));
  expect(closed).toBe(false);
  status.resolve({ data: {} });
  await close;
  expect(reads).toBe(2);
  await parent.close();
});

test("OpenCode interruption does not certify the old two-second acknowledgement cap", async () => {
  const { sdk, session } = await setup();
  sdk.sessionPromptAsyncEvents = [];
  await session.startTurn("long tool");
  const abortStarted = deferred<void>();
  const abort = deferred<{ data: boolean }>();
  sdk.sessionAbortImplementation = () => {
    abortStarted.resolve();
    return abort.promise;
  };
  vi.useFakeTimers();
  try {
    let settled = false;
    const interrupt = session.interrupt().then(() => {
      settled = true;
      return undefined;
    });
    await abortStarted.promise;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(settled).toBe(false);
    sdk.emitEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
    abort.resolve({ data: true });
    await interrupt;
  } finally {
    vi.useRealTimers();
    await session.close();
  }
});

test("OpenCode cannot dispatch an accepted startup after interrupt completes", async () => {
  const { runtime, sdk, session } = await setup();
  const readyEntered = deferred<void>();
  const ready = deferred<void>();
  runtime.events.ready = () => {
    readyEntered.resolve();
    return ready.promise;
  };
  const startup = session.startTurn("must never be sent");
  const rejection = expect(startup).rejects.toThrow("canceled before dispatch");
  await readyEntered.promise;
  await session.interrupt();
  ready.resolve();
  await rejection;
  expect(sdk.calls.sessionPromptAsync).toEqual([]);
  expect(sdk.calls.sessionCommand).toEqual([]);
  await session.close();
});

test("OpenCode orders abort after an already-written prompt reaches its dispatch boundary", async () => {
  const { sdk, session } = await setup();
  const dispatch = deferred<{ data: boolean }>();
  const entered = deferred<void>();
  sdk.sessionPromptAsyncEvents = [];
  sdk.sessionPromptAsyncImplementation = () => {
    entered.resolve();
    return dispatch.promise;
  };
  await session.startTurn("pending dispatch");
  await entered.promise;
  const interrupt = session.interrupt();
  await Promise.resolve();
  expect(sdk.calls.sessionAbort).toHaveLength(0);
  dispatch.resolve({ data: true });
  await interrupt;
  expect(sdk.calls.sessionAbort).toHaveLength(1);
  await session.close();
});

test("OpenCode close certifies an already-exited server without requiring a remote abort", async () => {
  const { runtime, sdk, session } = await setup();
  sdk.sessionPromptAsyncEvents = [];
  await session.startTurn("server will exit");
  const failed = deferred<void>();
  session.subscribe((event) => {
    if (event.type === "turn_failed") failed.resolve();
  });
  sdk.emitEvent({ type: "server-exited", error: new Error("server exited") });
  await failed.promise;
  sdk.sessionAbortImplementation = async () => {
    throw new Error("dead server is unreachable");
  };
  await session.close();
  await session.close();
  expect(sdk.calls.sessionAbort).toEqual([]);
  expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
});

function startReadProbe(
  kind: "commands" | "catalog" | "history",
  client: OpenCodeAgentClient,
  probe: AgentProbeContext,
): Promise<unknown> {
  if (kind === "commands")
    return client.listCommands({ provider: "opencode", cwd: "/workspace/repo" }, probe);
  if (kind === "history") return client.listImportableSessions({ cwd: "/workspace/repo" }, probe);
  return client.fetchCatalog(
    { scope: "workspace", cwd: "/workspace/repo" },
    {
      signal: probe.signal,
      probe,
      runActivity: async (_name, operation) => operation(),
    },
  );
}
