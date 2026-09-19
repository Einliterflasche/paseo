import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { openPreviewAuthorityClient } from "./authority-client.js";
import { openPreviewAuthorityServer } from "./authority-server.js";
import { PreviewBroker, type PreviewAuthorizedJob } from "./broker.js";
import {
  PreviewBrokerMessageSchema,
  type PreviewBrokerMessage,
  type PreviewGatewayMessage,
  type PreviewChannel,
} from "./channel.js";
import { PREVIEW_WATCHDOG_MS, type PreviewClock } from "./clock.js";
import { PreviewRoutes } from "./routes.js";
import { PREVIEW_SOURCE_CAPABILITY, PreviewSources } from "./sources.js";

const channelId = "isolated-preview-channel";
const cleanups: Array<() => void> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface ClockTask {
  due: number;
  callback(): void;
}
class ManualClock implements PreviewClock {
  private time = 0;
  private readonly tasks = new Set<ClockTask>();
  now() {
    return this.time;
  }
  schedule({ delayMs, callback }: { delayMs: number; callback(): void }) {
    const task = { due: this.time + delayMs, callback };
    this.tasks.add(task);
    return () => {
      this.tasks.delete(task);
    };
  }
  jumpTo(time: number) {
    if (time < this.time) throw new Error("Clock cannot run backwards");
    this.time = time;
  }
  advanceTo(time: number) {
    this.jumpTo(time);
    for (;;) {
      const next = [...this.tasks].sort((a, b) => a.due - b.due)[0];
      if (!next || next.due > this.time) return;
      this.tasks.delete(next);
      next.callback();
    }
  }
}

/** Real ordered MessagePorts, with an explicit queue for delaying one direction. */
class PortChannel<Outgoing> implements PreviewChannel<Outgoing> {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly sent: Outgoing[] = [];
  readonly received: unknown[] = [];
  private readonly receivers = new Set<(message: unknown) => void>();
  private paused = false;
  private readonly queued: Outgoing[] = [];
  private unsubscribeFailure: Error | null = null;
  private closeFailure: Error | null = null;

  constructor(private readonly port: MessagePort) {
    port.on("message", (message: unknown) => {
      this.received.push(message);
      for (const receive of this.receivers) receive(message);
    });
    port.on("close", () => this.controller.abort());
  }
  send(message: Outgoing) {
    if (this.signal.aborted) throw new Error("Test channel closed");
    const copy = structuredClone(message);
    this.sent.push(copy);
    if (this.paused) this.queued.push(copy);
    else this.port.postMessage(copy, []);
  }
  subscribe(receive: (message: unknown) => void) {
    this.receivers.add(receive);
    return () => {
      this.receivers.delete(receive);
      const failure = this.unsubscribeFailure;
      this.unsubscribeFailure = null;
      if (failure) throw failure;
    };
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    for (const message of this.queued.splice(0)) this.port.postMessage(message, []);
  }
  /** Fault injection only; bypasses the typed application send contract. */
  sendRaw(message: unknown) {
    this.port.postMessage(message, []);
  }
  failCleanup(step: "unsubscribe" | "close", error: Error) {
    if (step === "unsubscribe") this.unsubscribeFailure = error;
    else this.closeFailure = error;
  }
  close() {
    if (this.signal.aborted) return;
    this.controller.abort();
    this.port.close();
    const failure = this.closeFailure;
    this.closeFailure = null;
    if (failure) throw failure;
  }
}

function transport() {
  const { port1, port2 } = new MessageChannel();
  const gateway = new PortChannel<PreviewGatewayMessage>(port1);
  const parent = new PortChannel<PreviewBrokerMessage>(port2);
  cleanups.push(() => {
    gateway.close();
    parent.close();
  });
  return { gateway, parent };
}

