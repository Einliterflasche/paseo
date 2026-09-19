import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PreviewBrokerError } from "./broker.js";
import { runPreviewGatewayJob, type PreviewGatewayAuthority } from "./authority.js";
import { createPreviewAdmission, PreviewAdmissionError } from "./http-admission.js";
import { createPreviewHttpPolicy, PreviewHttpPolicyError } from "./http-policy.js";
import { guardedPreviewStream } from "./stream.js";
import { forwardPreviewWebSocket, denyPreviewUpgrade } from "./websocket.js";
import { createPreviewTicketReader } from "./ticket.js";

interface PreviewGatewayOptions {
  broker: PreviewGatewayAuthority;
  controlOrigin: string;
  controlCookieNames: readonly string[];
}

interface GatewayResponse {
  response: ServerResponse;
  status: number;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
}

function respond({ response, status, headers = {}, body }: GatewayResponse) {
  const failed = status >= 400;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(failed ? { "content-type": "text/html; charset=utf-8" } : {}),
    ...headers,
  });
  response.end(
    failed
      ? '<!doctype html><html lang="en"><meta charset="utf-8"><title>Preview unavailable</title><main data-paseo-preview-error><h1>Preview unavailable</h1><p>Return to Paseo and open the preview again.</p></main></html>'
      : body,
  );
}

async function readTicket(request: IncomingMessage, signal: AbortSignal): Promise<string> {
  const reader = createPreviewTicketReader();
  const abort = () => request.destroy(new Error("preview-bootstrap-ended"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) {
      abort();
      throw new PreviewAdmissionError();
    }
    for await (const chunk of request) reader.write(Buffer.from(chunk));
    return reader.finish();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Optional local adapter. The caller owns ingress and shutdown; bootstrap never installs it. */
export function createPreviewGateway({
  broker,
  controlOrigin,
  controlCookieNames,
}: PreviewGatewayOptions) {
  const admission = createPreviewAdmission(controlOrigin);
  const policy = createPreviewHttpPolicy({ controlOrigin, controlCookieNames });
  const pending = new Set<AbortController>();
  let closed = false;

  async function forward(
    request: IncomingMessage,
    response: ServerResponse,
    controller: AbortController,
  ) {
    const serviceId = request.url?.match(/^\/__paseo_services\/apps\/([^/?]+)\//)?.[1];
    if (!serviceId) throw new PreviewAdmissionError();
    admission.application(request);
    try {
      await runPreviewGatewayJob({
        authority: broker,
        request: { serviceId, cookieHeader: request.headers.cookie },
        controller,
        work: async (job) => {
          const options = policy.request({ request, route: job.route });
          const upstream = job.write(() => http.request({ ...options, signal: controller.signal }));
          // Attach response/error observation before any upload can complete.
          const received = new Promise<IncomingMessage>((resolve, reject) => {
            upstream.once("response", resolve);
            upstream.on("error", reject);
            upstream.once("upgrade", (_response, socket) => {
              socket.destroy();
              reject(new Error("preview-unexpected-upgrade"));
            });
            upstream.once("close", () => reject(new Error("preview-upstream-ended")));
          });
          const upload = pipeline(request, guardedPreviewStream(job), upstream, {
            signal: controller.signal,
          });
          const download = job.wait(async () => {
            const incoming = await received;
            const status = incoming.statusCode;
            if (!status) throw new Error("preview-invalid-upstream-response");
            const headers = policy.response({ response: incoming, route: job.route });
            job.write(() => response.writeHead(status, headers));
            await pipeline(incoming, guardedPreviewStream(job), response, {
              signal: controller.signal,
            });
          });
          await Promise.all([upload, download]);
        },
      });
    } finally {
      // Revocation ends run() even if a transport continuation is still waiting.
      controller.abort();
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    pending.add(controller);
    request.on("aborted", () => controller.abort());
    request.on("error", () => controller.abort());
    response.on("error", () => controller.abort());
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    try {
      if (closed) throw new PreviewAdmissionError();
      const target = request.url ?? "";
      const bootstrapId = target.match(/^\/__paseo_services\/bootstrap\/([a-zA-Z0-9-]+)$/)?.[1];
      const confirmationId = target.match(/^\/__paseo_services\/confirm\/([a-zA-Z0-9-]+)$/)?.[1];
      if (bootstrapId) {
        const mode = admission.bootstrap(request);
        const ticket = await readTicket(request, controller.signal);
        if (closed || controller.signal.aborted) throw new PreviewAdmissionError();
        const credential = await broker.redeem({ bootstrapId, ticket, mode });
        if (closed || controller.signal.aborted) throw new PreviewAdmissionError();
        respond({
          response,
          status: 303,
          headers: {
            "set-cookie": `${credential.cookieName}=${credential.cookieValue}; Secure; HttpOnly; SameSite=Strict; Path=/__paseo_services/`,
            location: `/__paseo_services/confirm/${bootstrapId}`,
          },
        });
      } else if (confirmationId) {
        const mode = admission.confirmation(request);
        const confirmed = await broker.confirm({
          bootstrapId: confirmationId,
          cookieHeader: request.headers.cookie,
          mode,
        });
        if (closed || controller.signal.aborted) throw new PreviewAdmissionError();
        // A document starts a fresh navigation. Firefox can classify a second
        // redirect as Site:none even when the original form was same-origin.
        const nonce = randomBytes(24).toString("base64");
        const appPath = `/__paseo_services/apps/${encodeURIComponent(confirmed.serviceId)}/`;
        // A same-origin helper can confirm fresh authority without navigating
        // the existing application. The name selects presentation, not access.
        const resumeName = `paseo-preview-resume:${confirmationId}`;
        respond({
          response,
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'`,
          },
          body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Opening preview</title><main data-paseo-preview-confirmation>Opening preview…</main><script nonce="${nonce}">if(window.name!==${JSON.stringify(resumeName)})location.replace(${JSON.stringify(appPath)})</script></html>`,
        });
      } else if (target.startsWith("/__paseo_services/apps/")) {
        await forward(request, response, controller);
      } else {
        respond({ response, status: 404 });
      }
    } catch (error) {
      controller.abort();
      if (response.headersSent || response.destroyed) {
        response.destroy();
      } else {
        const denied =
          error instanceof PreviewAdmissionError ||
          error instanceof PreviewBrokerError ||
          error instanceof PreviewHttpPolicyError;
        respond({ response, status: denied ? 403 : 502 });
      }
    } finally {
      pending.delete(controller);
      request.resume();
    }
  }

  return {
    handle,
    async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
      const controller = new AbortController();
      pending.add(controller);
      socket.on("error", () => controller.abort());
      socket.on("close", () => controller.abort());
      try {
        if (closed) throw new PreviewAdmissionError();
        admission.websocket(request);
        await forwardPreviewWebSocket({ request, socket, head, controller, broker, policy });
      } catch {
        denyPreviewUpgrade(socket);
      } finally {
        controller.abort();
        pending.delete(controller);
      }
    },
    close() {
      closed = true;
      broker.close();
      for (const controller of pending) controller.abort();
    },
  };
}
