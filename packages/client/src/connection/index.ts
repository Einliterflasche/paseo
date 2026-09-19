import type { ProviderSubagentTarget, SessionEventSubscription } from "@getpaseo/protocol/messages";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";

// Protocol support belongs to the installed client. Only browser hosting needs
// a resource supplied by the caller. Keep this exhaustive as the protocol evolves.
export const DEFAULT_CLIENT_CAPABILITIES = {
  [CLIENT_CAPS.allProviders]: true,
  [CLIENT_CAPS.selectiveAgentTimeline]: true,
  [CLIENT_CAPS.reasoningMergeEnum]: true,
  [CLIENT_CAPS.customModeIcons]: true,
  [CLIENT_CAPS.terminalReflowableSnapshot]: true,
  [CLIENT_CAPS.providerSubagents]: true,
  [CLIENT_CAPS.projectedProviderSubagents]: true,
  [CLIENT_CAPS.projectUpdates]: true,
  [CLIENT_CAPS.compactProviderSnapshots]: true,
  [CLIENT_CAPS.providerSnapshotReferences]: true,
  [CLIENT_CAPS.timelineReplacementInvalidation]: true,
  [CLIENT_CAPS.timelineNotifications]: true,
  [CLIENT_CAPS.pluginTimelineItems]: true,
  [CLIENT_CAPS.workspaceSetupBlocked]: true,
  [CLIENT_CAPS.explicitEventSubscriptions]: true,
  [CLIENT_CAPS.servicePreview]: 1,
} satisfies Record<Exclude<ClientCapability, typeof CLIENT_CAPS.browserHost>, true | 1>;

/** Calling releases demand; ready acknowledges the initial daemon membership. */
export type TimelineSubscription = (() => void) & { readonly ready: Promise<void> };
export type ProviderSubagentTimelineSubscription = TimelineSubscription & {
  refresh(): Promise<void>;
};

class TimelineInterest {
  private acknowledgedGeneration = -1;
  private active = true;
  resolve!: () => void;
  reject!: (error: unknown) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  constructor(
    private readonly onReady?: () => void,
    private readonly onError?: (error: unknown) => void,
  ) {
    // Readiness is optional for fire-and-forget listeners.
    void this.ready.catch(() => {});
  }
  acknowledge(generation: number): void {
    if (!this.active) return;
    this.resolve();
    if (this.acknowledgedGeneration === generation) return;
    this.acknowledgedGeneration = generation;
    this.onReady?.();
  }
  fail(error: unknown): void {
    if (!this.active) return;
    this.acknowledgedGeneration = -1;
    this.reject(error);
    this.onError?.(error);
  }
  release(error: Error): void {
    this.active = false;
    this.reject(error);
  }
}

/** Owns connection demand, independently of individual facades and React lifetimes. */
export class ConnectionSubscriptions {
  private generation = 0;
  private viewed = new Set<string>();
  private timelines = new Map<string, Set<TimelineInterest>>();
  private childTimelines = new Map<
    string,
    { target: ProviderSubagentTarget; interests: Set<TimelineInterest> }
  >();
  private events: SessionEventSubscription[] = [];

  constructor(
    private readonly send: {
      timelines(
        agentIds: string[],
        providerSubagents: ProviderSubagentTarget[],
      ): Promise<void> | null;
      events(events: SessionEventSubscription[]): Promise<void>;
      failed(error: unknown): void;
    },
  ) {}

  private agentIds(): string[] {
    return [...new Set([...this.viewed, ...this.timelines.keys()])].sort();
  }

  setViewed(agentIds: string[]): Promise<void> {
    this.viewed = new Set(agentIds);
    return this.syncTimelines();
  }

  observeTimeline(agentId: string): TimelineSubscription {
    const interests = this.timelines.get(agentId) ?? new Set<TimelineInterest>();
    this.timelines.set(agentId, interests);
    return this.observe(interests, () => this.timelines.delete(agentId));
  }

  observeProviderSubagent(
    target: ProviderSubagentTarget,
    onReady?: () => void,
    onError?: (error: unknown) => void,
  ): ProviderSubagentTimelineSubscription {
    const key = JSON.stringify([target.parentAgentId, target.subagentId]);
    const entry = this.childTimelines.get(key) ?? {
      target: { ...target },
      interests: new Set<TimelineInterest>(),
    };
    this.childTimelines.set(key, entry);
    const release = this.observe(
      entry.interests,
      () => this.childTimelines.delete(key),
      onReady,
      onError,
    );
    return Object.assign(release, { refresh: () => this.syncTimelines() });
  }

  private observe(
    interests: Set<TimelineInterest>,
    remove: () => void,
    onReady?: () => void,
    onError?: (error: unknown) => void,
  ): TimelineSubscription {
    const interest = new TimelineInterest(onReady, onError);
    interests.add(interest);
    void this.syncTimelines().catch(this.send.failed);
    let active = true;
    return Object.assign(
      () => {
        if (!active) return;
        active = false;
        interest.release(new Error("Timeline subscription released before it was ready"));
        interests.delete(interest);
        if (interests.size === 0) {
          remove();
          void this.syncTimelines().catch(this.send.failed);
        }
      },
      { ready: interest.ready },
    );
  }

  private async syncTimelines(): Promise<void> {
    const generation = this.generation;
    const interests: TimelineInterest[] = [];
    for (const listeners of this.timelines.values()) {
      for (const interest of listeners) interests.push(interest);
    }
    try {
      for (const entry of this.childTimelines.values()) {
        for (const interest of entry.interests) interests.push(interest);
      }
      const sent = this.send.timelines(
        this.agentIds(),
        [...this.childTimelines.values()].map(({ target }) => target),
      );
      if (!sent) return;
      await sent;
      if (this.generation === generation)
        for (const interest of interests) interest.acknowledge(generation);
    } catch (error) {
      if (this.generation === generation) for (const interest of interests) interest.fail(error);
      throw error;
    }
  }

  setEvents(events: SessionEventSubscription[]): void {
    if (JSON.stringify(this.events) === JSON.stringify(events)) return;
    this.events = events;
    void this.send.events(events).catch(this.send.failed);
  }

  restore(): void {
    this.generation += 1;
    if (this.agentIds().length || this.childTimelines.size)
      void this.syncTimelines().catch(this.send.failed);
    if (this.events.length) void this.send.events(this.events).catch(this.send.failed);
  }

  close(): void {
    for (const { interests } of this.childTimelines.values()) {
      for (const interest of interests) interest.release(new Error("Daemon client closed"));
    }
    for (const interests of this.timelines.values()) {
      for (const interest of interests) interest.release(new Error("Daemon client closed"));
    }
  }
}