interface FixtureOptions {
  client?: boolean;
  brokerClass?: typeof PreviewBroker;
  onClosed?(): void | Promise<void>;
  onFailure?(error: unknown): void | Promise<void>;
}
function fixture({
  client: createClient = true,
  brokerClass = PreviewBroker,
  onClosed,
  onFailure,
}: FixtureOptions = {}) {
  const ports = transport();
  const clock = new ManualClock();
  const sources = new PreviewSources("https://control.test");
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  routes.register({ serviceId: "atlas", port: 5173, mount: "preserve" });
  const failures: unknown[] = [];
  const broker = new brokerClass({
    sources,
    routes,
    onFailure: (error) => {
      failures.push(error);
    },
  });
  const frames: string[] = [];
  const socket = { readyState: 1 };
  sources.admitDirectOwner({
    socket,
    connectionId: "physical-source",
    principalId: "owner",
    origin: "https://control.test",
    permissions: OWNER_PERMISSIONS,
    send: async (frame) => {
      frames.push(frame);
      return true;
    },
  });
  sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
  let closed = 0;
  const server = openPreviewAuthorityServer({
    channelId,
    channel: ports.parent,
    broker,
    onClosed() {
      closed += 1;
      return onClosed?.();
    },
    onFailure(error) {
      failures.push(error);
      return onFailure?.(error);
    },
  });
  const client = createClient
    ? openPreviewAuthorityClient({ channelId, channel: ports.gateway, clock })
    : null;
  cleanups.push(() => {
    client?.close();
    server.close();
    broker.close();
    sources.close();
    routes.close();
  });
  let attempt = 0;
  async function issue(browserHandle = "channel-profile") {
    const attemptId = `open-${++attempt}`;
    await broker.prepare({
      socket,
      request: {
        type: "service.preview.prepare.request",
        requestId: `prepare-${attemptId}`,
        attemptId,
        browserHandle,
        serviceId: "atlas",
        mode: "iframe",
      },
    });
    const reply = ServicePreviewPrepareResponseMessageSchema.parse(
      JSON.parse(frames.at(-1)!).message,
    );
    if (reply.payload.result.status !== "prepared") throw new Error("Expected prepared ticket");
    return reply.payload.result;
  }
  return {
    ...ports,
    clock,
    sources,
    routes,
    broker,
    server,
    client,
    failures,
    frames,
    issue,
    closed: () => closed,
    closeAttempt(attemptId: string) {
      return broker.closeAttempt({
        socket,
        request: {
          type: "service.preview.close.request",
          requestId: `close-${attemptId}`,
          attemptId,
        },
      });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

async function open(f: Fixture, browserHandle?: string) {
  if (!f.client) throw new Error("Expected client");
  const ticket = await f.issue(browserHandle);
  const credential = await f.client.redeem(ticket);
  const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
  const contribution = await f.client.confirm({
    ...credential,
    cookieHeader,
  });
  return { ticket, credential, contribution, cookieHeader, serviceId: credential.serviceId };
}

async function holdWork(f: Fixture, authority: { cookieHeader: string; serviceId: string }) {
  if (!f.client) throw new Error("Expected client");
  const captured = deferred<PreviewAuthorizedJob>();
  const work = deferred<void>();
  const writes: string[] = [];
  const write = () => {
    writes.push("late bytes");
    return "late bytes";
  };
  const result = f.client
    .run(authority, async (job) => {
      captured.resolve(job);
      // This models a real caller's still-settling teardown, outside cancellable wait.
      await work.promise;
      return job.write(write);
    })
    .catch(messageOf);
  const job = await captured.promise;
  return { job, work, result, writes };
}

function replies(port: PortChannel<PreviewBrokerMessage>) {
  return port.sent.filter((message) => message.type !== "acknowledge");
}
function approvals(port: PortChannel<PreviewBrokerMessage>) {
  return port.sent.filter((message) => message.type === "authorized");
}
function cancellations(port: PortChannel<PreviewGatewayMessage>) {
  return port.sent.filter((message) => message.type === "cancelled");
}
function redemptionRequests(port: PortChannel<PreviewGatewayMessage>) {
  return port.sent.filter((message) => message.type === "redeem");
}
function redeemedReplies(port: PortChannel<PreviewBrokerMessage>) {
  return port.sent.filter((message) => message.type === "redeemed");
}
function snapshotReplies(port: PortChannel<PreviewGatewayMessage>) {
  return port.received.map((message) => PreviewBrokerMessageSchema.parse(message));
}

/** One explicit interleaving at a real broker guard; all authority remains real. */
class CommitBoundaryBroker extends PreviewBroker {
  private beforeWrite: (() => void) | null = null;

  interruptNextGuardedWrite(work: () => void) {
    this.beforeWrite = work;
  }

  override run<T>(
    input: Parameters<PreviewBroker["run"]>[0],
    work: (job: PreviewAuthorizedJob) => T | PromiseLike<T>,
  ): Promise<T> {
    return super.run(input, (job) =>
      work({
        ...job,
        write: <V>(action: () => V): V => {
          const interruption = this.beforeWrite;
          this.beforeWrite = null;
          interruption?.();
          return job.write(action);
        },
      }),
    );
  }
}

async function clientOnly() {
  const ports = transport();
  const clock = new ManualClock();
  const client = openPreviewAuthorityClient({ channelId, channel: ports.gateway, clock });
  cleanups.push(() => client.close());
  await expect.poll(() => ports.gateway.sent.length).toBe(1);
  const probe = ports.gateway.sent[0];
  if (probe.type !== "probe") throw new Error("Expected watchdog probe");
  ports.parent.send({ channelId, type: "acknowledge", challenge: probe.challenge });
  await expect.poll(() => ports.gateway.received.length).toBe(1);
  return { ...ports, clock, client };
}

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) close();
  await nextTurn();
});

