import { afterEach, expect, test } from "vitest";
import type {
  ConnectionState,
  FetchProviderSubagentTimelineOptions,
  ProviderSubagentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import { TimelineRequestError } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  applyProviderSubagentDescriptorUpdate,
  bindProviderSubagentHost,
  clearProviderSubagentHost,
  observeProviderSubagent,
  refreshProviderSubagents,
  type ProviderSubagentClient,
  type TranscriptClock,
} from "./provider-transcripts";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";

type Update = Extract<SessionOutboundMessage, { type: "agent.provider_subagents.update" }>;
const target = { parentAgentId: "parent", subagentId: "child" };
const key = providerSubagentKey("host", target.parentAgentId, target.subagentId);

function page(text: string, seq = 1): ProviderSubagentTimelinePayload {
  return {
    requestId: "page",
    ...target,
    provider: "codex",
    direction: "tail",
    projection: "projected",
    epoch: "epoch",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 },
    hasOlder: seq > 1,
    hasNewer: false,
    rows: [],
    startCursor: { epoch: "epoch", seq },
    endCursor: { epoch: "epoch", seq },
    error: null,
    entries: [
      {
        provider: "codex",
        item: { type: "assistant_message", text },
        timestamp: "2026-09-19T00:00:00.000Z",
        seqStart: seq,
        seqEnd: seq,
        sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        collapsed: [],
      },
    ],
  };
}
function harness() {
  const pending: Array<{
    options: FetchProviderSubagentTimelineOptions;
    resolve(payload: ProviderSubagentTimelinePayload): void;
    reject(error: Error): void;
  }> = [];
  const listeners = new Set<(message: Update) => void>();
  const acknowledgements = new Set<() => void>();
  const failures = new Set<(error: unknown) => void>();
  let refreshes = 0;
  const connections = new Set<(state: ConnectionState) => void>();
  let state: ConnectionState = { status: "connected" };
  let finishList:
    | ((payload: Awaited<ReturnType<ProviderSubagentClient["listProviderSubagents"]>>) => void)
    | undefined;
  const client: ProviderSubagentClient = {
    fetchProviderSubagentTimeline(_parent, _child, options = {}) {
      return new Promise((resolve, reject) => pending.push({ options, resolve, reject }));
    },
    listProviderSubagents() {
      return new Promise((resolve) => {
        finishList = resolve;
      });
    },
    subscribeProviderSubagentTimeline(_target, listener, onReady, onError) {
      listeners.add(listener);
      if (onError) failures.add(onError);
      if (onReady) acknowledgements.add(onReady);
      onReady?.();
      return Object.assign(
        () => {
          listeners.delete(listener);
          if (onError) failures.delete(onError);
          if (onReady) acknowledgements.delete(onReady);
        },
        {
          ready: Promise.resolve(),
          refresh: async () => {
            refreshes += 1;
            for (const callback of acknowledgements) callback();
          },
        },
      );
    },
    subscribeConnectionStatus(listener) {
      connections.add(listener);
      listener(state);
      return () => {
        connections.delete(listener);
      };
    },
  };
  return {
    client,
    pending,
    listeners,
    refreshes: () => refreshes,
    fail: (error: unknown) => {
      for (const callback of failures) callback(error);
    },
    acknowledge: () => {
      for (const callback of acknowledgements) callback();
    },
    finishList: (payload: Parameters<NonNullable<typeof finishList>>[0]) => finishList!(payload),
    connection(next: ConnectionState) {
      state = next;
      for (const listener of connections) listener(next);
    },
  };
}
async function settled() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
async function completeBootstrap(h: ReturnType<typeof harness>, text: string, seq = 1, index = 0) {
  h.pending[index]!.resolve(page(text, seq));
  await settled();
  expect(h.pending[index + 1]?.options).toMatchObject({
    direction: "after",
    projection: "projected",
    cursor: { epoch: "epoch", seq },
  });
  h.pending[index + 1]!.resolve({
    ...page(text, seq),
    direction: "after",
    entries: [],
    startCursor: null,
    endCursor: null,
    hasNewer: false,
  });
  await settled();
}
afterEach(() => clearProviderSubagentHost("host"));

