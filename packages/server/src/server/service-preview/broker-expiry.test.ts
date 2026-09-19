import { describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { PreviewBroker, type PreviewAuthorizedJob } from "./broker.js";
import { type PreviewClock } from "./clock.js";
import { PreviewRoutes } from "./routes.js";
import { PreviewSources, PREVIEW_SOURCE_CAPABILITY } from "./sources.js";

interface ScheduledWake {
  callback(): void;
  dueAt: number;
  delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

class ManualClock implements PreviewClock {
  private milliseconds = 1_000;
  readonly scheduled: ScheduledWake[] = [];
  failure: Error | null = null;

  now(): number {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    return this.milliseconds;
  }

  schedule({ delayMs, callback }: Parameters<PreviewClock["schedule"]>[0]): () => void {
    const scheduled = {
      callback,
      dueAt: this.milliseconds + delayMs,
      delayMs,
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

  pending(): ScheduledWake[] {
    return this.scheduled.filter((timer) => !timer.cancelled && !timer.fired);
  }

  wake(timer: ScheduledWake): void {
    if (timer.cancelled || timer.fired) throw new Error("Cannot execute an inactive timer");
    timer.fired = true;
    timer.callback();
  }

  wakeDue(): void {
    for (const timer of this.pending()) {
      if (timer.dueAt <= this.milliseconds) this.wake(timer);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

interface FixtureOptions {
  deliver?: () => Promise<boolean>;
  report?: (error: unknown) => void | Promise<void>;
}

function fixture({ deliver = async () => true, report = () => {} }: FixtureOptions = {}) {
  const clock = new ManualClock();
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  routes.register({ serviceId: "atlas", port: 5173, mount: "preserve" });
  const sources = new PreviewSources("https://control.test");
  const failures: unknown[] = [];
  const broker = new PreviewBroker({
    sources,
    routes,
    clock,
    onFailure(error) {
      failures.push(error);
      return report(error);
    },
  });
  const socket = { readyState: 1 };
  const frames: string[] = [];
  sources.admitDirectOwner({
    socket,
    connectionId: "source-a",
    principalId: "owner",
    origin: "https://control.test",
    permissions: OWNER_PERMISSIONS,
    send(frame) {
      frames.push(frame);
      return deliver();
    },
  });
  sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
  return { clock, routes, sources, broker, socket, frames, failures };
}

type Fixture = ReturnType<typeof fixture>;

function request(attemptId: string) {
  return {
    type: "service.preview.prepare.request" as const,
    requestId: `request-${attemptId}`,
    attemptId,
    browserHandle: "shared-browser",
    serviceId: "atlas",
    mode: "iframe" as const,
  };
}

function prepared(frame: string) {
  const parsed = ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(frame).message);
  if (parsed.payload.result.status !== "prepared") throw new Error("Expected prepared ticket");
  return parsed.payload.result;
}

async function prepare({ f, attemptId = "open-a" }: { f: Fixture; attemptId?: string }) {
  await f.broker.prepare({ socket: f.socket, request: request(attemptId) });
  return prepared(f.frames.at(-1)!);
}

function redeem({ f, ticket }: { f: Fixture; ticket: ReturnType<typeof prepared> }) {
  const credential = f.broker.redeem(ticket);
  const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
  return {
    confirmation: { bootstrapId: ticket.bootstrapId, cookieHeader, mode: ticket.mode },
    authority: { cookieHeader, serviceId: ticket.serviceId },
  };
}

describe("unused preview Open expiry", () => {
  it("ends held delivery at 60 seconds and never revives it after a late queued send", async () => {
    const delivered = deferred<boolean>();
    const f = fixture({ deliver: () => delivered.promise });
    const preparing = f.broker.prepare({ socket: f.socket, request: request("held-open") });
    const ticket = prepared(f.frames[0]);
    expect(f.clock.pending().map((timer) => timer.delayMs)).toEqual([60_000]);
    f.clock.advance(60_000);
    f.clock.wakeDue();
    await preparing;
    expect(f.clock.pending()).toEqual([]);
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    delivered.resolve(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    await f.broker.prepare({ socket: f.socket, request: request("held-open") });
    expect(
      ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(f.frames.at(-1)!).message).payload
        .result,
    ).toEqual({ status: "error", code: "duplicate-attempt" });
    const fresh = await prepare({ f, attemptId: "fresh-open" });
    const next = redeem({ f, ticket: fresh });
    f.broker.confirm(next.confirmation);
    expect(await f.broker.run(next.authority, () => "fresh request")).toBe("fresh request");
    f.broker.close();
  });

  it("rejects late delivery commitment without relying on the expiry callback", async () => {
    const delivered = deferred<boolean>();
    const f = fixture({ deliver: () => delivered.promise });
    const preparing = f.broker.prepare({ socket: f.socket, request: request("late-delivery") });
    const ticket = prepared(f.frames[0]);
    f.clock.advance(60_000);
    delivered.resolve(true);
    await preparing;
    expect(f.clock.scheduled[0].fired).toBe(false);
    expect(f.clock.pending()).toEqual([]);
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    f.broker.close();
  });

  it("reschedules an early wake and accepts confirmation immediately before the deadline", async () => {
    const f = fixture();
    const ticket = await prepare({ f });
    f.clock.advance(10_000);
    f.clock.wake(f.clock.pending()[0]);
    expect(f.clock.pending().map((timer) => timer.delayMs)).toEqual([50_000]);
    f.clock.advance(49_999);
    const opening = redeem({ f, ticket });
    f.broker.confirm(opening.confirmation);
    expect(f.clock.pending()).toEqual([]);
    f.clock.advance(1);
    expect(await f.broker.run(opening.authority, () => "confirmed")).toBe("confirmed");
    f.broker.close();
  });

  it("denies issued ticket redemption at the deadline even before its callback runs", async () => {
    const f = fixture();
    const ticket = await prepare({ f });
    f.clock.advance(60_000);
    expect(f.clock.scheduled[0].fired).toBe(false);
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    f.clock.wakeDue();
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    f.broker.close();
  });

  it("denies pending confirmation at the deadline without the callback and requires a fresh Open", async () => {
    const f = fixture();
    const ticket = await prepare({ f });
    f.clock.advance(59_999);
    const opening = redeem({ f, ticket });
    f.clock.advance(1);
    expect(f.clock.scheduled[0].fired).toBe(false);
    expect(() => f.broker.confirm(opening.confirmation)).toThrow("invalid-confirmation");
    await expect(f.broker.run(opening.authority, () => "must not run")).rejects.toThrow(
      "authorization-ended",
    );
    const fresh = await prepare({ f, attemptId: "explicit-retry" });
    const replacement = redeem({ f, ticket: fresh });
    f.broker.confirm(replacement.confirmation);
    expect(() => f.broker.confirm(opening.confirmation)).toThrow("invalid-confirmation");
    expect(await f.broker.run(replacement.authority, () => "replacement")).toBe("replacement");
    f.broker.close();
  });

  it("keeps expired IDs terminal on the original source while allowing a new physical source", async () => {
    const f = fixture();
    const ticket = await prepare({ f, attemptId: "expired-open" });
    const pending = redeem({ f, ticket });
    f.clock.advance(60_000);
    f.clock.wakeDue();
    expect(f.clock.pending()).toEqual([]);
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    expect(() => f.broker.confirm(pending.confirmation)).toThrow("invalid-confirmation");
    await f.broker.prepare({ socket: f.socket, request: request("expired-open") });
    expect(
      ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(f.frames.at(-1)!).message).payload
        .result,
    ).toEqual({ status: "error", code: "duplicate-attempt" });

    const replacement = { readyState: 1 };
    const frames: string[] = [];
    f.sources.admitDirectOwner({
      socket: replacement,
      connectionId: "replacement-source",
      principalId: "owner",
      origin: "https://control.test",
      permissions: OWNER_PERMISSIONS,
      async send(frame) {
        frames.push(frame);
        return true;
      },
    });
    f.sources.negotiate(replacement, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
    await f.broker.prepare({ socket: replacement, request: request("expired-open") });
    const next = prepared(frames[0]);
    expect(next.attemptId).toBe(ticket.attemptId);
    expect(next.bootstrapId).not.toBe(ticket.bootstrapId);
    const opening = redeem({ f, ticket: next });
    f.broker.confirm(opening.confirmation);
    expect(await f.broker.run(opening.authority, () => "fresh source")).toBe("fresh source");
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    expect(() => f.broker.confirm(pending.confirmation)).toThrow("invalid-confirmation");
    f.broker.close();
  });

  it("expires a pending confirmation while keeping confirmed shared authority and held work alive", async () => {
    const f = fixture();
    const first = await prepare({ f, attemptId: "active-open" });
    const activeTimer = f.clock.scheduled[0];
    const active = redeem({ f, ticket: first });
    f.broker.confirm(active.confirmation);
    expect(activeTimer.cancelled).toBe(true);
    const entered = deferred<PreviewAuthorizedJob>();
    const held = deferred<void>();
    const waitHeld = () => held.promise;
    let writes = 0;
    const write = () => {
      writes += 1;
    };
    const activeWork = f.broker.run(active.authority, async (job) => {
      entered.resolve(job);
      await job.wait(waitHeld);
      job.write(write);
      return job.activationId;
    });
    const captured = await entered.promise;
    const unused = await prepare({ f, attemptId: "unused-sibling" });
    const pending = redeem({ f, ticket: unused });
    expect(pending.authority.cookieHeader).toBe(active.authority.cookieHeader);
    f.clock.advance(60_000);
    f.clock.wakeDue();
    expect(() => f.broker.confirm(pending.confirmation)).toThrow("invalid-confirmation");
    expect(await f.broker.run(active.authority, (job) => job.activationId)).toBe(
      captured.activationId,
    );
    // A callback captured before confirmation cannot revoke the now-active contribution.
    f.clock.advance(3_600_000);
    activeTimer.callback();
    expect(await f.broker.run(active.authority, (job) => job.activationId)).toBe(
      captured.activationId,
    );
    held.resolve();
    expect(await activeWork).toBe(captured.activationId);
    expect(writes).toBe(1);
    expect(f.clock.pending()).toEqual([]);
    f.broker.close();
  });

  it.each(["source", "route"] as const)(
    "cancels unused timers when %s authority disappears",
    async (kind) => {
      const delivered = deferred<boolean>();
      const f = fixture({ deliver: () => delivered.promise });
      const preparing = f.broker.prepare({
        socket: f.socket,
        request: request("invalidated-open"),
      });
      const ticket = prepared(f.frames[0]);
      if (kind === "source") f.sources.detach(f.socket);
      else f.routes.markUnavailable("atlas");
      await preparing;
      expect(f.clock.pending()).toEqual([]);
      delivered.resolve(true);
      f.clock.advance(60_000);
      f.clock.scheduled[0].callback();
      expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
      expect(f.failures).toEqual([]);
      f.broker.close();
    },
  );

  it("ends held preparation and cancels its timer when the broker closes", async () => {
    const delivered = deferred<boolean>();
    const f = fixture({ deliver: () => delivered.promise });
    const preparing = f.broker.prepare({ socket: f.socket, request: request("closing-open") });
    const ticket = prepared(f.frames[0]);
    f.broker.close();
    await preparing;
    expect(f.clock.pending()).toEqual([]);
    delivered.resolve(true);
    f.clock.advance(60_000);
    f.clock.scheduled[0].callback();
    expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
    expect(f.failures).toEqual([]);
  });

  it.each(["throw", "reject"] as const)(
    "contains an expiry callback failure when reporting can %s",
    async (mode) => {
      const delivered = deferred<boolean>();
      const f = fixture({
        deliver: () => delivered.promise,
        report() {
          if (mode === "throw") throw new Error("diagnostic failed");
          return Promise.reject(new Error("diagnostic failed"));
        },
      });
      const preparing = f.broker.prepare({ socket: f.socket, request: request("timer-error") });
      const ticket = prepared(f.frames[0]);
      const original = new Error("clock unavailable");
      f.clock.failure = original;
      f.clock.advance(60_000);
      expect(() => f.clock.wakeDue()).not.toThrow();
      await preparing;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.failures).toEqual([original]);
      expect(f.broker.diagnostic).toBe(original);
      expect(f.clock.pending()).toEqual([]);
      delivered.resolve(true);
      expect(() => f.broker.redeem(ticket)).toThrow("invalid-bootstrap");
      await expect(prepare({ f, attemptId: "after-clock-failure" })).rejects.toThrow("unavailable");
    },
  );
});
