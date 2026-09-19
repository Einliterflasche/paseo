import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { applyStreamEvent } from "@/types/stream";
import type { StreamItem } from "@/types/stream";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type {
  FetchProviderSubagentTimelineOptions,
  TimelineRequestErrorCode,
} from "@getpaseo/client/internal/daemon-client";

import {
  processAgentStreamEvent,
  processTimelineResponse,
  type TimelineCursor,
} from "@/timeline/session-stream-reducers";

export interface ProviderSubagentTimelineState {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | undefined;
  hasAuthoritativeBaseline: boolean;
  hasOlder: boolean;
  error: string | null;
  failedPage?: {
    code?: TimelineRequestErrorCode;
    epoch?: string;
    request: FetchProviderSubagentTimelineOptions;
  };
}

interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  hiddenFromTrack: Set<string>;
  clearHost(serverId: string): void;
  clearHostErrors(serverId: string): void;
  setTimelineError(
    serverId: string,
    parentAgentId: string,
    subagentId: string,
    error: string | null,
    failedPage?: ProviderSubagentTimelineState["failedPage"],
  ): void;
  hideFromTrack(serverId: string, parentAgentId: string, subagentIds: readonly string[]): void;
  replaceList(
    serverId: string,
    parentAgentId: string,
    subagents: ProviderSubagentDescriptorPayload[],
  ): void;
  applyUpdate(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.update" }
    >["payload"],
  ): boolean;
  replaceTimeline(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.timeline.get.response" }
    >["payload"],
  ): boolean;
}

