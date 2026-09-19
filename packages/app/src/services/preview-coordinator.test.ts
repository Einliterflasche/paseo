import { describe, expect, it } from "vitest";
import {
  createPreviewCoordinator,
  type PreparedPreview,
  type PreviewClientPort,
  type PreviewClientSource,
  type PreviewLaunchOptions,
} from "./preview-coordinator";
import { createPreviewProfile, type PreviewProfilePort } from "./preview-profile";
import { deferred, waitForResult } from "./test-support";

const FIRST_HANDLE = "11111111-1111-4111-8111-111111111111";
const SECOND_HANDLE = "22222222-2222-4222-8222-222222222222";
type PrepareInput = Parameters<PreviewClientPort["prepareServicePreview"]>[0];
type PrepareReply = Awaited<ReturnType<PreviewClientPort["prepareServicePreview"]>>;
type CloseReply = Awaited<ReturnType<PreviewClientPort["closeServicePreview"]>>;

interface PendingPrepare {
  input: PrepareInput;
  reply: ReturnType<typeof deferred<PrepareReply>>;
}

interface PendingClose {
  attemptId: string;
  reply: ReturnType<typeof deferred<CloseReply>>;
}

class MemoryClient implements PreviewClientPort {
  readonly prepares: PendingPrepare[] = [];
  readonly closes: PendingClose[] = [];
  private ready = new Map<number, ReturnType<typeof deferred<PendingPrepare>>>();

  prepareServicePreview(input: PrepareInput): Promise<PrepareReply> {
    const pending = { input, reply: deferred<PrepareReply>() };
    const index = this.prepares.length;
    this.prepares.push(pending);
    this.ready.get(index)?.resolve(pending);
    return pending.reply.promise;
  }

  closeServicePreview(input: { attemptId: string }): Promise<CloseReply> {
    const pending = { ...input, reply: deferred<CloseReply>() };
    this.closes.push(pending);
    return pending.reply.promise;
  }

  waitForPrepare(index: number): Promise<PendingPrepare> {
    const pending = this.prepares[index];
    if (pending) return Promise.resolve(pending);
    const next = deferred<PendingPrepare>();
    this.ready.set(index, next);
    return next.promise;
  }
}

class MemoryProfile implements PreviewProfilePort {
  value: string | null = FIRST_HANDLE;
  readonly writes: string[] = [];
  error: Error | null = null;
  private held: ReturnType<typeof deferred<void>> | null = null;
  private tail: Promise<void> = Promise.resolve();

