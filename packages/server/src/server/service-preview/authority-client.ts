import { PreviewBrokerError, type PreviewAuthorizedJob } from "./broker.js";
import type { PreviewGatewayAuthority } from "./authority.js";
import type { PreviewClock } from "./clock.js";
import { assertPreviewHttpRoute } from "./http-policy.js";
import { PreviewGatewayWatchdog } from "./watchdog.js";
import {
  PreviewBrokerMessageSchema,
  type PreviewBrokerMessage,
  type PreviewGatewayMessage,
  type PreviewChannel,
} from "./channel.js";

type AuthorityReply = Exclude<PreviewBrokerMessage, { type: "acknowledge" | "invalidate" }>;
type AuthorityRequest = Extract<
  PreviewGatewayMessage,
  { type: "redeem" | "confirm" | "authorize" }
>;

interface PendingReply {
  resolve(message: AuthorityReply): void;
  reject(error: Error): void;
}

interface LocalJob {
  controller: AbortController;
  job: PreviewAuthorizedJob;
  hooks: Set<Promise<void>>;
  started: boolean;
  settled: boolean;
  revoked: boolean;
}

interface AuthorityClientOptions {
  channelId: string;
  channel: PreviewChannel<PreviewGatewayMessage>;
  clock?: PreviewClock;
}