export function providerSubagentKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${subagentId}`;
}

export function providerSubagentLifecycleStatus(
  status: ProviderSubagentDescriptorPayload["status"],
): AgentLifecycleStatus {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  cursor: undefined,
  hasAuthoritativeBaseline: false,
  error: null,
  hasOlder: false,
};

function providerSubagentTerminalEvent(
  subagent: ProviderSubagentDescriptorPayload,
): AgentStreamEventPayload | null {
  if (subagent.status === "running") {
    return null;
  }
  if (subagent.status === "failed") {
    return { type: "turn_failed", provider: subagent.provider, error: "Subagent failed" };
  }
  if (subagent.status === "canceled") {
    return { type: "turn_canceled", provider: subagent.provider, reason: "canceled" };
  }
  return { type: "turn_completed", provider: subagent.provider };
}

function applyTerminal(
  current: ProviderSubagentTimelineState,
  descriptor?: ProviderSubagentDescriptorPayload,
): ProviderSubagentTimelineState {
  const event = descriptor ? providerSubagentTerminalEvent(descriptor) : null;
  if (!event || !descriptor) return current;
  const next = applyStreamEvent({
    tail: current.tail,
    head: current.head,
    event,
    timestamp: new Date(descriptor.updatedAt),
  });
  return { ...current, tail: next.tail, head: next.head };
}

export const useProviderSubagentStore = create<ProviderSubagentState>((set) => ({
  descriptors: new Map(),
  timelines: new Map(),
  hiddenFromTrack: new Set(),
  clearHost(serverId) {
    const prefix = `${serverId}\0`;
    set((state) => ({
      descriptors: new Map([...state.descriptors].filter(([key]) => !key.startsWith(prefix))),
      timelines: new Map([...state.timelines].filter(([key]) => !key.startsWith(prefix))),
      hiddenFromTrack: new Set([...state.hiddenFromTrack].filter((key) => !key.startsWith(prefix))),
    }));
  },
  clearHostErrors(serverId) {
    set((state) => ({
      timelines: new Map(
        [...state.timelines].map(([key, value]) => [
          key,
          key.startsWith(`${serverId}\0`)
            ? { ...value, error: null, failedPage: undefined }
            : value,
        ]),
      ),
    }));
  },
  setTimelineError(serverId, parentAgentId, subagentId, error, failedPage) {
    const key = providerSubagentKey(serverId, parentAgentId, subagentId);
    set((state) => ({
      timelines: new Map(state.timelines).set(key, {
        ...(state.timelines.get(key) ?? EMPTY_TIMELINE),
        error,
        failedPage,
      }),
    }));
  },
  hideFromTrack(serverId, parentAgentId, subagentIds) {
    set((state) => {
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagentId of subagentIds) {
        const key = providerSubagentKey(serverId, parentAgentId, subagentId);
        if (state.descriptors.get(key)?.status !== "running") hiddenFromTrack.add(key);
      }
      return { hiddenFromTrack };
    });
  },
  replaceList(serverId, parentAgentId, subagents) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const descriptors = new Map(
        [...state.descriptors].filter(([key]) => !key.startsWith(prefix)),
      );
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        descriptors.set(key, subagent);
        if (subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
      }
      const retainedKeys = new Set(descriptors.keys());
      const timelines = new Map(
        [...state.timelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
      );
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        const current = timelines.get(key);
        const previous = state.descriptors.get(key);
        if (current && previous?.status !== subagent.status) {
          timelines.set(key, applyTerminal(current, subagent));
        }
      }
      return { descriptors, timelines, hiddenFromTrack };
    });
  },
  applyUpdate(serverId, payload) {
    let catchUp = false;
    set((state) => {
      if (payload.kind === "upsert") {
        const key = providerSubagentKey(
          serverId,
          payload.subagent.parentAgentId,
          payload.subagent.id,
        );
        const descriptors = new Map(state.descriptors);
        const hiddenFromTrack = new Set(state.hiddenFromTrack);
        const previous = descriptors.get(key);
        descriptors.set(key, payload.subagent);
        if (payload.subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
        let timelines = state.timelines;
        const current = state.timelines.get(key);
        if (current && previous?.status !== payload.subagent.status) {
          timelines = new Map(state.timelines);
          timelines.set(key, applyTerminal(current, payload.subagent));
        }
        return { descriptors, timelines, hiddenFromTrack };
      }
      if (payload.kind === "remove") {
        const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
        const descriptors = new Map(state.descriptors);
        descriptors.delete(key);
        const timelines = new Map(state.timelines);
        timelines.delete(key);
        return { descriptors, timelines };
      }
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const current = state.timelines.get(key) ?? EMPTY_TIMELINE;
      const next = processAgentStreamEvent({
        event: { type: "timeline", provider: payload.provider, item: payload.item },
        seq: payload.seq,
        epoch: payload.epoch,
        currentTail: current.tail,
        currentHead: current.head,
        currentCursor: current.cursor,
        hasAuthoritativeBaseline: current.hasAuthoritativeBaseline,
        timestamp: new Date(payload.timestamp),
      });
      catchUp =
        next.sideEffects.length > 0 || !current.cursor || current.cursor.epoch !== payload.epoch;
      const timelines = new Map(state.timelines);
      timelines.set(
        key,
        applyTerminal(
          {
            ...current,
            tail: next.tail,
            head: next.head,
            cursor: next.cursor ?? current.cursor,
            hasOlder:
              next.cursor && current.cursor?.epoch !== next.cursor.epoch ? false : current.hasOlder,
            ...(payload.seq === 1 &&
            current.failedPage?.epoch &&
            current.failedPage.epoch !== payload.epoch
              ? { error: null, failedPage: undefined }
              : {}),
          },
          state.descriptors.get(key),
        ),
      );
      return { timelines };
    });
    return catchUp;
  },
  replaceTimeline(serverId, payload) {
    if (
      payload.projection !== "projected" ||
      !payload.entries ||
      payload.startCursor === undefined ||
      payload.endCursor === undefined
    ) {
      throw new Error("Host did not return a projected child timeline");
    }
    const entries = payload.entries;
    const startCursor = payload.startCursor;
    const endCursor = payload.endCursor;
    let catchUp = false;
    set((state) => {
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const current = state.timelines.get(key) ?? EMPTY_TIMELINE;
      const next = processTimelineResponse({
        payload: {
          ...payload,
          projection: "projected",
          agentId: payload.subagentId,
          entries,
          startCursor,
          endCursor,
        },
        currentTail: current.tail,
        currentHead: current.head,
        currentCursor: current.cursor,
        isInitializing: !current.hasAuthoritativeBaseline,
        hasActiveInitDeferred: !current.hasAuthoritativeBaseline,
        initRequestDirection: "tail",
        sendingClientMessageIds: [],
      });
      catchUp =
        next.sideEffects.some((effect) => effect.type === "catch_up") ||
        (payload.direction === "after" && payload.hasNewer);
      if (next.commit === "discard")
        return current.error === null
          ? state
          : {
              timelines: new Map(state.timelines).set(key, {
                ...current,
                error: null,
                failedPage: undefined,
              }),
            };
      const timelines = new Map(state.timelines);
      let hasOlder = next.older === "unchanged" ? current.hasOlder : next.older === "available";
      if (!current.cursor && payload.direction === "tail") hasOlder = payload.hasOlder;
      timelines.set(
        key,
        applyTerminal(
          {
            tail: next.tail,
            head: next.head,
            cursor: next.cursor ?? undefined,
            hasAuthoritativeBaseline: true,
            hasOlder,
            error: next.error,
          },
          state.descriptors.get(key),
        ),
      );
      return { timelines };
    });
    return catchUp;
  },
}));