describe("private preview authority channel over MessagePorts", () => {
  it("redeems, confirms and authorizes using current broker authority and monotonic request identities", async () => {
    const f = fixture();
    const opened = await open(f);
    expect(opened.contribution).toEqual({
      serviceId: "atlas",
      attemptId: opened.ticket.attemptId,
      mode: "iframe",
    });
    const writeHtml = () => "<!doctype html><h1>React fixture</h1>";
    const html = await f.client!.run(opened, (job) => {
      expect(job.route).toEqual({ serviceId: "atlas", port: 5173, mount: "preserve" });
      expect(job.signal.aborted).toBe(false);
      return job.write(writeHtml);
    });
    expect(html).toContain("React fixture");
    const requests = f.gateway.sent.filter(
      (message) =>
        message.type === "redeem" || message.type === "confirm" || message.type === "authorize",
    );
    expect(requests.map((message) => message.requestId)).toEqual([1, 2, 3]);
    expect(f.frames[0]).not.toContain(opened.credential.cookieValue);
    expect(f.failures).toEqual([]);
  });

  it.each(["success", "failure"] as const)("terminalizes local guards on work %s", async (kind) => {
    const f = fixture();
    const authority = await open(f);
    const captured = deferred<PreviewAuthorizedJob>();
    const result = f
      .client!.run(authority, (job) => {
        captured.resolve(job);
        if (kind === "failure") throw new Error("local-work-failed");
        return "complete";
      })
      .catch(messageOf);
    expect(await result).toBe(kind === "failure" ? "local-work-failed" : "complete");
    const job = await captured.promise;
    expect(job.signal.aborted).toBe(true);
    let writes = 0;
    const write = () => {
      writes += 1;
    };
    expect(() => job.write(write)).toThrow("authorization-ended");
    await expect(job.wait(write)).rejects.toThrow("authorization-ended");
    expect(writes).toBe(0);
    await expect(f.client!.run(authority, () => "fresh work")).resolves.toBe("fresh work");
    expect(f.failures).toEqual([]);
  });

  it("drains actual revoked work before fresh Open operations, without reviving old guards", async () => {
    const f = fixture();
    const authority = await open(f);
    const old = await holdWork(f, authority);
    await f.closeAttempt(authority.ticket.attemptId);
    await expect.poll(() => old.job.signal.aborted).toBe(true);
    expect(await old.result).toBe("authorization-ended");
    expect(cancellations(f.gateway)).toEqual([]);
    const drained = f.server.settled();
    const sentinel = Symbol("pending drain");
    expect(await Promise.race([drained, Promise.resolve(sentinel)])).toBe(sentinel);
    const freshTicket = await f.issue();
    const freshCredential = Promise.resolve(f.client!.redeem(freshTicket));
    await expect.poll(() => redemptionRequests(f.gateway).length).toBe(2);
    await nextTurn();
    expect(redeemedReplies(f.parent)).toHaveLength(1);
    old.work.resolve();
    const credential = await freshCredential;
    await drained;
    expect(cancellations(f.gateway)).toHaveLength(1);
    expect(old.writes).toEqual([]);
    const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
    await f.client!.confirm({
      bootstrapId: credential.bootstrapId,
      cookieHeader,
      mode: credential.mode,
    });
    const newActivation = await f.client!.run(
      { cookieHeader, serviceId: "atlas" },
      (job) => job.activationId,
    );
    expect(newActivation).not.toBe(old.job.activationId);
    const lateWrite = () => "late write";
    expect(() => old.job.write(lateWrite)).toThrow("authorization-ended");
    expect(old.job.signal.aborted).toBe(true);
    expect(f.failures).toEqual([]);
  });

  it.each(["resolve", "reject"] as const)(
    "retains cancellation ownership for a started wait hook after its wrapper rejects, then hook %s",
    async (outcome) => {
      const f = fixture();
      const authority = await open(f);
      const entered = deferred<void>();
      const hook = deferred<void>();
      const releaseHook = () => {
        if (outcome === "reject") hook.reject(new Error("late hook cleanup failed"));
        else hook.resolve();
      };
      const captured = deferred<PreviewAuthorizedJob>();
      const continuation = () => {
        entered.resolve();
        return hook.promise;
      };
      const result = f
        .client!.run(authority, async (job) => {
          captured.resolve(job);
          await job.wait(continuation);
        })
        .catch(messageOf);
      await entered.promise;
      const job = await captured.promise;
      await f.closeAttempt(authority.ticket.attemptId);
      expect(await result).toBe("authorization-ended");
      expect(job.signal.aborted).toBe(true);
      try {
        await nextTurn();
        expect(cancellations(f.gateway)).toEqual([]);
        const freshTicket = await f.issue();
        const freshCredential = f.client!.redeem(freshTicket);
        await expect.poll(() => redemptionRequests(f.gateway).length).toBe(2);
        await nextTurn();
        expect(redeemedReplies(f.parent)).toHaveLength(1);
        releaseHook();
        await freshCredential;
        expect(cancellations(f.gateway)).toHaveLength(1);
      } finally {
        releaseHook();
      }
    },
  );

  it.each(["unsubscribe", "close"] as const)(
    "still retires the feature owner when channel %s throws",
    async (step) => {
      const f = fixture();
      const authority = await open(f);
      const held = await holdWork(f, authority);
      const original = new Error(`channel-${step}-failed`);
      f.parent.failCleanup(step, original);
      try {
        try {
          f.server.close();
        } catch {
          // The caller may receive the diagnostic; retirement must still happen.
        }
        expect(f.closed()).toBe(1);
        expect(f.parent.signal.aborted).toBe(true);
        expect(await held.result).toBe("authorization-ended");
        expect(held.job.signal.aborted).toBe(true);
      } finally {
        held.work.resolve();
      }
    },
  );

  it.each(["authorize", "confirm"] as const)(
    "rechecks the cancellation barrier inside the final guarded %s commit",
    async (kind) => {
      const f = fixture({ brokerClass: CommitBoundaryBroker });
      if (!(f.broker instanceof CommitBoundaryBroker)) throw new Error("Expected guarded fixture");
      const oldAuthority = await open(f);
      const held = await holdWork(f, oldAuthority);
      const ticket = await f.issue("second-profile");
      const credential = await f.client!.redeem(ticket);
      const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
      const confirmation = {
        bootstrapId: credential.bootstrapId,
        cookieHeader,
        mode: credential.mode,
      };
      if (kind === "authorize") await f.client!.confirm(confirmation);
      const repliesBefore = replies(f.parent).length;
      const boundary = deferred<void>();
      let closing: Promise<void> | undefined;
      f.broker.interruptNextGuardedWrite(() => {
        closing = f.closeAttempt(oldAuthority.ticket.attemptId);
        boundary.resolve();
      });
      const operation =
        kind === "authorize"
          ? f.client!.run({ serviceId: "atlas", cookieHeader }, () => "fresh work")
          : Promise.resolve(f.client!.confirm(confirmation)).then(() => "confirmed");
      void operation.catch(messageOf);
      await boundary.promise;
      try {
        await expect.poll(() => held.job.signal.aborted).toBe(true);
        expect(cancellations(f.gateway)).toEqual([]);
        // Only the invalidation can pass the commit boundary while old work is held.
        expect(
          replies(f.parent)
            .slice(repliesBefore)
            .map((reply) => reply.type),
        ).toEqual(["invalidate"]);
      } finally {
        held.work.resolve();
      }
      expect(await operation).toBe(kind === "authorize" ? "fresh work" : "confirmed");
      await closing;
      expect(await held.result).toBe("authorization-ended");
      expect(cancellations(f.gateway)).toHaveLength(1);
      expect(f.failures).toEqual([]);
    },
  );

  it.each(["gateway", "parent"] as const)(
    "ends pending requests and held jobs on %s channel loss without owning the global broker",
    async (side) => {
      const f = fixture();
      const authority = await open(f);
      const old = await holdWork(f, authority);
      const ticket = await f.issue();
      f.parent.pause();
      const pending = Promise.resolve(f.client!.redeem(ticket)).catch(messageOf);
      await expect.poll(() => redeemedReplies(f.parent).length).toBe(2);
      f[side].close();
      expect(await pending).toBe("authorization-ended");
      expect(await old.result).toBe("authorization-ended");
      expect(old.job.signal.aborted).toBe(true);
      await expect.poll(f.closed).toBe(1);
      expect(f.broker.isClosed).toBe(false);
      await expect(f.broker.run(authority, () => "broker remains owned by feature")).resolves.toBe(
        "broker remains owned by feature",
      );
      old.work.resolve();
      await nextTurn();
      expect(old.writes).toEqual([]);
      f.server.close();
      expect(f.closed()).toBe(1);
    },
  );

  it("rejects a held approval received at its watchdog deadline even before timers run", async () => {
    const f = fixture();
    const authority = await open(f);
    f.parent.pause();
    let entered = false;
    const result = f
      .client!.run(authority, () => {
        entered = true;
        return "must not run";
      })
      .catch(messageOf);
    await expect.poll(() => approvals(f.parent).length).toBe(1);
    f.clock.jumpTo(PREVIEW_WATCHDOG_MS);
    f.parent.resume();
    expect(await result).toBe("authorization-ended");
    expect(entered).toBe(false);
    expect(f.gateway.signal.aborted).toBe(true);
    await expect.poll(f.closed).toBe(1);
    await expect(f.client!.run(authority, () => "late")).rejects.toThrow("authorization-ended");
  });

  it("aborts already-started work when the watchdog expires and contains its eventual rejection", async () => {
    const f = fixture();
    const authority = await open(f);
    const old = await holdWork(f, authority);
    f.clock.advanceTo(PREVIEW_WATCHDOG_MS);
    expect(old.job.signal.aborted).toBe(true);
    expect(await old.result).toBe("authorization-ended");
    old.work.reject(new Error("late-cleanup-error"));
    await nextTurn();
    expect(old.writes).toEqual([]);
    await expect.poll(f.closed).toBe(1);
  });

  it.each(["throw", "reject"] as const)(
    "contains a feature-owner %s failure when closing the channel",
    async (kind) => {
      const original = new Error("feature-close-failed");
      const f = fixture({
        onClosed() {
          if (kind === "throw") throw original;
          return Promise.reject(original);
        },
        onFailure() {
          return Promise.reject(new Error("diagnostic-failed"));
        },
      });
      await open(f);
      f.gateway.close();
      await expect.poll(f.closed).toBe(1);
      await nextTurn();
      expect(f.failures).toContain(original);
      expect(f.broker.isClosed).toBe(false);
    },
  );
});

