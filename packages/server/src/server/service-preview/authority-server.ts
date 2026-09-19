import { PreviewBroker, PreviewBrokerError, type PreviewAuthorizedJob } from "./broker.js";
import {
  PreviewGatewayMessageSchema,
  previewCompletion,
  type PreviewChannel,
  type PreviewBrokerMessage,
  type PreviewGatewayMessage,
} from "./channel.js";

interface AuthorityServerOptions {
  channelId: string;
  channel: PreviewChannel<PreviewBrokerMessage>;
  broker: PreviewBroker;
  /** The feature owner decides how to retire/recreate its broker after IPC loss. */
  onClosed(): void | Promise<void>;
  onFailure(error: unknown): void | Promise<void>;
}

interface RemoteJob {
  finished: ReturnType<typeof previewCompletion>;
  approved: boolean;
  completed: boolean;
}

/** Parent-side authority only: no request bodies, sockets or upstream connections. */
export function openPreviewAuthorityServer({
  channelId,
  channel,
  broker,
  onClosed,
  onFailure,
}: AuthorityServerOptions) {
  const jobs = new Map<number, RemoteJob>();
  const invalidations = new Map<number, ReturnType<typeof previewCompletion>>();
  let closed = false;
  let lastRequest = 0;
  let unsubscribe = () => {};

  async function report(error: unknown): Promise<void> {
    try {
      await onFailure(error);
    } catch {
      /* Already terminal. */
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      unsubscribe();
    } catch (error) {
      void report(error);
    }
    channel.signal.removeEventListener("abort", close);
    for (const entry of jobs.values()) {
      entry.completed = true;
      entry.finished.resolve();
    }
    for (const pending of invalidations.values()) pending.resolve();
    jobs.clear();
    invalidations.clear();
    try {
      channel.close();
    } catch (error) {
      void report(error);
    }
    try {
      Promise.resolve(onClosed()).catch(report);
    } catch (error) {
      void report(error);
    }
  }

  function fail(error: unknown): void {
    try {
      close();
    } catch {
      /* Preserve the original channel/authority failure. */
    }
    void report(error);
  }

  function current(): void {
    if (closed || channel.signal.aborted || broker.isClosed)
      throw new PreviewBrokerError("unavailable");
  }

  function send(message: PreviewBrokerMessage): void {
    current();
    channel.send(message);
  }

  async function drainInvalidations(): Promise<void> {
    current();
    while (invalidations.size > 0) {
      await Promise.all([...invalidations.values()].map((pending) => pending.promise));
      current();
    }
  }

  async function commitApproval(job: PreviewAuthorizedJob, commit: () => void): Promise<void> {
    for (;;) {
      await job.wait(drainInvalidations);
      // job.write first reconciles broker authority. That reconciliation, or a
      // revocation while the await resumed, can introduce another cancellation.
      // Check the barrier in the same synchronous transition as the send.
      const committed = job.write(() => {
        current();
        if (invalidations.size > 0) return false;
        commit();
        return true;
      });
      if (committed) return;
    }
  }

  function invalidate(requestId: number, entry: RemoteJob): void {
    if (closed || entry.completed || !entry.approved || invalidations.has(requestId)) return;
    invalidations.set(requestId, previewCompletion());
    try {
      send({ channelId, type: "invalidate", requestId });
    } catch (error) {
      fail(error);
    }
  }

  async function authorize(
    message: Extract<PreviewGatewayMessage, { type: "authorize" }>,
  ): Promise<void> {
    const { requestId } = message;
    const entry: RemoteJob = { finished: previewCompletion(), approved: false, completed: false };
    jobs.set(requestId, entry);
    try {
      await broker.run(
        { serviceId: message.input.serviceId, cookieHeader: message.input.cookieHeader },
        async (job: PreviewAuthorizedJob) => {
          const revoked = () => invalidate(requestId, entry);
          job.signal.addEventListener("abort", revoked, { once: true });
          try {
            await commitApproval(job, () => {
              entry.approved = true;
              send({
                channelId,
                type: "authorized",
                requestId,
                activationId: job.activationId,
                route: job.route,
              });
            });
            await job.wait(() => entry.finished.promise);
          } finally {
            job.signal.removeEventListener("abort", revoked);
          }
        },
      );
    } catch (error) {
      if (!(error instanceof PreviewBrokerError)) throw error;
      if (!entry.approved && !closed) {
        send({ channelId, type: "denied", requestId, code: error.code });
      }
    } finally {
      if (!invalidations.has(requestId)) jobs.delete(requestId);
    }
  }

  async function request(
    message: Extract<PreviewGatewayMessage, { type: "redeem" | "confirm" | "authorize" }>,
  ): Promise<void> {
    await drainInvalidations();
    if (message.type === "authorize") return authorize(message);
    try {
      if (message.type === "redeem") {
        const credential = broker.redeem(message.input);
        send({ channelId, type: "redeemed", requestId: message.requestId, credential });
      } else {
        const contribution = broker.confirm({
          bootstrapId: message.input.bootstrapId,
          cookieHeader: message.input.cookieHeader,
          mode: message.input.mode,
        });
        // Confirmation can retire older sessions and synchronously invalidate jobs.
        await broker.run(
          { serviceId: contribution.serviceId, cookieHeader: message.input.cookieHeader },
          async (job) => {
            await commitApproval(job, () =>
              send({ channelId, type: "confirmed", requestId: message.requestId, contribution }),
            );
          },
        );
      }
    } catch (error) {
      if (!(error instanceof PreviewBrokerError)) throw error;
      if (!closed)
        send({ channelId, type: "denied", requestId: message.requestId, code: error.code });
    }
  }

  function receive(raw: unknown): void {
    try {
      current();
      const parsed = PreviewGatewayMessageSchema.safeParse(raw);
      if (!parsed.success) throw new Error("preview-invalid-message");
      const message = parsed.data;
      if (message.channelId !== channelId) throw new Error("preview-channel-mismatch");
      if (message.type === "probe") {
        send({ channelId, type: "acknowledge", challenge: message.challenge });
        return;
      }
      if (message.type === "cancelled") {
        const pending = invalidations.get(message.requestId);
        if (!pending) throw new Error("preview-unexpected-cancellation");
        invalidations.delete(message.requestId);
        jobs.delete(message.requestId);
        pending.resolve();
        return;
      }
      if (message.type === "completed") {
        const entry = jobs.get(message.requestId);
        if (entry) {
          entry.completed = true;
          entry.finished.resolve();
        }
        return;
      }
      if (message.requestId <= lastRequest) throw new Error("preview-request-reused");
      lastRequest = message.requestId;
      void request(message).catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  unsubscribe = channel.subscribe(receive);
  channel.signal.addEventListener("abort", close, { once: true });
  if (channel.signal.aborted) close();
  return { close, settled: drainInvalidations };
}
