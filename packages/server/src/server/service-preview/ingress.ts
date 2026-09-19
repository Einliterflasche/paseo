import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface PreviewIngressTarget {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void>;
  close(): void;
}

interface PreviewIngressOptions {
  preview: PreviewIngressTarget | null;
  application(request: IncomingMessage, response: ServerResponse): void;
  legacyUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean;
  daemonUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void;
  controlAdmission?(request: IncomingMessage): boolean;
}

const namespace = "/__paseo_services";

function inNamespace(path: string): boolean {
  return path === namespace || path.startsWith(`${namespace}/`);
}

function normalizedPath(target: string): string {
  try {
    return new URL(target, "http://paseo.invalid").pathname;
  } catch {
    return "";
  }
}

/** Normalization is used only to deny aliases, never to admit a rewritten URL. */
export function previewTargetOwnership(target: string): "ordinary" | "preview" | "invalid" {
  const path = target.split(/[?#]/, 1)[0];
  if (inNamespace(path)) {
    const canonical =
      path.startsWith(`${namespace}/`) &&
      !/[\\#\s]/.test(target) &&
      normalizedPath(target) === path;
    return canonical ? "preview" : "invalid";
  }
  let candidate = path;
  for (;;) {
    const slashPath = candidate.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
    if (inNamespace(normalizedPath(candidate)) || inNamespace(normalizedPath(slashPath)))
      return "invalid";
    // Each decoding step shortens the input. There is no arbitrary depth cap or
    // fallback that turns a multiply encoded reserved route into an app route.
    const decoded = candidate.replace(/%([\da-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (decoded === candidate) return "ordinary";
    candidate = decoded;
  }
}

function denyResponse(response: ServerResponse, status: number): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "cache-control": "no-store", "content-length": "0" });
  response.end();
}

function denySocket(socket: Socket, status: number): void {
  if (socket.destroyed) return;
  socket.on("error", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

/** One physical request/upgrade consumer; reserved requests never fall through. */
export function createPreviewIngress({
  preview,
  application,
  legacyUpgrade,
  daemonUpgrade,
  controlAdmission,
}: PreviewIngressOptions) {
  let closed = false;
  return {
    handle(request: IncomingMessage, response: ServerResponse): void {
      if (controlAdmission && !controlAdmission(request)) {
        request.resume();
        denyResponse(response, 403);
        return;
      }
      const ownership = previewTargetOwnership(request.url ?? "");
      if (ownership === "ordinary") {
        application(request, response);
        return;
      }
      if (ownership === "invalid" || !preview || closed) {
        request.resume();
        denyResponse(response, ownership === "invalid" ? 400 : 503);
        return;
      }
      // Do not flatten headers or replace the target with the classification URL.
      void Promise.resolve()
        .then(() => preview.handle(request, response))
        .catch(() => {
          request.resume();
          denyResponse(response, 502);
        });
    },
    upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
      if (controlAdmission && !controlAdmission(request)) {
        denySocket(socket, 403);
        return;
      }
      const ownership = previewTargetOwnership(request.url ?? "");
      if (ownership !== "ordinary") {
        if (ownership === "invalid" || !preview || closed) {
          denySocket(socket, ownership === "invalid" ? 400 : 503);
          return;
        }
        void Promise.resolve()
          .then(() => preview.upgrade(request, socket, head))
          .catch(() => socket.destroy());
        return;
      }
      try {
        if (!controlAdmission && legacyUpgrade(request, socket, head)) return;
        if ((request.url ?? "").split("?", 1)[0] !== "/ws") {
          denySocket(socket, 404);
          return;
        }
        daemonUpgrade(request, socket, head);
      } catch {
        socket.destroy();
      }
    },
    connect(_request: IncomingMessage, socket: Socket): void {
      // Preview registration never grants a general-purpose CONNECT tunnel.
      denySocket(socket, 405);
    },
    close(): void {
      if (closed) return;
      closed = true;
      preview?.close();
    },
  };
}
