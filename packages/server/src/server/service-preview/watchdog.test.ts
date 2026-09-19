import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_WATCHDOG_MS, type PreviewClock } from "./clock.js";
import { PreviewGatewayWatchdog } from "./watchdog.js";

interface ScheduledTask {
  due: number;
  callback(): void;
}

class ManualClock implements PreviewClock {
  private time = 0;
  private readonly tasks = new Set<ScheduledTask>();

  now(): number {
    return this.time;
  }

  schedule({ delayMs, callback }: { delayMs: number; callback(): void }): () => void {
    const task = { due: this.time + delayMs, callback };
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  }

  jumpTo(time: number): void {
    if (time < this.time) throw new Error("Manual monotonic clock cannot move backwards");
    this.time = time;
  }

  advanceTo(time: number): void {
    this.jumpTo(time);
    for (;;) {
      const next = this.next();
      if (!next || next.due > this.time) return;
      this.tasks.delete(next);
      next.callback();
    }
  }

  fireNextEarly(): void {
    const next = this.next();
    if (!next) throw new Error("No scheduled callback to deliver early");
    this.tasks.delete(next);
    next.callback();
  }

  pending(): number {
    return this.tasks.size;
  }

  private next(): ScheduledTask | undefined {
    return [...this.tasks].sort((a, b) => a.due - b.due)[0];
  }
}

const owners: PreviewGatewayWatchdog[] = [];

function fixture(send?: (challenge: string) => void | PromiseLike<void>) {
  const clock = new ManualClock();
  const probes: string[] = [];
  const watchdog = new PreviewGatewayWatchdog({
    clock,
    sendProbe(challenge) {
      probes.push(challenge);
      return send?.(challenge);
    },
  });
  owners.push(watchdog);
  return { clock, probes, watchdog };
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
});