test("host removal fences pending transcript and descriptor fetches", async () => {
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1);
  const owner = observeProviderSubagent("host", h.client, target)!;
  const list = refreshProviderSubagents(h.client, "host", "parent");
  clearProviderSubagentHost("host");
  h.pending[0]!.resolve(page("must not return"));
  h.finishList({
    requestId: "list",
    parentAgentId: "parent",
    subagents: [
      {
        id: "child",
        parentAgentId: "parent",
        provider: "codex",
        title: null,
        description: null,
        status: "running",
        createdAt: "now",
        updatedAt: "now",
        toolCallId: null,
      },
    ],
    error: null,
  });
  await list;
  await settled();
  expect(useProviderSubagentStore.getState().timelines.size).toBe(0);
  expect(useProviderSubagentStore.getState().descriptors.size).toBe(0);
  expect(h.listeners.size).toBe(0);
  owner.release();
});

test("hidden panes release transcript demand, retain paint and reconcile on reopening", async () => {
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1);
  const first = observeProviderSubagent("host", h.client, target)!;
  const duplicate = observeProviderSubagent("host", h.client, target)!;
  expect(h.listeners.size).toBe(1);
  expect(h.pending).toHaveLength(1);
  await completeBootstrap(h, "first");
  const painted = useProviderSubagentStore.getState().timelines.get(key);
  first.release();
  expect(h.listeners.size).toBe(1);
  duplicate.release();
  expect(h.listeners.size).toBe(0);
  expect(useProviderSubagentStore.getState().timelines.get(key)).toBe(painted);
  const reopened = observeProviderSubagent("host", h.client, target)!;
  expect(h.pending).toHaveLength(3);
  h.pending[2]!.resolve(page("latest", 40));
  await settled();
  const current = useProviderSubagentStore.getState().timelines.get(key)!;
  expect(current.cursor).toMatchObject({ startSeq: 40, endSeq: 40 });
  expect([...current.tail, ...current.head]).toEqual([expect.objectContaining({ text: "latest" })]);
  expect(current).not.toHaveProperty("rows");
  reopened.release();
});

test("client replacement rejects an old response without replacing current paint", async () => {
  const old = harness();
  const current = harness();
  bindProviderSubagentHost("host", old.client, 1);
  const previous = observeProviderSubagent("host", old.client, target)!;
  bindProviderSubagentHost("host", current.client, 2);
  const owner = observeProviderSubagent("host", current.client, target)!;
  await completeBootstrap(current, "current");
  const painted = useProviderSubagentStore.getState().timelines.get(key);
  old.pending[0]!.resolve(page("stale"));
  await settled();
  expect(useProviderSubagentStore.getState().timelines.get(key)).toBe(painted);
  expect(old.listeners.size).toBe(0);
  previous.release();
  owner.release();
});

test("reconnect discards the old connection's pending page and fetches a current tail", async () => {
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1);
  const owner = observeProviderSubagent("host", h.client, target)!;
  h.connection({ status: "disconnected" });
  h.connection({ status: "connected" });
  h.pending[0]!.resolve(page("old socket"));
  await settled();
  expect(useProviderSubagentStore.getState().timelines.has(key)).toBe(false);
  expect(h.pending).toHaveLength(1);
  h.acknowledge();
  expect(h.pending).toHaveLength(2);
  await completeBootstrap(h, "new socket", 1, 1);
  expect(useProviderSubagentStore.getState().timelines.get(key)?.cursor).toMatchObject({
    endSeq: 1,
  });
  owner.release();
});

test("a rejected subscription ACK stays visible and retries membership before fetching", async () => {
  const timers = new Map<() => void, number>();
  const clock: TranscriptClock = {
    schedule(callback, delay) {
      timers.set(callback, delay);
      return () => {
        timers.delete(callback);
      };
    },
  };
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1, clock);
  const owner = observeProviderSubagent("host", h.client, target)!;
  await completeBootstrap(h, "painted");
  h.connection({ status: "disconnected" });
  h.connection({ status: "connected" });
  h.fail(new Error("Subscription was refused"));
  expect(useProviderSubagentStore.getState().timelines.get(key)?.error).toBe(
    "Subscription was refused",
  );
  expect(h.pending).toHaveLength(2);
  expect([...timers.values()]).toEqual([1000]);
  const callbacks = Array.from(timers.keys());
  for (const callback of callbacks) callback();
  await settled();
  expect(h.refreshes()).toBe(1);
  expect(h.pending).toHaveLength(3);
  h.pending[2]!.resolve(page("painted"));
  await settled();
  expect(useProviderSubagentStore.getState().timelines.get(key)?.error).toBeNull();
  owner.release();
});

