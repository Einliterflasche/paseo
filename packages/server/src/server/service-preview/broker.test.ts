import { describe, expect, it } from "vitest";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { PreviewSources, PREVIEW_SOURCE_CAPABILITY } from "./sources.js";
import { PreviewRoutes } from "./routes.js";
import { PreviewBroker, type PreviewAuthorizedJob } from "./broker.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function errorMessage(error: Error) {
  return error.message;
}

function fixture(report: (error: unknown) => void | Promise<void> = () => {}) {
  const sources = new PreviewSources("https://control.test");
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  routes.register({ serviceId: "atlas", port: 5173, mount: "preserve" });
  const failures: unknown[] = [];
  const broker = new PreviewBroker({
    sources,
    routes,
    onFailure(error) {
      failures.push(error);
      return report(error);
    },
  });
  function connect(id: string, delivery: (frame: string) => Promise<boolean> = async () => true) {
    const frames: string[] = [];
    let statusFailure: Error | null = null;
    const socket = {
      get readyState() {
        if (statusFailure) {
          const error = statusFailure;
          statusFailure = null;
          throw error;
        }
        return 1;
      },
    };
    sources.admitDirectOwner({
      socket,
      connectionId: id,
      principalId: "owner",
      origin: "https://control.test",
      permissions: OWNER_PERMISSIONS,
      send(frame) {
        frames.push(frame);
        return delivery(frame);
      },
    });
    sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
    return {
      socket,
      frames,
      failNextStatusRead(error: Error) {
        statusFailure = error;
      },
    };
  }
  return { sources, routes, broker, connect, failures };
}

const request = {
  type: "service.preview.prepare.request" as const,
  requestId: "request-a",
  attemptId: "tab-a-open-1",
  browserHandle: "profile-a",
  serviceId: "atlas",
  mode: "iframe" as const,
};

function prepared(frame: string) {
  const response = ServicePreviewPrepareResponseMessageSchema.parse(JSON.parse(frame).message);
  expect(response.payload.requestId).toBeTruthy();
  if (response.payload.result.status !== "prepared") throw new Error("Expected prepared reply");
  return response.payload.result;
}

type Fixture = ReturnType<typeof fixture>;
type Client = ReturnType<Fixture["connect"]>;

async function open({
  f,
  client,
  params = {},
}: {
  f: Fixture;
  client: Client;
  params?: Partial<typeof request>;
}) {
  await f.broker.prepare({ socket: client.socket, request: { ...request, ...params } });
  const reply = prepared(client.frames.at(-1)!);
  const credential = f.broker.redeem(reply);
  const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
  f.broker.confirm({ bootstrapId: reply.bootstrapId, cookieHeader, mode: reply.mode });
  return { reply, credential, cookieHeader };
}

function close(f: Fixture, client: Client, attemptId = request.attemptId) {
  return f.broker.closeAttempt({
    socket: client.socket,
    request: {
      type: "service.preview.close.request",
      requestId: `close-${attemptId}`,
      attemptId,
    },
  });
}

function observeGuardAtAbort(job: PreviewAuthorizedJob) {
  const events: Array<{ aborted: boolean; guard: string }> = [];
  const write = () => "unexpected-write";
  job.signal.addEventListener(
    "abort",
    () => {
      let guard: string;
      try {
        guard = job.write(write);
      } catch (error) {
        guard = error instanceof Error ? error.message : String(error);
      }
      events.push({ aborted: job.signal.aborted, guard });
    },
    { once: true },
  );
  return events;
}

function holdAuthorizedJob(f: Fixture, cookieHeader: string) {
  const captured = deferred<PreviewAuthorizedJob>();
  const entered = deferred<void>();
  const held = deferred<void>();
  const outcome = f.broker
    .run({ cookieHeader, serviceId: "atlas" }, async (job) => {
      captured.resolve(job);
      await job.wait(() => {
        entered.resolve();
        return held.promise;
      });
      return job.write(() => "unexpected old bytes");
    })
    .catch(errorMessage);
  return { captured, entered, held, outcome };
}

