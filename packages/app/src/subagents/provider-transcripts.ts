import type {
  DaemonClient,
  FetchProviderSubagentTimelineOptions,
} from "@getpaseo/client/internal/daemon-client";
import { TimelineRequestError } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage, ProviderSubagentTarget } from "@getpaseo/protocol/messages";
import {
  planTimelineCatchUpAfter,
  planTimelineOlderFetch,
  planTimelineTailFetch,
} from "@/timeline/timeline-sync-plan";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";

export type ProviderSubagentClient = Pick<
  DaemonClient,
  | "fetchProviderSubagentTimeline"
  | "listProviderSubagents"
  | "subscribeProviderSubagentTimeline"
  | "subscribeConnectionStatus"
>;

export interface TranscriptClock {
  schedule(callback: () => void, delay: number): () => void;
}
const transcriptClock: TranscriptClock = {
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

interface HostOwner {
  clock: TranscriptClock;
  client: ProviderSubagentClient;
  generation: number;
  lists: Map<string, Promise<void>>;
  transcripts: Map<string, TranscriptOwner>;
}
const hosts = new Map<string, HostOwner>();

/** Client replacement invalidates every outstanding request, while retaining painted history. */
export function bindProviderSubagentHost(
  serverId: string,
  client: ProviderSubagentClient,
  generation: number,
  clock: TranscriptClock = transcriptClock,
): void {
  const previous = hosts.get(serverId);
  if (previous?.client === client && previous.generation === generation) return;
  if (previous) for (const owner of previous.transcripts.values()) owner.dispose();
  if (previous) useProviderSubagentStore.getState().clearHostErrors(serverId);
  hosts.set(serverId, { client, generation, clock, lists: new Map(), transcripts: new Map() });
}

export function clearProviderSubagentHost(serverId: string): void {
  const previous = hosts.get(serverId);
  hosts.delete(serverId);
  if (previous) for (const owner of previous.transcripts.values()) owner.dispose();
  useProviderSubagentStore.getState().clearHost(serverId);
}

export function refreshProviderSubagents(
  client: Pick<DaemonClient, "listProviderSubagents">,
  serverId: string,
  parentAgentId: string,
): Promise<void> {
  const host = hosts.get(serverId);
  if (!host || host.client !== client) return Promise.resolve();
  const pending = host.lists.get(parentAgentId);
  if (pending) return pending;
  const request = client
    .listProviderSubagents(parentAgentId)
    .then((payload) => {
      if (hosts.get(serverId) === host)
        useProviderSubagentStore.getState().replaceList(serverId, parentAgentId, payload.subagents);
      return;
    })
    .finally(() => host.lists.delete(parentAgentId));
  host.lists.set(parentAgentId, request);
  return request;
}

export function applyProviderSubagentDescriptorUpdate(
  serverId: string,
  client: ProviderSubagentClient,
  payload: Extract<SessionOutboundMessage, { type: "agent.provider_subagents.update" }>["payload"],
): void {
  const host = hosts.get(serverId);
  if (!host || host.client !== client || payload.kind === "timeline") return;
  if (payload.kind === "remove") {
    host.transcripts.get(JSON.stringify([payload.parentAgentId, payload.subagentId]))?.invalidate();
  }
  useProviderSubagentStore.getState().applyUpdate(serverId, payload);
}

class TranscriptOwner {
  references = 0;
  private disposed = false;
  private online = false;
  private membershipReady = false;
  private connectionEpoch = 0;
  private pending: Promise<void> | null = null;
  private reconcileAgain = false;
  private retryTimer: (() => void) | undefined;
  private retryDelay = 1000;
  private subscription:
    | ReturnType<ProviderSubagentClient["subscribeProviderSubagentTimeline"]>
    | undefined;
  private unsubscribeConnection: () => void = () => {};

  constructor(
    private readonly serverId: string,
    private readonly host: HostOwner,
    private readonly target: ProviderSubagentTarget,
  ) {
    this.subscription = host.client.subscribeProviderSubagentTimeline(
      target,
      (message) => {
        if (!this.current()) return;
        const state = this.state();
        const previousEpoch = state?.cursor?.epoch ?? state?.failedPage?.epoch;
        const replacement =
          message.payload.kind === "timeline" &&
          message.payload.seq === 1 &&
          previousEpoch !== undefined &&
          previousEpoch !== message.payload.epoch;
        if (replacement) this.invalidate();
        if (
          useProviderSubagentStore.getState().applyUpdate(serverId, message.payload) ||
          replacement
        )
          this.reconcile();
      },
      () => {
        this.membershipReady = true;
        this.clearRetry();
        this.reconcile();
      },
      (error) => {
        this.membershipReady = false;
        this.failed(error);
      },
    );
    this.unsubscribeConnection = host.client.subscribeConnectionStatus((state) => {
      const online = state.status === "connected";
      if (online === this.online) return;
      this.online = online;
      if (!online) this.membershipReady = false;
      this.connectionEpoch += 1;
      this.clearRetry();
      if (online) this.reconcile();
    });
  }

  private current(): boolean {
    return !this.disposed && hosts.get(this.serverId) === this.host;
  }
  private state() {
    return useProviderSubagentStore
      .getState()
      .timelines.get(
        providerSubagentKey(this.serverId, this.target.parentAgentId, this.target.subagentId),
      );
  }
  private clearRetry(): void {
    this.retryTimer?.();
    this.retryTimer = undefined;
  }

  reconcile(): void {
    if (!this.current() || !this.online || !this.membershipReady) return;
    if (this.retryTimer || this.state()?.failedPage?.code === "TIMELINE_ITEM_TOO_LARGE") {
      this.reconcileAgain = true;
      return;
    }
    if (this.pending) {
      this.reconcileAgain = true;
      return;
    }
    this.clearRetry();
    void this.fetch(planTimelineTailFetch());
  }

  loadOlder(): Promise<void> {
    const state = this.state();
    if (
      !this.current() ||
      !this.online ||
      !this.membershipReady ||
      this.pending ||
      this.retryTimer ||
      state?.failedPage?.code === "TIMELINE_ITEM_TOO_LARGE" ||
      !state?.hasOlder ||
      !state.cursor
    )
      return Promise.resolve();
    return this.fetch(
      planTimelineOlderFetch({ epoch: state.cursor.epoch, seq: state.cursor.startSeq }),
    );
  }

  private fetch(request: FetchProviderSubagentTimelineOptions): Promise<void> {
    const epoch = this.connectionEpoch;
    let failedRequest = request;
    const work = async () => {
      let next: FetchProviderSubagentTimelineOptions | null = request;
      while (next && this.current() && this.online && epoch === this.connectionEpoch) {
        failedRequest = next;
        const payload = await this.host.client.fetchProviderSubagentTimeline(
          this.target.parentAgentId,
          this.target.subagentId,
          next,
        );
        if (!this.current() || !this.online || epoch !== this.connectionEpoch) return;
        const catchUp = useProviderSubagentStore.getState().replaceTimeline(this.serverId, payload);
        const cursor = this.state()?.cursor;
        next =
          catchUp && cursor
            ? planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq })
            : null;
      }
      this.retryDelay = 1000;
    };
    const pending = work()
      .catch((error: unknown) => {
        if (!this.current() || !this.online || epoch !== this.connectionEpoch) return;
        this.failed(error, failedRequest);
      })
      .finally(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        if (this.reconcileAgain) {
          this.reconcileAgain = false;
          this.reconcile();
        }
      });
    this.pending = pending;
    return pending;
  }

  private failed(error: unknown, request?: FetchProviderSubagentTimelineOptions): void {
    if (!this.current()) return;
    const code = error instanceof TimelineRequestError ? error.code : undefined;
    const retainedTerminal =
      !request && this.state()?.failedPage?.code === "TIMELINE_ITEM_TOO_LARGE";
    if (code !== "TIMELINE_BUSY" && !retainedTerminal) {
      useProviderSubagentStore
        .getState()
        .setTimelineError(
          this.serverId,
          this.target.parentAgentId,
          this.target.subagentId,
          error instanceof Error ? error.message : String(error),
          {
            code,
            epoch: error instanceof TimelineRequestError ? error.epoch : undefined,
            request: request ?? planTimelineTailFetch(),
          },
        );
    }
    this.reconcileAgain = false;
    this.clearRetry();
    if (code === "TIMELINE_ITEM_TOO_LARGE") return;
    // Match the main timeline retry policy. A failed membership ACK owns its retry too.
    this.retryTimer = this.host.clock.schedule(() => {
      if (!this.current() || !this.online) return;
      this.clearRetry();
      if (this.membershipReady && !retainedTerminal)
        void this.fetch(request ?? planTimelineTailFetch());
      else this.refreshSubscription();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }

  retry(): void {
    if (!this.current() || !this.online || this.pending) return;
    this.clearRetry();
    if (!this.membershipReady) {
      this.refreshSubscription();
      return;
    }
    void this.fetch(this.state()?.failedPage?.request ?? planTimelineTailFetch());
  }

  private refreshSubscription(): void {
    void this.subscription?.refresh().catch(() => undefined);
  }

  invalidate(): void {
    this.connectionEpoch += 1;
    this.reconcileAgain = false;
    this.clearRetry();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    this.subscription?.();
    this.unsubscribeConnection();
  }
}

/** One host-owned replica and network interest per child, shared by duplicate panes. */
export function observeProviderSubagent(
  serverId: string,
  client: ProviderSubagentClient,
  target: ProviderSubagentTarget,
): { release(): void; loadOlder(): Promise<void>; retry(): void } | null {
  const host = hosts.get(serverId);
  if (!host || host.client !== client) return null;
  const key = JSON.stringify([target.parentAgentId, target.subagentId]);
  let owner = host.transcripts.get(key);
  if (!owner) {
    owner = new TranscriptOwner(serverId, host, target);
    host.transcripts.set(key, owner);
  }
  owner.references += 1;
  const transcript = owner;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      transcript.references -= 1;
      if (transcript.references === 0) {
        transcript.dispose();
        host.transcripts.delete(key);
      }
    },
    loadOlder: () => transcript.loadOlder(),
    retry: () => transcript.retry(),
  };
}