describe("private authority protocol failures", () => {
  it.each([
    { type: "probe", channelId: "wrong-lifetime", challenge: "probe" },
    { type: "unsupported", channelId },
    { type: "probe", channelId, challenge: "probe", extra: "synthetic-private-credential" },
    { type: "authorize", channelId, requestId: 0, input: { serviceId: "atlas" } },
  ])("closes the server on an invalid epoch or request shape: %j", async (message) => {
    const f = fixture({ client: false });
    f.gateway.sendRaw(message);
    await expect.poll(f.closed).toBe(1);
    expect(f.parent.signal.aborted).toBe(true);
    expect(f.broker.isClosed).toBe(false);
    const expected =
      message.channelId === channelId ? "preview-invalid-message" : "preview-channel-mismatch";
    expect(f.failures.map(messageOf)).toEqual([expected]);
  });

  it.each([7, 6])("rejects fresh request ID %s after consuming 7", async (requestId) => {
    const f = fixture({ client: false });
    const input = { bootstrapId: "unknown", ticket: "unknown", mode: "iframe" as const };
    f.gateway.send({ channelId, type: "redeem", requestId: 7, input });
    await expect.poll(() => replies(f.parent).length).toBe(1);
    expect(replies(f.parent)[0]).toEqual({
      channelId,
      type: "denied",
      requestId: 7,
      code: "invalid-bootstrap",
    });
    f.gateway.send({ channelId, type: "redeem", requestId, input });
    await expect.poll(f.closed).toBe(1);
    expect(f.failures.map(messageOf)).toEqual(["preview-request-reused"]);
  });

  it("refuses an unrequested cancellation acknowledgment", async () => {
    const f = fixture({ client: false });
    f.gateway.send({ channelId, type: "cancelled", requestId: 1 });
    await expect.poll(f.closed).toBe(1);
    expect(f.failures.map(messageOf)).toEqual(["preview-unexpected-cancellation"]);
  });

  it.each([
    {
      message: { channelId, type: "denied", requestId: 999, code: "unavailable" },
      error: "authorization-ended",
    },
    {
      message: { channelId: "old-lifetime", type: "denied", requestId: 1, code: "unavailable" },
      error: "authorization-ended",
    },
    {
      message: { channelId, type: "denied", requestId: 1, code: "unavailable", extra: true },
      error: "authorization-ended",
    },
    {
      message: {
        channelId,
        type: "confirmed",
        requestId: 1,
        contribution: { serviceId: "atlas", attemptId: "open", mode: "iframe" },
      },
      error: "preview-unexpected-reply",
    },
  ])("rejects malformed, unrelated or wrong-operation replies: %j", async ({ message, error }) => {
    const f = await clientOnly();
    const waiting = Promise.resolve(
      f.client.redeem({ bootstrapId: "fixture", ticket: "fixture", mode: "iframe" }),
    ).catch(messageOf);
    await expect.poll(() => f.gateway.sent.length).toBe(2);
    f.parent.sendRaw(message);
    expect(await waiting).toBe(error);
    expect(f.gateway.signal.aborted).toBe(true);
  });

  it("does not accept a duplicated successful reply as fresh authority", async () => {
    const f = await clientOnly();
    const waiting = f.client.redeem({ bootstrapId: "fixture", ticket: "fixture", mode: "iframe" });
    await expect.poll(() => f.gateway.sent.length).toBe(2);
    const credential = {
      bootstrapId: "fixture",
      cookieName: "__Secure-fixture",
      cookieValue: "synthetic",
      serviceId: "atlas",
      mode: "iframe" as const,
    };
    const reply: PreviewBrokerMessage = { channelId, type: "redeemed", requestId: 1, credential };
    f.parent.send(reply);
    expect(await waiting).toEqual(credential);
    f.parent.send(reply);
    await expect.poll(() => f.gateway.signal.aborted).toBe(true);
    expect(snapshotReplies(f.gateway)).toHaveLength(3);
    await expect(
      f.client.run({ cookieHeader: "fixture", serviceId: "atlas" }, () => "must not run"),
    ).rejects.toThrow("authorization-ended");
  });
});