test("a child removal fences its pending reply while preserving interest for a later replay", async () => {
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1);
  const owner = observeProviderSubagent("host", h.client, target)!;
  applyProviderSubagentDescriptorUpdate("host", h.client, { kind: "remove", ...target });
  h.pending[0]!.resolve(page("removed history"));
  await settled();
  expect(useProviderSubagentStore.getState().timelines.has(key)).toBe(false);
  expect(h.listeners.size).toBe(1);
  for (const listener of h.listeners)
    listener({
      type: "agent.provider_subagents.update",
      payload: {
        kind: "timeline",
        ...target,
        provider: "codex",
        epoch: "epoch",
        seq: 2,
        timestamp: "2026-09-19T00:00:00.000Z",
        item: { type: "assistant_message", text: "replayed" },
      },
    });
  expect(h.pending).toHaveLength(2);
  await completeBootstrap(h, "replayed", 2, 1);
  expect(useProviderSubagentStore.getState().timelines.get(key)?.cursor?.endSeq).toBe(2);
  owner.release();
});

test("a busy older child page retries its exact request without an error callout", async () => {
  const timers = new Map<() => void, number>();
  const clock: TranscriptClock = {
    schedule(callback, delay) {
      timers.set(callback, delay);
      return () => {
        timers.delete(callback);
      };
    },
  };
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1, clock);
  const owner = observeProviderSubagent("host", h.client, target)!;
  await completeBootstrap(h, "current", 20);
  const older = owner.loadOlder();
  expect(h.pending[2]!.options).toMatchObject({
    direction: "before",
    cursor: { epoch: "epoch", seq: 20 },
  });
  h.pending[2]!.reject(new TimelineRequestError("socket busy", "TIMELINE_BUSY"));
  await older;
  expect(useProviderSubagentStore.getState().timelines.get(key)?.error).toBeNull();
  expect([...timers.values()]).toEqual([1000]);
  const callbacks = Array.from(timers.keys());
  for (const callback of callbacks) callback();
  expect(h.pending[3]!.options).toEqual(h.pending[2]!.options);
  h.pending[3]!.resolve({
    ...page("older", 19),
    direction: "before",
    window: { minSeq: 1, maxSeq: 20, nextSeq: 21 },
  });
  await settled();
  expect(useProviderSubagentStore.getState().timelines.get(key)?.cursor).toMatchObject({
    startSeq: 19,
    endSeq: 20,
  });
  expect(timers.size).toBe(0);
  owner.release();
});

test("an oversized child page stays terminal through hide and reconnect until manually retried", async () => {
  const timers = new Map<() => void, number>();
  const clock: TranscriptClock = {
    schedule(callback, delay) {
      timers.set(callback, delay);
      return () => {
        timers.delete(callback);
      };
    },
  };
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1, clock);
  const owner = observeProviderSubagent("host", h.client, target)!;
  await completeBootstrap(h, "current", 20);
  const older = owner.loadOlder();
  h.pending[2]!.reject(
    new TimelineRequestError("Timeline row 19 is too large", "TIMELINE_ITEM_TOO_LARGE", "epoch"),
  );
  await older;
  expect(timers.size).toBe(0);
  h.connection({ status: "disconnected" });
  h.connection({ status: "connected" });
  h.acknowledge();
  owner.release();
  const reopened = observeProviderSubagent("host", h.client, target)!;
  expect(h.pending).toHaveLength(3);
  expect(useProviderSubagentStore.getState().timelines.get(key)?.error).toContain("row 19");
  reopened.retry();
  expect(h.pending[3]!.options).toEqual(h.pending[2]!.options);
  h.pending[3]!.resolve({
    ...page("older", 19),
    direction: "before",
    window: { minSeq: 1, maxSeq: 20, nextSeq: 21 },
  });
  await settled();
  expect(useProviderSubagentStore.getState().timelines.get(key)?.error).toBeNull();
  expect(h.pending[4]!.options.direction).toBe("tail");
  h.pending[4]!.resolve(page("current", 20));
  await settled();
  expect(timers.size).toBe(0);
  reopened.release();
});

