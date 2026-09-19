import http, { type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runPreviewGatewayJob, type PreviewGatewayAuthority } from "./authority.js";
import { PreviewAdmissionError } from "./http-admission.js";
import { createPreviewHttpPolicy } from "./http-policy.js";
import { guardedPreviewStream } from "./stream.js";

interface PreviewWebSocketOptions {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  controller: AbortController;
  broker: PreviewGatewayAuthority;
  policy: ReturnType<typeof createPreviewHttpPolicy>;
}

interface UpstreamUpgrade {
  response: IncomingMessage;
  upstream: Duplex;
  head: Buffer;
}

function single(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  if (!values) return undefined;
  if (values.length !== 1) throw new PreviewAdmissionError();
  return values[0];
}

function handshake(request: IncomingMessage) {
  const key = single(request, "sec-websocket-key");
  const version = single(request, "sec-websocket-version");
  const upgrade = single(request, "upgrade");
  const connection = single(request, "connection");
  const valid =
    key !== undefined &&
    /^[+/0-9A-Za-z]{22}==$/.test(key) &&
    version === "13" &&
    upgrade?.toLowerCase() === "websocket" &&
    connection
      ?.toLowerCase()
      .split(/\s*,\s*/)
      .includes("upgrade");
  if (
    !valid ||
    request.headers["content-length"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined
  )
    throw new PreviewAdmissionError();
  const protocols = single(request, "sec-websocket-protocol");
  const offered = protocols === undefined ? [] : protocols.split(",").map((value) => value.trim());
  if (
    offered.some(
      (value) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value) || value.startsWith("paseo.bearer."),
    ) ||
    new Set(offered).size !== offered.length
  )
    throw new PreviewAdmissionError();
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  return { accept, offered, protocols };
}

function responseHead(headers: Record<string, string | string[]>): string {
  const lines = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket"];
  for (const [name, values] of Object.entries(headers)) {
    for (const value of Array.isArray(values) ? values : [values]) lines.push(`${name}: ${value}`);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

export function denyPreviewUpgrade(socket: Duplex): void {
  if (!socket.destroyed)
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () =>
      socket.destroy(),
    );
}

/** Raw WebSocket bytes retain browser/app framing; the gateway owns both socket lifetimes. */
export async function forwardPreviewWebSocket({
  request,
  socket,
  head,
  controller,
  broker,
  policy,
}: PreviewWebSocketOptions) {
  const serviceId = request.url?.match(/^\/__paseo_services\/apps\/([^/?]+)\//)?.[1];
  if (!serviceId) throw new PreviewAdmissionError();
  const negotiated = handshake(request);
  const connection: { current: Duplex | null } = { current: null };
  let accepted = false;
  const buffered: Buffer[] = head.length > 0 ? [head] : [];
  const collect = (chunk: Buffer) => buffered.push(chunk);
  const ended = () => controller.abort();
  const stopHandshakeInput = () => {
    socket.pause();
    socket.off("data", collect);
  };
  try {
    await runPreviewGatewayJob({
      authority: broker,
      request: { serviceId, cookieHeader: request.headers.cookie },
      controller,
      work: async (job) => {
        const options = policy.request({ request, route: job.route });
        // HTTP hands upgraded sockets over paused. Observe EOF while waiting for
        // the upstream 101, retaining early WebSocket bytes for the later pipes.
        socket.on("data", collect);
        socket.on("end", ended);
        if (socket.readableEnded) controller.abort();
        socket.resume();
        const headers = { ...options.headers, connection: "Upgrade", upgrade: "websocket" };
        if (negotiated.protocols !== undefined)
          Object.assign(headers, { "sec-websocket-protocol": negotiated.protocols });
        const upstream = job.write(() =>
          http.request({ ...options, headers, signal: controller.signal }),
        );
        const upgraded = new Promise<UpstreamUpgrade>((resolve, reject) => {
          upstream.on("error", reject);
          upstream.on("response", (response) => {
            response.destroy();
            reject(new Error("preview-upstream-refused-upgrade"));
          });
          upstream.on("upgrade", (response, stream, first) => {
            connection.current = stream;
            stream.on("error", reject);
            stream.on("end", ended);
            if (controller.signal.aborted) {
              stream.destroy();
              reject(new Error("preview-upgrade-ended"));
            } else resolve({ response, upstream: stream, head: first });
          });
        });
        job.write(() => upstream.end());
        const opened = await job.wait(() => upgraded);
        stopHandshakeInput();
        if (opened.upstream.readableEnded) controller.abort();
        if (controller.signal.aborted) throw new PreviewAdmissionError();
        const selected = single(opened.response, "sec-websocket-protocol");
        if (
          single(opened.response, "sec-websocket-accept") !== negotiated.accept ||
          (selected !== undefined && !negotiated.offered.includes(selected))
        )
          throw new PreviewAdmissionError();
        const replyHeaders = policy.response({ response: opened.response, route: job.route });
        job.write(() => {
          accepted = true;
          socket.write(responseHead(replyHeaders));
        });
        for (const chunk of buffered.toReversed()) socket.unshift(chunk);
        buffered.length = 0;
        if (opened.head.length > 0) opened.upstream.unshift(opened.head);
        // Before acceptance, EOF cancels the incomplete handshake. Once pumps
        // own the sockets, readable EOF must drain already-buffered bytes through
        // that direction's destination before ending the opposite direction.
        socket.off("end", ended);
        opened.upstream.off("end", ended);
        const finishPumps = () => {
          controller.abort();
          // An iterator source is not a stream target owned by pipeline's abort
          // handler. Destroy both sockets after directional completion to wake a
          // reciprocal iterator that is still waiting on a half-open peer.
          socket.destroy();
          opened.upstream.destroy();
        };
        // Each duplex is already owned as the opposite pipeline's destination.
        // Iterator sources avoid installing a second set of stream-end observers.
        await Promise.all([
          pipeline(
            socket.iterator({ destroyOnReturn: false }),
            guardedPreviewStream(job),
            opened.upstream,
            { signal: controller.signal },
          ).finally(finishPumps),
          pipeline(
            opened.upstream.iterator({ destroyOnReturn: false }),
            guardedPreviewStream(job),
            socket,
            { signal: controller.signal },
          ).finally(finishPumps),
        ]);
      },
    });
  } catch {
    if (accepted) socket.destroy();
    else denyPreviewUpgrade(socket);
  } finally {
    stopHandshakeInput();
    buffered.length = 0;
    controller.abort();
    socket.off("end", ended);
    connection.current?.off("end", ended);
    connection.current?.destroy();
  }
}