describe("gateway-side preview watchdog", () => {
  it("starts unready and admits only the current exact challenge", async () => {
    const { probes, watchdog } = fixture();
    const pending = Symbol("pending");
    expect(PREVIEW_WATCHDOG_MS).toBe(15_000);
    expect(probes).toHaveLength(1);
    expect(watchdog.isCurrent()).toBe(false);
    expect(await Promise.race([watchdog.ready, Promise.resolve(pending)])).toBe(pending);
    expect(watchdog.acknowledge("unknown-challenge")).toBe(false);
    expect(watchdog.isCurrent()).toBe(false);
    expect(watchdog.acknowledge(probes[0])).toBe(true);
    await watchdog.ready;
    expect(watchdog.isCurrent()).toBe(true);
    expect(watchdog.acknowledge(probes[0])).toBe(false);
  });

  it("expires initial admission at the exact approved deadline", async () => {
    const { clock, probes, watchdog } = fixture();
    clock.advanceTo(14_999);
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.isCurrent()).toBe(false);
    clock.advanceTo(15_000);
    await expect(watchdog.ready).rejects.toMatchObject({ code: "timeout" });
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toMatchObject({ code: "timeout" });
    expect(watchdog.acknowledge(probes[0])).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("renews halfway through the interval and rejects a previous challenge", async () => {
    const { clock, probes, watchdog } = fixture();
    expect(watchdog.acknowledge(probes[0])).toBe(true);
    clock.advanceTo(7_499);
    expect(probes).toHaveLength(1);
    clock.advanceTo(7_500);
    expect(probes).toHaveLength(2);
    expect(probes[1]).not.toBe(probes[0]);
    expect(watchdog.acknowledge(probes[0])).toBe(false);
    expect(watchdog.acknowledge(probes[1])).toBe(true);
    clock.advanceTo(22_499);
    expect(watchdog.isCurrent()).toBe(true);
    clock.advanceTo(22_500);
    expect(watchdog.isCurrent()).toBe(false);
    expect(watchdog.signal.reason).toMatchObject({ code: "timeout" });
  });

  it("measures a delayed renewal from challenge send time, not acknowledgement time", async () => {
    const { clock, probes, watchdog } = fixture();
    watchdog.acknowledge(probes[0]);
    clock.advanceTo(7_500);
    clock.jumpTo(14_999);
    expect(watchdog.acknowledge(probes[1])).toBe(true);
    clock.advanceTo(22_499);
    expect(watchdog.isCurrent()).toBe(true);
    clock.advanceTo(22_500);
    expect(watchdog.isCurrent()).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("does not extend initial readiness when the first reply arrives late", async () => {
    const { clock, probes, watchdog } = fixture();
    clock.jumpTo(14_999);
    expect(watchdog.acknowledge(probes[0])).toBe(true);
    await watchdog.ready;
    expect(watchdog.isCurrent()).toBe(true);
    clock.jumpTo(15_000);
    expect(watchdog.isCurrent()).toBe(false);
    expect(watchdog.signal.reason).toMatchObject({ code: "timeout" });
    expect(clock.pending()).toBe(0);
  });

  it("enforces expiry synchronously even when timer callbacks are delayed", async () => {
    const { clock, probes, watchdog } = fixture();
    watchdog.acknowledge(probes[0]);
    clock.advanceTo(7_500);
    const delayedReply = probes[1];
    clock.jumpTo(15_000);
    expect(watchdog.isCurrent()).toBe(false);
    expect(watchdog.acknowledge(delayedReply)).toBe(false);
    clock.advanceTo(30_000);
    expect(watchdog.isCurrent()).toBe(false);
    expect(probes).toHaveLength(2);
    expect(clock.pending()).toBe(0);
  });

  it("cannot revive expired authority through a reply before the expiry callback runs", async () => {
    const { clock, probes, watchdog } = fixture();
    watchdog.acknowledge(probes[0]);
    clock.advanceTo(7_500);
    clock.jumpTo(15_000);
    expect(watchdog.acknowledge(probes[1])).toBe(false);
    expect(watchdog.signal.reason).toMatchObject({ code: "timeout" });
    expect(watchdog.isCurrent()).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("rearms an early timer without expiring admission early", async () => {
    const { clock, probes, watchdog } = fixture();
    clock.jumpTo(1_000);
    clock.fireNextEarly();
    expect(watchdog.signal.aborted).toBe(false);
    expect(probes).toHaveLength(1);
    clock.advanceTo(15_000);
    await expect(watchdog.ready).rejects.toMatchObject({ code: "timeout" });
    expect(clock.pending()).toBe(0);
  });

  it.each(["throw", "reject"])("contains probe delivery %s and rejects readiness", async (mode) => {
    const { clock, probes, watchdog } = fixture(() => {
      const error = new Error("fixture-private-transport-detail");
      if (mode === "throw") throw error;
      return Promise.reject(error);
    });
    await expect(watchdog.ready).rejects.toMatchObject({
      code: "probe-failed",
      message: "preview-watchdog-probe-failed",
    });
    expect(watchdog.signal.reason).toMatchObject({ code: "probe-failed" });
    expect(watchdog.isCurrent()).toBe(false);
    expect(watchdog.acknowledge(probes[0])).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("terminalizes an explicit close before readiness and cancels all timers", async () => {
    const { clock, probes, watchdog } = fixture();
    watchdog.close();
    await expect(watchdog.ready).rejects.toMatchObject({ code: "transport-closed" });
    expect(watchdog.acknowledge(probes[0])).toBe(false);
    expect(watchdog.isCurrent()).toBe(false);
    clock.advanceTo(30_000);
    expect(probes).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("keeps close terminal after readiness despite a late delivery rejection", async () => {
    let rejectDelivery: (error: Error) => void = () => {};
    const delivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const { clock, probes, watchdog } = fixture(() => delivery);
    expect(watchdog.acknowledge(probes[0])).toBe(true);
    await watchdog.ready;
    watchdog.close();
    rejectDelivery(new Error("late-send-failure"));
    await Promise.resolve();
    expect(watchdog.signal.reason).toMatchObject({ code: "transport-closed" });
    expect(watchdog.isCurrent()).toBe(false);
    expect(watchdog.acknowledge(probes[0])).toBe(false);
    expect(clock.pending()).toBe(0);
  });
});