/** Gateway-side owner. Its watchdog and all stream cancellation run off-daemon. */
export function openPreviewAuthorityClient({
  channelId,
  channel,
  clock,
}: AuthorityClientOptions): PreviewGatewayAuthority {
  const pending = new Map<number, PendingReply>();
  const jobs = new Map<number, LocalJob>();
  let sequence = 0;
  let closed = false;
  let unsubscribe = () => {};

  const watchdog = new PreviewGatewayWatchdog({
    clock,
    sendProbe: (challenge) =>
      Promise.resolve().then(() => channel.send({ channelId, type: "probe", challenge })),
  });

  function current(): void {
    if (closed || channel.signal.aborted || !watchdog.isCurrent())
      throw new PreviewBrokerError("authorization-ended");
  }

  function send(message: PreviewGatewayMessage): void {
    current();
    try {
      channel.send(message);
    } catch (error) {
      close();
      throw error;
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    unsubscribe();
    channel.signal.removeEventListener("abort", close);
    watchdog.signal.removeEventListener("abort", close);
    watchdog.close();
    for (const entry of jobs.values()) entry.controller.abort();
    jobs.clear();
    for (const reply of pending.values())
      reply.reject(new PreviewBrokerError("authorization-ended"));
    pending.clear();
    channel.close();
  }

  function finish(requestId: number, entry: LocalJob): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.controller.abort();
    // The cancelled wait wrapper can settle before the operation it started.
    // Aborting first prevents new guarded hooks; drain every existing hook before
    // telling the broker that this job no longer owns work.
    void Promise.all(entry.hooks).then(() => {
      jobs.delete(requestId);
      if (closed) return;
      try {
        send({ channelId, type: entry.revoked ? "cancelled" : "completed", requestId });
      } catch {
        close();
      }
      return undefined;
    });
  }

  function createJob(message: Extract<PreviewBrokerMessage, { type: "authorized" }>): LocalJob {
    assertPreviewHttpRoute(message.route);
    const controller = new AbortController();
    const hooks = new Set<Promise<void>>();
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new PreviewBrokerError("authorization-ended")),
        { once: true },
      );
    });
    cancelled.catch(() => {});
    const guard = () => {
      current();
      if (controller.signal.aborted) throw new PreviewBrokerError("authorization-ended");
    };
    const job: PreviewAuthorizedJob = Object.freeze({
      activationId: message.activationId,
      route: Object.freeze({ ...message.route }),
      signal: controller.signal,
      async wait<T>(start: () => T | PromiseLike<T>): Promise<T> {
        guard();
        const work = Promise.resolve().then(() => {
          guard();
          return start();
        });
        const drained = work.then(
          () => undefined,
          () => undefined,
        );
        hooks.add(drained);
        void drained.then(() => hooks.delete(drained));
        const result = await Promise.race([work, cancelled]);
        guard();
        return result;
      },
      write<T>(action: () => T): T {
        guard();
        return action();
      },
    });
    return { controller, job, hooks, started: false, settled: false, revoked: false };
  }

  function receive(raw: unknown): void {
    try {
      const message = PreviewBrokerMessageSchema.parse(raw);
      if (message.channelId !== channelId || closed) throw new Error("preview-channel-mismatch");
      if (message.type === "acknowledge") {
        watchdog.acknowledge(message.challenge);
        return;
      }
      current();
      if (message.type === "invalidate") {
        const entry = jobs.get(message.requestId);
        if (!entry) {
          // The client may already have completed this job while revocation was
          // in flight. No local work remains; still acknowledge that observation.
          send({ channelId, type: "cancelled", requestId: message.requestId });
          return;
        }
        entry.revoked = true;
        entry.controller.abort();
        if (!entry.started) finish(message.requestId, entry);
        return;
      }
      const reply = pending.get(message.requestId);
      if (!reply) throw new Error("preview-unexpected-reply");
      if (message.type === "authorized") jobs.set(message.requestId, createJob(message));
      pending.delete(message.requestId);
      reply.resolve(message);
    } catch {
      close();
    }
  }

  async function request(
    input:
      | Omit<Extract<AuthorityRequest, { type: "redeem" }>, "channelId" | "requestId">
      | Omit<Extract<AuthorityRequest, { type: "confirm" }>, "channelId" | "requestId">
      | Omit<Extract<AuthorityRequest, { type: "authorize" }>, "channelId" | "requestId">,
  ): Promise<AuthorityReply> {
    await watchdog.ready;
    current();
    const requestId = ++sequence;
    if (!Number.isSafeInteger(requestId)) {
      close();
      throw new Error("preview-request-identity-exhausted");
    }
    const response = new Promise<AuthorityReply>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        send({ ...input, channelId, requestId });
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
    const result = await response;
    current();
    if (result.type === "denied") throw new PreviewBrokerError(result.code);
    return result;
  }

  unsubscribe = channel.subscribe(receive);
  channel.signal.addEventListener("abort", close, { once: true });
  watchdog.signal.addEventListener("abort", close, { once: true });
  if (channel.signal.aborted || watchdog.signal.aborted) close();

  return {
    close,
    async redeem(input) {
      const { bootstrapId, ticket, mode } = input;
      const reply = await request({ type: "redeem", input: { bootstrapId, ticket, mode } });
      if (reply.type !== "redeemed") {
        close();
        throw new Error("preview-unexpected-reply");
      }
      return reply.credential;
    },
    async confirm(input) {
      const { bootstrapId, cookieHeader, mode } = input;
      const reply = await request({ type: "confirm", input: { bootstrapId, cookieHeader, mode } });
      if (reply.type !== "confirmed") {
        close();
        throw new Error("preview-unexpected-reply");
      }
      return reply.contribution;
    },
    async run<T>(
      input: Parameters<PreviewGatewayAuthority["run"]>[0],
      work: (job: PreviewAuthorizedJob) => T | PromiseLike<T>,
    ): Promise<T> {
      const { serviceId, cookieHeader } = input;
      const reply = await request({ type: "authorize", input: { serviceId, cookieHeader } });
      if (reply.type !== "authorized") {
        close();
        throw new Error("preview-unexpected-reply");
      }
      const entry = jobs.get(reply.requestId);
      if (!entry || entry.controller.signal.aborted)
        throw new PreviewBrokerError("authorization-ended");
      entry.started = true;
      // Observe every started continuation. Ack revocation only once that work
      // has settled, after the gateway's signal-owned streams have been aborted.
      const started = Promise.resolve().then(() => entry.job.write(() => work(entry.job)));
      try {
        return await entry.job.wait(() => started);
      } finally {
        entry.controller.abort();
        void started.then(
          () => finish(reply.requestId, entry),
          () => finish(reply.requestId, entry),
        );
      }
    },
  };
}