  read(): string | null {
    if (this.error) throw this.error;
    return this.value;
  }
  write(value: string): void {
    if (this.error) throw this.error;
    this.value = value;
    this.writes.push(value);
  }
  createId(): string {
    return SECOND_HANDLE;
  }
  holdNextLock() {
    const held = deferred<void>();
    this.held = held;
    return held;
  }
  lock<T>(work: () => T): Promise<T> {
    const held = this.held;
    this.held = null;
    const result = this.tail.then(async () => {
      if (held) await held.promise;
      return work();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface ScheduledExpiry {
  callback(): void;
  dueAt: number;
  cancelled: boolean;
  fired: boolean;
}

class ManualClock {
  private milliseconds = 1_000;
  readonly scheduled: ScheduledExpiry[] = [];

  now(): number {
    return this.milliseconds;
  }

  schedule({ delayMs, callback }: { delayMs: number; callback(): void }): () => void {
    const scheduled = {
      callback,
      dueAt: this.milliseconds + delayMs,
      cancelled: false,
      fired: false,
    };
    this.scheduled.push(scheduled);
    return () => {
      scheduled.cancelled = true;
    };
  }

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }

  pending(): ScheduledExpiry[] {
    return this.scheduled.filter((timer) => !timer.cancelled && !timer.fired);
  }

  wakeDue(): void {
    for (const timer of this.pending()) {
      if (timer.dueAt <= this.milliseconds) {
        timer.fired = true;
        timer.callback();
      }
    }
  }
}

function fixture({
  mode = "iframe",
  report = () => {},
  clock = new ManualClock(),
  client = new MemoryClient(),
  idPrefix = "attempt",
  reserveLaunch = false,
}: {
  mode?: "iframe" | "tab";
  report?: () => void | Promise<void>;
  clock?: ManualClock;
  client?: MemoryClient;
  idPrefix?: string;
  reserveLaunch?: boolean;
} = {}) {
  const profile = new MemoryProfile();
  const lifetime = new AbortController();
  const sources = new Set<() => void>();
  const launches: PreparedPreview[] = [];
  const launchOptions: PreviewLaunchOptions[] = [];
  const closeFailures: string[] = [];
  const initialSource: PreviewClientSource = { client, clientGeneration: 1, connectionEpoch: 1 };
  let source: PreviewClientSource | null = initialSource;
  let nextId = 0;
  let launchError: Error | null = null;
  const reservations: Array<{ attemptId: string; closed(): void; closeCount: number }> = [];
  const coordinator = createPreviewCoordinator({
    serviceId: "atlas",
    mode,
    clock,
    lifetime: lifetime.signal,
    profile: createPreviewProfile(profile),
    createId: () => `${idPrefix}-${++nextId}`,
    getSource: () => source,
    subscribeSource(listener) {
      sources.add(listener);
      return () => {
        sources.delete(listener);
      };
    },
    launch(ticket, options) {
      launches.push(ticket);
      launchOptions.push(options);
      if (launchError) throw launchError;
    },
    reserveLaunch: reserveLaunch
      ? ({ attemptId, closed }) => {
          const reservation = { attemptId, closed, closeCount: 0 };
          reservations.push(reservation);
          return {
            launch(ticket, options) {
              launches.push(ticket);
              launchOptions.push(options);
              if (launchError) throw launchError;
            },
            close() {
              reservation.closeCount += 1;
            },
          };
        }
      : undefined,
    onCloseFailure() {
      closeFailures.push("close-failed");
      return report();
    },
  });
  return {
    coordinator,
    clock,
    client,
    profile,
    lifetime,
    launches,
    launchOptions,
    closeFailures,
    initialSource,
    reservations,
    setLaunchError(error: Error | null) {
      launchError = error;
    },
    setSource(next: PreviewClientSource | null) {
      source = next;
      for (const listener of sources) listener();
    },
    sourceListeners: () => sources.size,
  };
}

function prepared(
  pending: PendingPrepare,
  overrides: Partial<PreparedPreview> = {},
): PreparedPreview {
  return {
    status: "prepared",
    attemptId: pending.input.attemptId,
    bootstrapId: `bootstrap-${pending.input.attemptId}`,
    ticket: `ticket-${pending.input.attemptId}`,
    serviceId: pending.input.serviceId,
    mode: pending.input.mode,
    ...overrides,
  };
}

function waitForState(
  coordinator: ReturnType<typeof createPreviewCoordinator>,
  accept: (state: ReturnType<typeof coordinator.getSnapshot>) => boolean,
) {
  return waitForResult(
    {
      getCurrentResult: coordinator.getSnapshot,
      subscribe(listener) {
        return coordinator.subscribe(() => listener(coordinator.getSnapshot()));
      },
    },
    accept,
  );
}

describe("preview open coordinator", () => {
  it("reserves a standalone tab on the original click and launches it as soon as Prepare completes", async () => {
    const { coordinator, client, launches, reservations } = fixture({
      mode: "tab",
      reserveLaunch: true,
    });
    try {
      const opening = coordinator.open();
      expect(reservations.map(({ attemptId }) => attemptId)).toEqual(["attempt-1"]);
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      expect(launches.map(({ attemptId }) => attemptId)).toEqual([pending.input.attemptId]);
      expect(coordinator.getSnapshot()).toEqual({ status: "open" });
    } finally {
      coordinator.close();
    }
  });

  it("releases standalone authority when the reserved browser tab closes", async () => {
    const { coordinator, client, reservations } = fixture({ mode: "tab", reserveLaunch: true });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      reservations[0]?.closed();
      expect(coordinator.getSnapshot()).toEqual({ status: "cancelling" });
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([pending.input.attemptId]);
      const closing = client.closes[0];
      closing?.reply.resolve({
        requestId: "close",
        result: { status: "closed", attemptId: pending.input.attemptId },
      });
      await waitForState(coordinator, (state) => state.status === "idle");
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
    } finally {
      coordinator.close();
    }
  });

  it("refuses an already-expired standalone ticket without launching or replaying", async () => {
    const { coordinator, client, launches } = fixture({ mode: "tab" });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      const ticket = { ...prepared(pending), expiresInMs: 0 };
      pending.reply.resolve({ result: ticket });
      await opening;
      coordinator.launch();
      expect(launches).toEqual([]);
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      expect(client.prepares).toHaveLength(1);
    } finally {
      coordinator.close();
    }
  });

  it("expires a ready standalone ticket from RPC start and waits for a fresh explicit Open", async () => {
    const { coordinator, client, clock, launches } = fixture({ mode: "tab" });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      clock.advance(20_000);
      pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
      await opening;
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      clock.advance(39_999);
      clock.wakeDue();
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      clock.advance(1);
      clock.wakeDue();
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      coordinator.launch();
      expect(launches).toEqual([]);
      expect(client.prepares).toHaveLength(1);
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([pending.input.attemptId]);

      const freshOpening = coordinator.open();
      const fresh = await client.waitForPrepare(1);
      expect(fresh.input.attemptId).not.toBe(pending.input.attemptId);
      fresh.reply.resolve({ result: { ...prepared(fresh), expiresInMs: 60_000 } });
      await freshOpening;
      coordinator.launch();
      expect(launches.map(({ attemptId }) => attemptId)).toEqual([fresh.input.attemptId]);
      expect(coordinator.getSnapshot()).toEqual({ status: "open" });
    } finally {
      coordinator.close();
    }
  });

  it("uses the approved 60-second lifetime when an older Prepare reply omits its duration", async () => {
    const { coordinator, client, clock, launches } = fixture({ mode: "tab" });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      clock.advance(15_000);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      clock.advance(44_999);
      clock.wakeDue();
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      clock.advance(1);
      clock.wakeDue();
      coordinator.launch();
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      expect(launches).toEqual([]);
      expect(client.prepares).toHaveLength(1);
    } finally {
      coordinator.close();
    }
  });