describe("local preview broker", () => {
  it.each(["throw", "reject"])(
    "ends every pending job when an observer fails and reporting can %s",
    async (mode) => {
      const reportingFailure = new Error("reporting-failed");
      const f = fixture(() => {
        if (mode === "throw") throw reportingFailure;
        return Promise.reject(reportingFailure);
      });
      const a = f.connect("a");
      const b = f.connect("b");
      const { cookieHeader } = await open({ f, client: a });
      await open({ f, client: b });
      const entered = [deferred<void>(), deferred<void>()];
      const held = deferred<void>();
      const pending = () => held.promise;
      let writes = 0;
      const write = () => {
        writes += 1;
      };
      const jobs: Promise<void | string>[] = [];
      for (const entry of entered) {
        const work = async (job: PreviewAuthorizedJob) => {
          entry.resolve();
          await job.wait(pending);
          job.write(write);
        };
        jobs.push(f.broker.run({ cookieHeader, serviceId: "atlas" }, work).catch(errorMessage));
      }
      await Promise.all(entered.map((entry) => entry.promise));
      const original = new Error("status-read-failed");
      b.failNextStatusRead(original);
      f.sources.detach(a.socket);
      expect(await Promise.all(jobs)).toEqual(["authorization-ended", "authorization-ended"]);
      held.resolve();
      // Give returned reporter rejections their ordinary unhandled-rejection turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.broker.diagnostic).toBe(original);
      expect(f.failures).toEqual([original]);
      expect(writes).toBe(0);
    },
  );

  it("makes a successfully completed job terminal", async () => {
    const f = fixture();
    const client = f.connect("a");
    const { cookieHeader } = await open({ f, client });
    const aborts: Array<ReturnType<typeof observeGuardAtAbort>> = [];
    const job = await f.broker.run({ cookieHeader, serviceId: "atlas" }, (current) => {
      expect(current.signal.aborted).toBe(false);
      aborts.push(observeGuardAtAbort(current));
      return current;
    });
    expect(job.signal.aborted).toBe(true);
    expect(aborts).toEqual([[{ aborted: true, guard: "authorization-ended" }]]);
    let writes = 0;
    const write = () => {
      writes += 1;
    };
    expect(() => job.write(write)).toThrow("authorization-ended");
    await expect(job.wait(write)).rejects.toThrow("authorization-ended");
    expect(writes).toBe(0);
  });

  it("ends another held branch when a job fails and rejects its late guards", async () => {
    const f = fixture();
    const client = f.connect("a");
    const { cookieHeader } = await open({ f, client });
    const held = deferred<void>();
    const started = deferred<void>();
    const captured = deferred<PreviewAuthorizedJob>();
    const branch = deferred<Promise<unknown>>();
    let writes = 0;
    const write = () => {
      writes += 1;
    };
    const pending = () => {
      started.resolve();
      return held.promise;
    };
    const aborts: Array<ReturnType<typeof observeGuardAtAbort>> = [];
    async function work(job: PreviewAuthorizedJob) {
      aborts.push(observeGuardAtAbort(job));
      captured.resolve(job);
      const other = job.wait(pending).then(() => job.write(write));
      const observed = other.catch(errorMessage);
      branch.resolve(observed);
      await started.promise;
      throw new Error("work-failed");
    }
    const outcome = f.broker.run({ cookieHeader, serviceId: "atlas" }, work);
    await expect(outcome).rejects.toThrow("work-failed");
    const job = await captured.promise;
    expect(job.signal.aborted).toBe(true);
    expect(aborts).toEqual([[{ aborted: true, guard: "authorization-ended" }]]);
    expect(await branch.promise).toBe("authorization-ended");
    held.resolve();
    await expect(job.wait(write)).rejects.toThrow("authorization-ended");
    expect(() => job.write(write)).toThrow("authorization-ended");
    expect(writes).toBe(0);
  });

  it("aborts held job signals synchronously after the last Close and never revives old guards", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    const { cookieHeader } = await open({ f, client: a });
    await open({ f, client: b });
    const held = [holdAuthorizedJob(f, cookieHeader), holdAuthorizedJob(f, cookieHeader)];
    await Promise.all(held.map((entry) => entry.entered.promise));
    const jobs = await Promise.all(held.map((entry) => entry.captured.promise));
    let microtaskRan = false;
    let writes = 0;
    const write = () => {
      writes += 1;
    };
    const aborts: Array<{ aborted: boolean; microtaskRan: boolean; guard: string }> = [];
    for (const job of jobs) {
      job.signal.addEventListener(
        "abort",
        () => {
          let guard = "returned";
          try {
            job.write(write);
          } catch (error) {
            guard = error instanceof Error ? error.message : String(error);
          }
          aborts.push({ aborted: job.signal.aborted, microtaskRan, guard });
        },
        { once: true },
      );
    }
    const firstClose = close(f, a);
    expect(jobs.map((job) => job.signal.aborted)).toEqual([false, false]);
    expect(aborts).toEqual([]);
    await firstClose;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    const lastClose = close(f, b);
    // No await: event consumers can stop their transport before Close returns to its caller.
    expect(jobs.map((job) => job.signal.aborted)).toEqual([true, true]);
    expect(aborts).toEqual([
      { aborted: true, microtaskRan: false, guard: "authorization-ended" },
      { aborted: true, microtaskRan: false, guard: "authorization-ended" },
    ]);
    await lastClose;
    expect(await Promise.all(held.map((entry) => entry.outcome))).toEqual([
      "authorization-ended",
      "authorization-ended",
    ]);
    await open({ f, client: a, params: { attemptId: "fresh-open" } });
    for (const job of jobs) {
      expect(job.signal.aborted).toBe(true);
      expect(() => job.write(write)).toThrow("authorization-ended");
      await expect(job.wait(write)).rejects.toThrow("authorization-ended");
    }
    for (const entry of held) entry.held.resolve();
    await Promise.resolve();
    expect(writes).toBe(0);
    expect(aborts).toHaveLength(2);
    expect(f.failures).toEqual([]);
    f.broker.close();
  });

  it("does not issue when exact-source delivery fails", async () => {
    const f = fixture();
    const client = f.connect("a", async () => false);
    await f.broker.prepare({ socket: client.socket, request });
    expect(() => f.broker.redeem(prepared(client.frames[0]))).toThrow("invalid-bootstrap");
    expect(f.failures).toEqual([]);
  });

  it.each(["permission-restoration", "route-replacement", "detach"])(
    "invalidates held issuance on %s without waiting for its send callback",
    async (kind) => {
      const f = fixture();
      const delivery = deferred<boolean>();
      const send = () => delivery.promise;
      const client = f.connect("a", send);
      const pending = f.broker.prepare({ socket: client.socket, request });
      const reply = prepared(client.frames[0]);
      if (kind === "permission-restoration") {
        f.sources.replacePrincipalPermissions("owner", []);
        f.sources.replacePrincipalPermissions("owner", OWNER_PERMISSIONS);
      }
      if (kind === "route-replacement")
        f.routes.replace({ serviceId: "atlas", port: 5174, mount: "strip" });
      if (kind === "detach") f.sources.detach(client.socket);
      await pending;
      delivery.resolve(true);
      await Promise.resolve();
      expect(() => f.broker.redeem(reply)).toThrow("invalid-bootstrap");
      expect(f.failures).toEqual([]);
    },
  );

  it("uses one-use bootstrap and confirms cookies before authorizing application work", async () => {
    const f = fixture();
    const client = f.connect("a");
    await f.broker.prepare({ socket: client.socket, request });
    const reply = prepared(client.frames[0]);
    const credential = f.broker.redeem(reply);
    const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
    expect(client.frames[0]).not.toContain(credential.cookieValue);
    expect(() => f.broker.redeem(reply)).toThrow("invalid-bootstrap");
    const work = () => "should not run";
    await expect(f.broker.run({ cookieHeader, serviceId: "atlas" }, work)).rejects.toThrow(
      "authorization-ended",
    );
    expect(() =>
      f.broker.confirm({
        bootstrapId: reply.bootstrapId,
        cookieHeader: cookieHeader + "; " + cookieHeader,
        mode: reply.mode,
      }),
    ).toThrow("invalid-confirmation");
    await close(f, client);
    expect(() =>
      f.broker.confirm({ bootstrapId: reply.bootstrapId, cookieHeader, mode: reply.mode }),
    ).toThrow("invalid-confirmation");
  });

  it("keeps shared authority when one contributor closes and scopes Close to its physical source", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    const first = await open({ f, client: a });
    const second = await open({ f, client: b });
    expect(first.cookieHeader).toBe(second.cookieHeader);
    const identity = (job: { activationId: string }) => job.activationId;
    const authority = { cookieHeader: first.cookieHeader, serviceId: "atlas" };
    const original = await f.broker.run(authority, identity);
    await close(f, b);
    expect(await f.broker.run(authority, identity)).toBe(original);
    await close(f, a);
    await expect(f.broker.run(authority, identity)).rejects.toThrow("authorization-ended");
    const reopened = await open({ f, client: a, params: { attemptId: "a-open-2" } });
    expect(reopened.cookieHeader).toBe(first.cookieHeader);
    expect(await f.broker.run(authority, identity)).not.toBe(original);
  });

  it.each(["issued", "pending", "active"] as const)(
    "keeps a closed %s attempt terminal while a new physical source reuses its client-known ID",
    async (phase) => {
      const f = fixture();
      const original = f.connect("original");
      await f.broker.prepare({ socket: original.socket, request });
      const reply = prepared(original.frames[0]);
      const credential = phase === "issued" ? null : f.broker.redeem(reply);
      const cookieHeader = credential
        ? `${credential.cookieName}=${credential.cookieValue}`
        : undefined;
      const confirmation = { bootstrapId: reply.bootstrapId, cookieHeader, mode: reply.mode };
      if (phase === "active") f.broker.confirm(confirmation);
      await close(f, original);
      expect(() => f.broker.redeem(reply)).toThrow("invalid-bootstrap");
      expect(() => f.broker.confirm(confirmation)).toThrow("invalid-confirmation");
      await f.broker.prepare({ socket: original.socket, request });
      expect(
        ServicePreviewPrepareResponseMessageSchema.parse(
          JSON.parse(original.frames.at(-1)!).message,
        ).payload.result,
      ).toEqual({ status: "error", code: "duplicate-attempt" });
      const replacement = f.connect("replacement");
      const fresh = await open({ f, client: replacement });
      expect(fresh.reply.attemptId).toBe(reply.attemptId);
      expect(fresh.reply.bootstrapId).not.toBe(reply.bootstrapId);
      const authority = { cookieHeader: fresh.cookieHeader, serviceId: "atlas" };
      expect(await f.broker.run(authority, () => "new source")).toBe("new source");
      // Repeating Close from the old source cannot touch the newer same-ID Open.
      await close(f, original);
      expect(() => f.broker.confirm(confirmation)).toThrow("invalid-confirmation");
      expect(await f.broker.run(authority, () => "still open")).toBe("still open");
      f.sources.detach(original.socket);
      expect(await f.broker.run(authority, () => "old source detached")).toBe(
        "old source detached",
      );
      f.broker.close();
    },
  );

  it("retires old confirmed sessions even when the newest cookie belongs to a pending session", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    const c = f.connect("c");
    const first = await open({ f, client: a });
    const second = await open({ f, client: b, params: { browserHandle: "profile-b" } });
    await f.broker.prepare({
      socket: c.socket,
      request: { ...request, browserHandle: "profile-c" },
    });
    const third = f.broker.redeem(prepared(c.frames[0]));
    const cookieHeader = [
      first.cookieHeader,
      second.cookieHeader,
      `${third.cookieName}=${third.cookieValue}`,
    ].join("; ");
    const identity = (job: { activationId: string }) => job.activationId;
    await expect(f.broker.run({ cookieHeader, serviceId: "atlas" }, identity)).rejects.toThrow(
      "authorization-ended",
    );
    await expect(
      f.broker.run({ cookieHeader: first.cookieHeader, serviceId: "atlas" }, identity),
    ).rejects.toThrow("authorization-ended");
    await expect(
      f.broker.run({ cookieHeader: second.cookieHeader, serviceId: "atlas" }, identity),
    ).resolves.toBeTypeOf("string");
    await f.broker.prepare({ socket: a.socket, request: { ...request, attemptId: "a-return" } });
    expect(JSON.parse(a.frames.at(-1)!).message.payload.result).toEqual({
      status: "error",
      code: "browser-session-replaced",
    });
    const recovered = await open({
      f,
      client: a,
      params: { attemptId: "a-recover", browserHandle: "fresh-profile-a" },
    });
    expect(recovered.cookieHeader).not.toBe(first.cookieHeader);
  });

  it("ends held work on route replacement and does not start later writes", async () => {
    const f = fixture();
    const client = f.connect("a");
    const { cookieHeader } = await open({ f, client });
    const held = deferred<void>();
    const entered = deferred<void>();
    let writes = 0;
    const pending = () => held.promise;
    const write = () => {
      writes += 1;
    };
    const work = async (job: import("./broker.js").PreviewAuthorizedJob) => {
      expect(job.route.port).toBe(5173);
      entered.resolve();
      await job.wait(pending);
      job.write(write);
    };
    const outcome = f.broker
      .run({ cookieHeader, serviceId: "atlas" }, work)
      .catch((error) => error.code);
    await entered.promise;
    f.routes.replace({ serviceId: "atlas", port: 5174, mount: "preserve" });
    expect(await outcome).toBe("authorization-ended");
    held.resolve();
    await Promise.resolve();
    expect(writes).toBe(0);
    expect(f.failures).toEqual([]);
  });
  it("keeps an early Close terminal if its Prepare has not been dispatched yet", async () => {
    const { broker, connect } = fixture();
    const source = connect("source-a");
    await broker.closeAttempt({
      socket: source.socket,
      request: {
        type: "service.preview.close.request",
        requestId: "early-close",
        attemptId: request.attemptId,
      },
    });
    await broker.prepare({ socket: source.socket, request });
    expect(JSON.parse(source.frames.at(-1)!).message.payload.result).toEqual({
      status: "error",
      code: "duplicate-attempt",
    });
  });
  it("keeps a delivered ticket provisional and allows Close using only the caller's attempt ID", async () => {
    const { broker, connect } = fixture();
    const held = deferred<boolean>();
    const source = connect("source-a", (frame) =>
      JSON.parse(frame).message.type === "service.preview.prepare.response"
        ? held.promise
        : Promise.resolve(true),
    );
    const preparing = broker.prepare({ socket: source.socket, request });
    const reply = prepared(source.frames[0]);
    expect(() => broker.redeem(reply)).toThrow("invalid-bootstrap");
    await broker.closeAttempt({
      socket: source.socket,
      request: {
        type: "service.preview.close.request",
        requestId: "close-a",
        attemptId: request.attemptId,
      },
    });
    await preparing;
    held.resolve(true);
    await Promise.resolve();
    expect(() => broker.redeem(reply)).toThrow("invalid-bootstrap");
    await broker.prepare({ socket: source.socket, request });
    expect(JSON.parse(source.frames.at(-1)!).message.payload.result).toEqual({
      status: "error",
      code: "duplicate-attempt",
    });
  });

  it("does not reuse an unsupported activation when a new contributor confirms before notifications run", async () => {
    const { broker, sources, connect } = fixture();
    const a = connect("source-a");
    const b = connect("source-b");
    await broker.prepare({ socket: a.socket, request });
    const first = prepared(a.frames[0]);
    const credential = broker.redeem(first);
    const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
    broker.confirm({ bootstrapId: first.bootstrapId, cookieHeader, mode: first.mode });
    const entered = deferred<void>();
    const captured = deferred<PreviewAuthorizedJob>();
    const held = deferred<void>();
    let oldActivation = "";
    const pending = () => held.promise;
    const write = () => "old write";
    const oldWork = broker.run({ cookieHeader, serviceId: "atlas" }, async (job) => {
      oldActivation = job.activationId;
      captured.resolve(job);
      entered.resolve();
      await job.wait(pending);
      return job.write(write);
    });
    const oldOutcome = oldWork.catch((error) => error.code);
    await entered.promise;
    const oldJob = await captured.promise;
    const source = sources.capture(a.socket);
    if (!source) throw new Error("Expected live source");
    let notificationObserved = false;
    void source.invalidated.then(() => {
      notificationObserved = true;
      return undefined;
    });
    const aborts: boolean[] = [];
    const admissionAtAbort: Array<Promise<string>> = [];
    const duringAbort = () => "new-authority-was-visible";
    oldJob.signal.addEventListener(
      "abort",
      () => {
        aborts.push(notificationObserved);
        admissionAtAbort.push(
          broker.run({ cookieHeader, serviceId: "atlas" }, duringAbort).catch(errorMessage),
        );
      },
      { once: true },
    );
    await broker.prepare({ socket: b.socket, request: { ...request, attemptId: "tab-b-open-1" } });
    const second = prepared(b.frames[0]);
    broker.redeem(second);
    sources.negotiate(a.socket, null);
    // Deliberately no await: the source notification consumer has not run.
    broker.confirm({ bootstrapId: second.bootstrapId, cookieHeader, mode: second.mode });
    expect(notificationObserved).toBe(false);
    expect(oldJob.signal.aborted).toBe(true);
    expect(aborts).toEqual([false]);
    const newActivation = await broker.run(
      { cookieHeader, serviceId: "atlas" },
      (job) => job.activationId,
    );
    expect(newActivation).not.toBe(oldActivation);
    expect(await Promise.all(admissionAtAbort)).toEqual(["authorization-ended"]);
    expect(oldJob.signal.aborted).toBe(true);
    expect(() => oldJob.write(write)).toThrow("authorization-ended");
    expect(await oldOutcome).toBe("authorization-ended");
    held.resolve();
    expect(await oldOutcome).toBe("authorization-ended");
  });
  it("keeps fresh authority confirmed during an old activation's cancellation", async () => {
    const f = fixture();
    const oldClient = f.connect("old-source");
    const freshClient = f.connect("fresh-source");
    const { cookieHeader } = await open({ f, client: oldClient });
    const old = holdAuthorizedJob(f, cookieHeader);
    await old.entered.promise;
    const oldJob = await old.captured.promise;
    const freshAttempt = { ...request, attemptId: "fresh-during-cancellation" };
    await f.broker.prepare({ socket: freshClient.socket, request: freshAttempt });
    const reply = prepared(freshClient.frames.at(-1)!);
    const credential = f.broker.redeem(reply);
    expect(`${credential.cookieName}=${credential.cookieValue}`).toBe(cookieHeader);
    const freshCaptured = deferred<PreviewAuthorizedJob>();
    const freshHeld = deferred<void>();
    const freshOutcome = deferred<Promise<string>>();
    const callbackResults: string[] = [];
    const waitFresh = () => freshHeld.promise;
    const freshBytes = () => "fresh bytes";
    const freshWork = async (job: PreviewAuthorizedJob) => {
      freshCaptured.resolve(job);
      await job.wait(waitFresh);
      return job.write(freshBytes);
    };
    let forbiddenWrites = 0;
    const forbiddenWrite = () => {
      forbiddenWrites += 1;
    };
    oldJob.signal.addEventListener(
      "abort",
      () => {
        try {
          f.broker.confirm({ bootstrapId: reply.bootstrapId, cookieHeader, mode: reply.mode });
          freshOutcome.resolve(
            f.broker.run({ cookieHeader, serviceId: "atlas" }, freshWork).catch(errorMessage),
          );
          try {
            oldJob.write(forbiddenWrite);
          } catch (error) {
            callbackResults.push(error instanceof Error ? error.message : String(error));
          }
        } catch (error) {
          callbackResults.push(`confirmation-failed:${String(error)}`);
        }
      },
      { once: true },
    );
    try {
      const closing = close(f, oldClient);
      expect(callbackResults).toEqual(["authorization-ended"]);
      expect(oldJob.signal.aborted).toBe(true);
      await closing;
      expect(await old.outcome).toBe("authorization-ended");
      const freshJob = await freshCaptured.promise;
      expect(freshJob.activationId).not.toBe(oldJob.activationId);
      expect(freshJob.signal.aborted).toBe(false);
      expect(freshJob.write(() => "still authorized")).toBe("still authorized");
      old.held.resolve();
      await expect(oldJob.wait(forbiddenWrite)).rejects.toThrow("authorization-ended");
      expect(() => oldJob.write(forbiddenWrite)).toThrow("authorization-ended");
      expect(forbiddenWrites).toBe(0);
      freshHeld.resolve();
      expect(await freshOutcome.promise).toBe("fresh bytes");
      expect(f.failures).toEqual([]);
    } finally {
      f.broker.close();
      old.held.resolve();
      freshHeld.resolve();
    }
  });

  it("shutdown cancels every live activation and held issuance without reviving late work", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    const first = await open({ f, client: a });
    const second = await open({ f, client: b, params: { browserHandle: "profile-b" } });
    const held = [
      holdAuthorizedJob(f, first.cookieHeader),
      holdAuthorizedJob(f, second.cookieHeader),
    ];
    await Promise.all(held.map((entry) => entry.entered.promise));
    const jobs = await Promise.all(held.map((entry) => entry.captured.promise));
    const delivery = deferred<boolean>();
    const issuing = f.connect("held-delivery", () => delivery.promise);
    const preparing = f.broker.prepare({ socket: issuing.socket, request });
    const issuedReply = prepared(issuing.frames[0]);
    const confirming = f.connect("pending-confirmation");
    await f.broker.prepare({ socket: confirming.socket, request });
    const confirmReply = prepared(confirming.frames[0]);
    const credential = f.broker.redeem(confirmReply);
    const confirmation = {
      bootstrapId: confirmReply.bootstrapId,
      cookieHeader: `${credential.cookieName}=${credential.cookieValue}`,
      mode: confirmReply.mode,
    };
    const aborts = jobs.map(observeGuardAtAbort);
    const stopping = f.broker.shutdown();
    expect(f.broker.isClosed).toBe(true);
    expect(jobs.map((job) => job.signal.aborted)).toEqual([true, true]);
    expect(aborts).toEqual([
      [{ aborted: true, guard: "authorization-ended" }],
      [{ aborted: true, guard: "authorization-ended" }],
    ]);
    await stopping;
    await preparing;
    expect(await Promise.all(held.map((entry) => entry.outcome))).toEqual([
      "authorization-ended",
      "authorization-ended",
    ]);
    delivery.resolve(true);
    for (const entry of held) entry.held.resolve();
    await Promise.resolve();
    expect(() => f.broker.redeem(issuedReply)).toThrow("invalid-bootstrap");
    expect(() => f.broker.confirm(confirmation)).toThrow("invalid-confirmation");
    let writes = 0;
    const write = () => {
      writes += 1;
    };
    const before = f.broker.reconciliationWork;
    for (const job of jobs) {
      expect(() => job.write(write)).toThrow("authorization-ended");
      await expect(job.wait(write)).rejects.toThrow("authorization-ended");
    }
    expect(f.broker.reconciliationWork).toEqual(before);
    expect(writes).toBe(0);
    await expect(
      f.broker.run({ cookieHeader: first.cookieHeader, serviceId: "atlas" }, write),
    ).rejects.toThrow("authorization-ended");
    await expect(
      f.broker.prepare({ socket: a.socket, request: { ...request, attemptId: "after-close" } }),
    ).rejects.toThrow("unavailable");
    expect(f.failures).toEqual([]);
    await f.broker.shutdown();
  });

  it("keeps reconciliation work fixed as closed session and period history grows", async () => {
    const f = fixture();
    const liveClient = f.connect("live-source");
    const historyClient = f.connect("history-source");
    const live = await open({ f, client: liveClient });
    const held = holdAuthorizedJob(f, live.cookieHeader);
    await held.entered.promise;
    const job = await held.captured.promise;
    const identity = (current: PreviewAuthorizedJob) => current.activationId;
    const measure = () => {
      const before = f.broker.reconciliationWork;
      expect(job.write(() => "live bytes")).toBe("live bytes");
      const after = f.broker.reconciliationWork;
      return {
        attempts: after.attempts - before.attempts,
        activations: after.activations - before.activations,
      };
    };
    const original = measure();
    expect(original).toEqual({ attempts: 1, activations: 1 });
    const history: Array<Awaited<ReturnType<typeof open>>> = [];
    let completed = 0;
    try {
      for (const total of [4, 16, 64]) {
        while (completed < total) {
          const suffix = String(completed);
          const sessionAttempt = `session-${suffix}`;
          const oldSession = await open({
            f,
            client: historyClient,
            params: {
              attemptId: sessionAttempt,
              browserHandle: `historical-profile-${suffix}`,
            },
          });
          history.push(oldSession);
          await close(f, historyClient, sessionAttempt);
          const serviceId = `historical-service-${suffix}`;
          f.routes.register({ serviceId, port: 5180, mount: "preserve" });
          const periodAttempt = `period-${suffix}`;
          const oldPeriod = await open({
            f,
            client: historyClient,
            params: {
              attemptId: periodAttempt,
              browserHandle: "period-history-profile",
              serviceId,
            },
          });
          await close(f, historyClient, periodAttempt);
          await expect(
            f.broker.run({ cookieHeader: oldSession.cookieHeader, serviceId: "atlas" }, identity),
          ).rejects.toThrow("authorization-ended");
          await expect(
            f.broker.run({ cookieHeader: oldPeriod.cookieHeader, serviceId }, identity),
          ).rejects.toThrow("authorization-ended");
          completed += 1;
        }
        expect(job.signal.aborted).toBe(false);
        expect(
          await f.broker.run({ cookieHeader: live.cookieHeader, serviceId: "atlas" }, identity),
        ).toBe(job.activationId);
        expect(measure()).toEqual(original);
      }
      // Keeping history terminal must not erase replay tombstones or session identity.
      await f.broker.prepare({
        socket: historyClient.socket,
        request: {
          ...request,
          attemptId: "session-0",
          browserHandle: "historical-profile-0",
        },
      });
      expect(JSON.parse(historyClient.frames.at(-1)!).message.payload.result).toEqual({
        status: "error",
        code: "duplicate-attempt",
      });
      const reopened = await open({
        f,
        client: historyClient,
        params: {
          attemptId: "reopen-old-profile",
          browserHandle: "historical-profile-0",
        },
      });
      expect(reopened.cookieHeader).toBe(history[0].cookieHeader);
      expect(
        await f.broker.run(
          { cookieHeader: reopened.cookieHeader, serviceId: "atlas" },
          () => "fresh authority",
        ),
      ).toBe("fresh authority");
      await close(f, historyClient, "reopen-old-profile");
      expect(measure()).toEqual(original);
      const closing = close(f, liveClient);
      expect(job.signal.aborted).toBe(true);
      await closing;
      expect(await held.outcome).toBe("authorization-ended");
      const lateWrite = () => "late bytes";
      expect(() => job.write(lateWrite)).toThrow("authorization-ended");
      expect(f.failures).toEqual([]);
    } finally {
      f.broker.close();
      held.held.resolve();
    }
  });
});