test("an authoritative child epoch replacement releases an obsolete terminal failure", async () => {
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1);
  const owner = observeProviderSubagent("host", h.client, target)!;
  h.pending[0]!.reject(
    new TimelineRequestError("old row too large", "TIMELINE_ITEM_TOO_LARGE", "epoch"),
  );
  await settled();
  for (const listener of h.listeners)
    listener({
      type: "agent.provider_subagents.update",
      payload: {
        kind: "timeline",
        ...target,
        provider: "codex",
        epoch: "replacement",
        seq: 1,
        timestamp: "2026-09-19T00:00:00.000Z",
        item: { type: "assistant_message", text: "replacement" },
      },
    });
  expect(h.pending).toHaveLength(2);
  const replacement = {
    ...page("replacement"),
    epoch: "replacement",
    startCursor: { epoch: "replacement", seq: 1 },
    endCursor: { epoch: "replacement", seq: 1 },
  };
  h.pending[1]!.resolve(replacement);
  await settled();
  h.pending[2]!.resolve({
    ...replacement,
    direction: "after",
    entries: [],
    startCursor: null,
    endCursor: null,
  });
  await settled();
  expect(useProviderSubagentStore.getState().timelines.get(key)?.error).toBeNull();
  expect(useProviderSubagentStore.getState().timelines.get(key)?.cursor?.epoch).toBe("replacement");
  owner.release();
});

test("replacing the host client releases an obsolete child page failure", async () => {
  const old = harness();
  bindProviderSubagentHost("host", old.client, 1);
  const previous = observeProviderSubagent("host", old.client, target)!;
  old.pending[0]!.reject(
    new TimelineRequestError("old transport capacity", "TIMELINE_ITEM_TOO_LARGE", "epoch"),
  );
  await settled();
  const current = harness();
  bindProviderSubagentHost("host", current.client, 2);
  const owner = observeProviderSubagent("host", current.client, target)!;
  expect(current.pending).toHaveLength(1);
  expect(useProviderSubagentStore.getState().timelines.get(key)?.error).toBeNull();
  await completeBootstrap(current, "new connection");
  previous.release();
  owner.release();
});

test("a child epoch replacement cancels busy backoff for an obsolete older page", async () => {
  const timers = new Map<() => void, number>();
  const clock: TranscriptClock = {
    schedule(callback, delay) {
      timers.set(callback, delay);
      return () => {
        timers.delete(callback);
      };
    },
  };
  const h = harness();
  bindProviderSubagentHost("host", h.client, 1, clock);
  const owner = observeProviderSubagent("host", h.client, target)!;
  await completeBootstrap(h, "old epoch", 20);
  const older = owner.loadOlder();
  h.pending[2]!.reject(new TimelineRequestError("busy", "TIMELINE_BUSY", "epoch"));
  await older;
  expect(timers.size).toBe(1);
  for (const listener of h.listeners)
    listener({
      type: "agent.provider_subagents.update",
      payload: {
        kind: "timeline",
        ...target,
        provider: "codex",
        epoch: "replacement",
        seq: 1,
        timestamp: "2026-09-19T00:00:00.000Z",
        item: { type: "assistant_message", text: "new epoch" },
      },
    });
  expect(timers.size).toBe(0);
  expect(h.pending[3]!.options.direction).toBe("tail");
  h.pending[3]!.resolve({
    ...page("new epoch"),
    epoch: "replacement",
    startCursor: { epoch: "replacement", seq: 1 },
    endCursor: { epoch: "replacement", seq: 1 },
  });
  await settled();
  expect(useProviderSubagentStore.getState().timelines.get(key)?.cursor?.epoch).toBe("replacement");
  expect([
    ...useProviderSubagentStore.getState().timelines.get(key)!.tail,
    ...useProviderSubagentStore.getState().timelines.get(key)!.head,
  ]).toEqual([expect.objectContaining({ text: "new epoch" })]);
  owner.release();
});
