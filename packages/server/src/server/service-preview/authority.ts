import type { PreviewBroker } from "./broker.js";
import { PreviewBrokerError, type PreviewAuthorizedJob } from "./broker.js";

type Awaitable<T> = T | PromiseLike<T>;

/**
 * The gateway owns this authority connection, not the daemon's global broker.
 * A remote implementation must terminalize local jobs when its channel ends.
 */
export interface PreviewGatewayAuthority {
  redeem(
    input: Parameters<PreviewBroker["redeem"]>[0],
  ): Awaitable<ReturnType<PreviewBroker["redeem"]>>;
  confirm(
    input: Parameters<PreviewBroker["confirm"]>[0],
  ): Awaitable<ReturnType<PreviewBroker["confirm"]>>;
  run: PreviewBroker["run"];
  close(): void;
}

interface GatewayJobInput<T> {
  authority: PreviewGatewayAuthority;
  request: Parameters<PreviewBroker["run"]>[0];
  controller: AbortController;
  work(job: PreviewAuthorizedJob): T | PromiseLike<T>;
}

/** Cancellation owns the transports even when the caller is awaiting a header. */
export function runPreviewGatewayJob<T>({
  authority,
  request,
  controller,
  work,
}: GatewayJobInput<T>): Promise<T> {
  return authority.run(request, async (job) => {
    const invalidate = () => controller.abort();
    job.signal.addEventListener("abort", invalidate, { once: true });
    try {
      if (job.signal.aborted || controller.signal.aborted)
        throw new PreviewBrokerError("authorization-ended");
      return await work(job);
    } finally {
      controller.abort();
      job.signal.removeEventListener("abort", invalidate);
    }
  });
}