  it("reports failed expiry cleanup durably while leaving a fresh Open available", async () => {
    const reported = deferred<void>();
    const { coordinator, client, clock, closeFailures } = fixture({
      mode: "tab",
      report: () => reported.resolve(),
    });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
      await opening;
      clock.advance(60_000);
      clock.wakeDue();
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      expect(client.closes).toHaveLength(1);
      client.closes[0].reply.reject(new Error("Expired-attempt Close failed"));
      await reported.promise;
      expect(closeFailures).toEqual(["close-failed"]);
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      expect(client.prepares).toHaveLength(1);
    } finally {
      coordinator.close();
    }
  });

  it("starts the expiry clock after profile acquisition and before the Prepare call", async () => {
    const { coordinator, client, profile, clock, launches } = fixture({ mode: "tab" });
    try {
      const profileHeld = profile.holdNextLock();
      const opening = coordinator.open();
      clock.advance(120_000);
      expect(client.prepares).toEqual([]);
      profileHeld.resolve();
      const pending = await client.waitForPrepare(0);
      clock.advance(5_000);
      pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
      await opening;
      clock.advance(54_999);
      clock.wakeDue();
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      clock.advance(1);
      clock.wakeDue();
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      expect(launches).toEqual([]);
    } finally {
      coordinator.close();
    }
  });

  it.each(["iframe", "tab"] as const)(
    "does not publish a usable late Prepare reply after its deadline in %s mode",
    async (mode) => {
      const { coordinator, client, clock, launches } = fixture({ mode });
      const states: string[] = [];
      const unsubscribe = coordinator.subscribe(() =>
        states.push(coordinator.getSnapshot().status),
      );
      try {
        const opening = coordinator.open();
        const pending = await client.waitForPrepare(0);
        clock.advance(60_001);
        pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
        await opening;
        coordinator.launch();
        expect(launches).toEqual([]);
        expect(states).not.toContain("ready");
        expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
        expect(client.prepares).toHaveLength(1);
      } finally {
        unsubscribe();
        coordinator.close();
      }
    },
  );

  it("rejects launch at the deadline even when the timer callback has not run", async () => {
    const { coordinator, client, clock, launches } = fixture({ mode: "tab" });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
      await opening;
      clock.advance(60_000);
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      coordinator.launch();
      expect(launches).toEqual([]);
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      expect(clock.pending()).toEqual([]);
      expect(client.prepares).toHaveLength(1);
    } finally {
      coordinator.close();
    }
  });

  it("checks expiry again after a launch-state subscriber runs before form submission", async () => {
    const { coordinator, client, clock, launches } = fixture({ mode: "tab" });
    const unsubscribe = coordinator.subscribe(() => {
      if (coordinator.getSnapshot().status === "open") clock.advance(60_000);
    });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
      await opening;
      coordinator.launch();
      expect(launches).toEqual([]);
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
    } finally {
      unsubscribe();
      coordinator.close();
    }
  });

  it("does not let an obsolete timer cancel a newer ready attempt", async () => {
    const { coordinator, client, clock, launches } = fixture({ mode: "tab" });
    try {
      const firstOpening = coordinator.open();
      const first = await client.waitForPrepare(0);
      first.reply.resolve({ result: { ...prepared(first), expiresInMs: 60_000 } });
      await firstOpening;
      const oldTimer = clock.pending()[0];
      expect(oldTimer).toBeDefined();
      clock.advance(40_000);
      const nextOpening = coordinator.open();
      const next = await client.waitForPrepare(1);
      next.reply.resolve({ result: { ...prepared(next), expiresInMs: 60_000 } });
      await nextOpening;
      clock.advance(20_000);
      oldTimer.callback();
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([first.input.attemptId]);
      coordinator.launch();
      expect(launches.map(({ attemptId }) => attemptId)).toEqual([next.input.attemptId]);
    } finally {
      coordinator.close();
    }
  });

  it.each(["cancel", "source-loss", "lifetime-close"] as const)(
    "releases the prepared-ticket timer on %s and ignores an already-queued callback",
    async (ending) => {
      const host = fixture({ mode: "tab" });
      try {
        const opening = host.coordinator.open();
        const pending = await host.client.waitForPrepare(0);
        pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
        await opening;
        const timer = host.clock.pending()[0];
        expect(timer).toBeDefined();
        if (ending === "cancel") host.coordinator.cancel();
        else if (ending === "source-loss") host.setSource(null);
        else host.lifetime.abort();
        const ended = host.coordinator.getSnapshot();
        expect(host.clock.pending()).toEqual([]);
        host.clock.advance(60_000);
        timer.callback();
        host.coordinator.launch();
        expect(host.coordinator.getSnapshot()).toEqual(ended);
        expect(host.launches).toEqual([]);
        expect(host.client.prepares).toHaveLength(1);
      } finally {
        host.coordinator.close();
      }
    },
  );

  it.each(["iframe", "tab"] as const)(
    "does not let ticket expiry cancel an already-submitted %s contribution",
    async (mode) => {
      const { coordinator, client, clock, launches, launchOptions } = fixture({ mode });
      try {
        const opening = coordinator.open();
        const pending = await client.waitForPrepare(0);
        pending.reply.resolve({ result: { ...prepared(pending), expiresInMs: 60_000 } });
        await opening;
        coordinator.launch();
        expect(launches).toHaveLength(1);
        const submittedState = coordinator.getSnapshot();
        const timers = clock.scheduled.slice();
        expect(clock.pending()).toEqual([]);
        clock.advance(120_000);
        for (const timer of timers) timer.callback();
        coordinator.launch();
        expect(coordinator.getSnapshot()).toEqual(submittedState);
        expect(launches).toHaveLength(1);
        expect(launchOptions[0].signal.aborted).toBe(false);
        expect(client.closes).toEqual([]);
      } finally {
        coordinator.close();
      }
    },
  );

  it("keeps an explicitly independent standalone lifetime active when the embedded lifetime ends", async () => {
    const client = new MemoryClient();
    const embedded = fixture({ client, idPrefix: "embedded" });
    const browser = fixture({ client, mode: "tab", idPrefix: "browser" });
    try {
      const embeddedOpening = embedded.coordinator.open();
      const embeddedPrepare = await client.waitForPrepare(0);
      embeddedPrepare.reply.resolve({ result: prepared(embeddedPrepare) });
      await embeddedOpening;
      const browserOpening = browser.coordinator.open();
      const browserPrepare = await client.waitForPrepare(1);
      browserPrepare.reply.resolve({ result: prepared(browserPrepare) });
      await browserOpening;
      browser.coordinator.launch();
      embedded.lifetime.abort();
      expect(embedded.coordinator.getSnapshot()).toEqual({ status: "closed" });
      expect(embedded.launchOptions[0].signal.aborted).toBe(true);
      expect(browser.coordinator.getSnapshot()).toEqual({ status: "open" });
      expect(browser.launchOptions[0].signal.aborted).toBe(false);
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([
        embeddedPrepare.input.attemptId,
      ]);
      browser.coordinator.cancel();
      expect(browser.launchOptions[0].signal.aborted).toBe(true);
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([
        embeddedPrepare.input.attemptId,
        browserPrepare.input.attemptId,
      ]);
    } finally {
      embedded.coordinator.close();
      browser.coordinator.close();
    }
  });

  it.each(["cancel", "source-loss", "lifetime-close"] as const)(
    "immediately aborts the launched navigation on %s and ignores its late completion",
    async (ending) => {
      const host = fixture();
      try {
        const opening = host.coordinator.open();
        const pending = await host.client.waitForPrepare(0);
        pending.reply.resolve({ result: prepared(pending) });
        await opening;
        const options = host.launchOptions[0];
        expect(options.reload).toBe(false);
        expect(options.signal.aborted).toBe(false);
        let aborted = 0;
        options.signal.addEventListener("abort", () => {
          aborted += 1;
        });
        if (ending === "cancel") host.coordinator.cancel();
        else if (ending === "source-loss") host.setSource(null);
        else host.lifetime.abort();
        expect(options.signal.aborted).toBe(true);
        expect(aborted).toBe(1);
        const ended = host.coordinator.getSnapshot();
        host.coordinator.navigationCompleted(pending.input.attemptId, true);
        expect(host.coordinator.getSnapshot()).toEqual(ended);
        host.coordinator.close();
        expect(aborted).toBe(1);
      } finally {
        host.coordinator.close();
      }
    },
  );

  it("uses a fresh navigation signal and reload decision for each explicit Open", async () => {
    const host = fixture();
    try {
      const firstOpen = host.coordinator.open();
      const first = await host.client.waitForPrepare(0);
      first.reply.resolve({ result: prepared(first) });
      await firstOpen;
      host.coordinator.navigationCompleted(first.input.attemptId, true);
      expect(host.launchOptions[0].signal.aborted).toBe(false);
      expect(host.launchOptions[0].reload).toBe(false);
      const reloadOpen = host.coordinator.open({ reload: true });
      expect(host.launchOptions[0].signal.aborted).toBe(true);
      const second = await host.client.waitForPrepare(1);
      second.reply.resolve({ result: prepared(second) });
      await reloadOpen;
      expect(host.launchOptions[1].reload).toBe(true);
      expect(host.launchOptions[1].signal.aborted).toBe(false);
      expect(host.launchOptions[1].signal).not.toBe(host.launchOptions[0].signal);
      host.coordinator.navigationCompleted(first.input.attemptId, true);
      expect(host.coordinator.getSnapshot()).toEqual({ status: "loading" });
      const resumeOpen = host.coordinator.open();
      expect(host.launchOptions[1].signal.aborted).toBe(true);
      const third = await host.client.waitForPrepare(2);
      third.reply.resolve({ result: prepared(third) });
      await resumeOpen;
      expect(host.launchOptions[2].reload).toBe(false);
      expect(host.launchOptions[2].signal.aborted).toBe(false);
    } finally {
      host.coordinator.close();
    }
    expect(host.launchOptions.at(-1)?.signal.aborted).toBe(true);
  });

  it("cancels a held Prepare without closing the document and later opens a fresh attempt", async () => {
    const { coordinator, client, lifetime, launches, sourceListeners } = fixture();
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      coordinator.cancel();
      expect(coordinator.getSnapshot()).toEqual({ status: "cancelling" });
      expect(lifetime.signal.aborted).toBe(false);
      expect(sourceListeners()).toBe(1);
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([pending.input.attemptId]);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      coordinator.launch();
      expect(launches).toEqual([]);
      const close = client.closes[0];
      const cancelled = waitForState(coordinator, (state) => state.status === "idle");
      close.reply.resolve({
        requestId: "cancel-held",
        result: { status: "closed", attemptId: close.attemptId },
      });
      await cancelled;
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      const nextOpen = coordinator.open();
      const next = await client.waitForPrepare(1);
      expect(next.input.attemptId).not.toBe(pending.input.attemptId);
      next.reply.resolve({ result: prepared(next) });
      await nextOpen;
      expect(launches).toEqual([prepared(next)]);
    } finally {
      coordinator.close();
    }
  });

  it.each(["success", "failure"] as const)(
    "ignores stale frame completion and late Cancel %s after a fresh Open",
    async (outcome) => {
      const { coordinator, client, lifetime, launches } = fixture();
      try {
        const opening = coordinator.open();
        const pending = await client.waitForPrepare(0);
        pending.reply.resolve({ result: prepared(pending) });
        await opening;
        coordinator.cancel();
        coordinator.navigationCompleted(pending.input.attemptId, true);
        coordinator.navigationCompleted(pending.input.attemptId, false);
        expect(coordinator.getSnapshot()).toEqual({ status: "cancelling" });
        expect(lifetime.signal.aborted).toBe(false);
        expect(launches).toEqual([prepared(pending)]);
        const nextOpen = coordinator.open();
        const next = await client.waitForPrepare(1);
        expect(next.input.attemptId).not.toBe(pending.input.attemptId);
        next.reply.resolve({ result: prepared(next) });
        await nextOpen;
        coordinator.navigationCompleted(pending.input.attemptId, false);
        expect(coordinator.getSnapshot()).toEqual({ status: "loading" });
        coordinator.navigationCompleted(next.input.attemptId, true);
        expect(coordinator.getSnapshot()).toEqual({ status: "open" });
        const oldClose = client.closes[0];
        if (outcome === "success")
          oldClose.reply.resolve({
            requestId: "cancel-old",
            result: { status: "closed", attemptId: oldClose.attemptId },
          });
        else oldClose.reply.reject(new Error("Old cancellation failed late"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(coordinator.getSnapshot()).toEqual({ status: "open" });
        expect(launches).toEqual([prepared(pending), prepared(next)]);
      } finally {
        coordinator.close();
      }
    },
  );

  it.each(["rejection", "refusal", "wrong-attempt"] as const)(
    "reports Cancel %s while the original source remains connected",
    async (outcome) => {
      const { coordinator, client, lifetime } = fixture();
      try {
        const opening = coordinator.open();
        const pending = await client.waitForPrepare(0);
        pending.reply.resolve({ result: prepared(pending) });
        await opening;
        coordinator.cancel();
        coordinator.cancel();
        expect(coordinator.getSnapshot()).toEqual({ status: "cancelling" });
        expect(client.closes).toHaveLength(1);
        const ended = waitForState(coordinator, (state) => state.status === "error");
        const close = client.closes[0];
        if (outcome === "rejection") close.reply.reject(new Error("Close transport failed"));
        else if (outcome === "refusal")
          close.reply.resolve({
            requestId: "cancel-refused",
            result: { status: "error", code: "unavailable" },
          });
        else
          close.reply.resolve({
            requestId: "cancel-wrong",
            result: { status: "closed", attemptId: "another-attempt" },
          });
        expect(await ended).toEqual({ status: "error", code: "close", recovery: false });
        expect(lifetime.signal.aborted).toBe(false);
        const reopening = coordinator.open();
        const next = await client.waitForPrepare(1);
        expect(next.input.attemptId).not.toBe(pending.input.attemptId);
        next.reply.resolve({ result: prepared(next) });
        await reopening;
        expect(coordinator.getSnapshot()).toEqual({ status: "loading" });
      } finally {
        coordinator.close();
      }
    },
  );

  it("accepts source invalidation as cancellation without sending Close through a replacement", async () => {
    const { coordinator, client, setSource, initialSource, closeFailures } = fixture();
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      coordinator.cancel();
      setSource({ ...initialSource, connectionEpoch: 2 });
      const cancelled = waitForState(coordinator, (state) => state.status === "idle");
      client.closes[0].reply.reject(new Error("Old physical connection ended"));
      expect(await cancelled).toEqual({ status: "idle" });
      expect(client.closes).toHaveLength(1);
      expect(closeFailures).toEqual([]);
    } finally {
      coordinator.close();
    }
  });

  it("does not navigate after a loading subscriber synchronously closes the document", async () => {
    const { coordinator, client, launches } = fixture();
    const unsubscribe = coordinator.subscribe(() => {
      if (coordinator.getSnapshot().status === "loading") coordinator.close();
    });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      expect(coordinator.getSnapshot()).toEqual({ status: "closed" });
      expect(launches).toEqual([]);
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([pending.input.attemptId]);
    } finally {
      unsubscribe();
      coordinator.close();
    }
  });

  it("navigates an iframe once, reports loading, and accepts its own completion", async () => {
    const { coordinator, client, launches } = fixture();
    try {
      expect(coordinator.getSnapshot()).toEqual({ status: "idle" });
      const opening = coordinator.open();
      expect(coordinator.getSnapshot()).toEqual({ status: "preparing" });
      const pending = await client.waitForPrepare(0);
      expect(pending.input).toEqual({
        attemptId: "attempt-1",
        browserHandle: FIRST_HANDLE,
        serviceId: "atlas",
        mode: "iframe",
      });
      const ticket = prepared(pending);
      pending.reply.resolve({ result: ticket });
      await opening;
      expect(launches).toEqual([ticket]);
      expect(coordinator.getSnapshot()).toEqual({ status: "loading" });
      coordinator.launch();
      coordinator.navigationCompleted(ticket.attemptId, true);
      expect(coordinator.getSnapshot()).toEqual({ status: "open" });
      expect(launches).toEqual([ticket]);
    } finally {
      coordinator.close();
    }
  });

  it("closes a client-known attempt before its Prepare reply and ignores the late ticket", async () => {
    const { coordinator, client, launches, sourceListeners } = fixture();
    const opening = coordinator.open();
    const pending = await client.waitForPrepare(0);
    coordinator.close();
    expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([pending.input.attemptId]);
    expect(coordinator.getSnapshot()).toEqual({ status: "closed" });
    expect(sourceListeners()).toBe(0);
    pending.reply.resolve({ result: prepared(pending) });
    await opening;
    coordinator.launch();
    await coordinator.open();
    coordinator.close();
    expect(launches).toEqual([]);
    expect(client.prepares).toHaveLength(1);
    expect(client.closes).toHaveLength(1);
  });

  it("aborts while profile initialization is held without issuing Prepare later", async () => {
    const { coordinator, client, profile, lifetime, launches } = fixture();
    const held = profile.holdNextLock();
    const opening = coordinator.open();
    lifetime.abort();
    held.resolve();
    await opening;
    expect(coordinator.getSnapshot()).toEqual({ status: "closed" });
    expect(client.prepares).toEqual([]);
    expect(client.closes).toEqual([]);
    expect(launches).toEqual([]);
  });

  it("cannot restore an old ticket after a newer Open fails on invalid storage", async () => {
    const { coordinator, client, profile, launches } = fixture();
    try {
      const firstOpen = coordinator.open();
      const first = await client.waitForPrepare(0);
      profile.value = "invalid-profile";
      await coordinator.open();
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "storage",
        recovery: true,
      });
      first.reply.resolve({ result: prepared(first) });
      await firstOpen;
      coordinator.launch();
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "storage",
        recovery: true,
      });
      expect(launches).toEqual([]);
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([first.input.attemptId]);
    } finally {
      coordinator.close();
    }
  });

  it("keeps a fresh navigation loading when an older navigation reports late", async () => {
    const { coordinator, client, launches } = fixture();
    try {
      const firstOpen = coordinator.open();
      const first = await client.waitForPrepare(0);
      first.reply.resolve({ result: prepared(first) });
      await firstOpen;
      const nextOpen = coordinator.open();
      const next = await client.waitForPrepare(1);
      next.reply.resolve({ result: prepared(next) });
      await nextOpen;
      coordinator.navigationCompleted(first.input.attemptId, true);
      coordinator.navigationCompleted(first.input.attemptId, false);
      expect(coordinator.getSnapshot()).toEqual({ status: "loading" });
      coordinator.navigationCompleted(next.input.attemptId, true);
      expect(coordinator.getSnapshot()).toEqual({ status: "open" });
      expect(launches.map(({ attemptId }) => attemptId)).toEqual([
        first.input.attemptId,
        next.input.attemptId,
      ]);
    } finally {
      coordinator.close();
    }
  });

  it("keeps a detached attempt terminal even if its old source identity is restored", async () => {
    const { coordinator, client, launches, setSource, initialSource } = fixture();
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      setSource(null);
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "connection-ended",
        recovery: false,
      });
      setSource(initialSource);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      coordinator.launch();
      expect(launches).toEqual([]);
      expect(client.closes).toEqual([]);
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "connection-ended",
        recovery: false,
      });

      const fresh = coordinator.open();
      const freshPrepare = await client.waitForPrepare(1);
      freshPrepare.reply.resolve({ result: prepared(freshPrepare) });
      await fresh;
      expect(launches.map(({ attemptId }) => attemptId)).toEqual([freshPrepare.input.attemptId]);
    } finally {
      coordinator.close();
    }
  });

  it.each(["client", "generation", "epoch", "route-revision"] as const)(
    "invalidates a ready tab when its %s changes",
    async (change) => {
      const { coordinator, client, launches, setSource, initialSource } = fixture({ mode: "tab" });
      try {
        const opening = coordinator.open();
        const pending = await client.waitForPrepare(0);
        pending.reply.resolve({ result: prepared(pending) });
        await opening;
        const replacement = {
          client: change === "client" ? new MemoryClient() : client,
          clientGeneration: change === "generation" ? 2 : 1,
          connectionEpoch: change === "epoch" ? 2 : 1,
          routeRevision: change === "route-revision" ? "replacement-route" : undefined,
        };
        setSource(replacement);
        setSource(initialSource);
        coordinator.launch();
        expect(launches).toEqual([]);
        expect(client.closes).toEqual([]);
        expect(coordinator.getSnapshot()).toEqual({
          status: "error",
          code: "connection-ended",
          recovery: false,
        });
      } finally {
        coordinator.close();
      }
    },
  );

  it("recovers invalid storage explicitly without overwriting another page's replacement", async () => {
    const { coordinator, client, profile, launches } = fixture();
    try {
      profile.value = "invalid-profile";
      await coordinator.open();
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "storage",
        recovery: true,
      });
      expect(client.prepares).toEqual([]);
      profile.value = SECOND_HANDLE;
      const recovery = coordinator.open({ recover: true });
      const pending = await client.waitForPrepare(0);
      expect(pending.input.browserHandle).toBe(SECOND_HANDLE);
      expect(profile.writes).toEqual([]);
      pending.reply.resolve({ result: prepared(pending) });
      await recovery;
      expect(launches).toHaveLength(1);
    } finally {
      coordinator.close();
    }
  });

  it("makes storage access failure visible without advertising unusable recovery", async () => {
    const { coordinator, client, profile } = fixture();
    try {
      profile.error = new Error("Storage disabled");
      await coordinator.open();
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "storage",
        recovery: false,
      });
      expect(client.prepares).toEqual([]);
      expect(client.closes).toEqual([]);
    } finally {
      coordinator.close();
    }
  });

  it("replaces a superseded profile only after an explicit recovery action", async () => {
    const { coordinator, client, profile } = fixture();
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: { status: "error", code: "browser-session-replaced" } });
      await opening;
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "replaced",
        recovery: true,
      });
      expect(profile.writes).toEqual([]);
      const recovery = coordinator.open({ recover: true });
      const next = await client.waitForPrepare(1);
      expect(next.input.browserHandle).toBe(SECOND_HANDLE);
      expect(profile.writes).toEqual([SECOND_HANDLE]);
      expect(next.input.attemptId).not.toBe(pending.input.attemptId);
      next.reply.resolve({ result: prepared(next) });
      await recovery;
      expect(coordinator.getSnapshot()).toEqual({ status: "loading" });
    } finally {
      coordinator.close();
    }
  });

  it.each<Partial<PreparedPreview>>([
    { attemptId: "another-attempt" },
    { serviceId: "another-service" },
    { mode: "tab" },
  ])("refuses a reply with a mismatched tuple: %j", async (mismatch) => {
    const { coordinator, client, launches } = fixture();
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending, mismatch) });
      await opening;
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "denied",
        recovery: false,
      });
      expect(launches).toEqual([]);
      expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([pending.input.attemptId]);
    } finally {
      coordinator.close();
    }
  });

  it("consumes a failed browser launch and requires a fresh explicit Open", async () => {
    const { coordinator, client, launches, setLaunchError } = fixture();
    try {
      setLaunchError(new Error("browser submission failed"));
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "launch",
        recovery: false,
      });
      coordinator.launch();
      expect(launches).toHaveLength(1);
      setLaunchError(null);
      const retry = coordinator.open();
      const fresh = await client.waitForPrepare(1);
      fresh.reply.resolve({ result: prepared(fresh) });
      await retry;
      expect(launches.map(({ ticket }) => ticket)).toEqual([
        prepared(pending).ticket,
        prepared(fresh).ticket,
      ]);
      expect(coordinator.getSnapshot()).toEqual({ status: "loading" });
    } finally {
      coordinator.close();
    }
  });

  it("holds standalone navigation until an explicit launch, then submits the ticket once", async () => {
    const { coordinator, client, launches } = fixture({ mode: "tab" });
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      expect(launches).toEqual([]);
      coordinator.navigationCompleted(pending.input.attemptId, true);
      expect(coordinator.getSnapshot()).toEqual({ status: "ready" });
      coordinator.launch();
      coordinator.launch();
      expect(launches).toEqual([prepared(pending)]);
      expect(coordinator.getSnapshot()).toEqual({ status: "open" });
    } finally {
      coordinator.close();
    }
  });

  it("does not let an old Close failure overwrite a newer successful Open", async () => {
    const { coordinator, client, closeFailures } = fixture();
    try {
      const firstOpen = coordinator.open();
      const first = await client.waitForPrepare(0);
      const nextOpen = coordinator.open();
      const next = await client.waitForPrepare(1);
      next.reply.resolve({ result: prepared(next) });
      await nextOpen;
      coordinator.navigationCompleted(next.input.attemptId, true);
      first.reply.reject(new Error("old Prepare failed late"));
      await firstOpen;
      const oldClose = client.closes[0];
      oldClose.reply.reject(new Error("old Close failed late"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(coordinator.getSnapshot()).toEqual({ status: "open" });
      expect(closeFailures).toEqual(["close-failed"]);
    } finally {
      coordinator.close();
    }
  });

  it.each(["confirmed", "refused"] as const)(
    "keeps a superseded Close failure visible while another attempt has pending Cancel: %s",
    async (outcome) => {
      const { coordinator, client, closeFailures } = fixture();
      try {
        const firstOpen = coordinator.open();
        const first = await client.waitForPrepare(0);
        first.reply.resolve({ result: prepared(first) });
        await firstOpen;
        coordinator.navigationCompleted(first.input.attemptId, true);

        const nextOpen = coordinator.open();
        const next = await client.waitForPrepare(1);
        next.reply.resolve({ result: prepared(next) });
        await nextOpen;
        coordinator.cancel();
        expect(client.closes.map(({ attemptId }) => attemptId)).toEqual([
          first.input.attemptId,
          next.input.attemptId,
        ]);
        expect(coordinator.getSnapshot()).toEqual({ status: "cancelling" });

        // Let A's Close rejection settle while B's separate Close remains held.
        // The durable diagnostic for A must not depend on B's eventual outcome.
        client.closes[0].reply.reject(new Error("Superseded Close failed during another Cancel"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closeFailures).toEqual(["close-failed"]);
        expect(coordinator.getSnapshot()).toEqual({ status: "cancelling" });

        const cancelled = waitForState(coordinator, (state) => state.status !== "cancelling");
        const close = client.closes[1];
        close.reply.resolve({
          requestId: "cancel-next",
          result:
            outcome === "confirmed"
              ? { status: "closed", attemptId: close.attemptId }
              : { status: "error", code: "unavailable" },
        });
        expect(await cancelled).toEqual(
          outcome === "confirmed"
            ? { status: "idle" }
            : { status: "error", code: "close", recovery: false },
        );
        expect(closeFailures).toEqual(["close-failed"]);
        expect(client.closes).toHaveLength(2);
      } finally {
        coordinator.close();
      }
    },
  );

  it.each(["throw", "reject"] as const)(
    "reports lifetime Close failure even if its detached reporter can %s",
    async (outcome) => {
      const reportError = new Error("Close diagnostic failed");
      const { coordinator, client, lifetime, closeFailures, sourceListeners } = fixture({
        report() {
          if (outcome === "throw") throw reportError;
          return Promise.reject(reportError);
        },
      });
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      lifetime.abort();
      expect(coordinator.getSnapshot()).toEqual({ status: "closed" });
      expect(sourceListeners()).toBe(0);
      expect(client.closes).toHaveLength(1);
      client.closes[0].reply.reject(new Error("Close request failed after tab closed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeFailures).toEqual(["close-failed"]);
      expect(coordinator.getSnapshot()).toEqual({ status: "closed" });
      coordinator.close();
      expect(client.closes).toHaveLength(1);
    },
  );

  it("does not report a lifetime Close failure after its physical source detaches", async () => {
    const { coordinator, client, lifetime, closeFailures, setSource } = fixture();
    const opening = coordinator.open();
    const pending = await client.waitForPrepare(0);
    pending.reply.resolve({ result: prepared(pending) });
    await opening;
    lifetime.abort();
    setSource(null);
    client.closes[0].reply.reject(new Error("Physical source detached"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeFailures).toEqual([]);
    expect(coordinator.getSnapshot()).toEqual({ status: "closed" });
  });

  it("makes a still-connected protocol refusal of Close visible", async () => {
    const { coordinator, client } = fixture();
    try {
      const opening = coordinator.open();
      const pending = await client.waitForPrepare(0);
      pending.reply.resolve({ result: prepared(pending) });
      await opening;
      coordinator.navigationCompleted(pending.input.attemptId, false);
      expect(coordinator.getSnapshot()).toEqual({
        status: "error",
        code: "denied",
        recovery: false,
      });
      const failed = waitForResult(
        {
          getCurrentResult: coordinator.getSnapshot,
          subscribe(listener) {
            return coordinator.subscribe(() => listener(coordinator.getSnapshot()));
          },
        },
        (state) => state.status === "error" && state.code === "connection-ended",
      );
      client.closes[0].reply.resolve({
        requestId: "close-1",
        result: { status: "error", code: "unavailable" },
      });
      expect(await failed).toEqual({ status: "error", code: "connection-ended", recovery: false });
      expect(client.closes).toHaveLength(1);
    } finally {
      coordinator.close();
    }
  });
});
