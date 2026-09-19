import type { IncomingMessage } from "node:http";

export class PreviewAdmissionError extends Error {
  constructor() {
    super("preview-request-denied");
    this.name = "PreviewAdmissionError";
  }
}

function single(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  if (!values) return undefined;
  if (values.length !== 1) throw new PreviewAdmissionError();
  return values[0];
}

/** Browser metadata supplements the broker credential; it never grants authority. */
export function createPreviewAdmission(controlOrigin: string) {
  const origin = new URL(controlOrigin);
  if (origin.protocol !== "https:" || origin.origin !== controlOrigin) {
    throw new PreviewAdmissionError();
  }

  function common(request: IncomingMessage) {
    if (single(request, "host") !== origin.host) throw new PreviewAdmissionError();
    const target = request.url ?? "";
    const rawPath = target.split("?", 1)[0];
    const validTarget =
      target.startsWith("/__paseo_services/") &&
      !/[\\#\s]/.test(target) &&
      new URL(controlOrigin + target).pathname === rawPath;
    if (!validTarget) throw new PreviewAdmissionError();
    const suppliedOrigin = single(request, "origin");
    if (suppliedOrigin !== undefined && suppliedOrigin !== controlOrigin) {
      throw new PreviewAdmissionError();
    }
    return {
      origin: suppliedOrigin,
      site: single(request, "sec-fetch-site"),
      mode: single(request, "sec-fetch-mode"),
      destination: single(request, "sec-fetch-dest"),
      user: single(request, "sec-fetch-user"),
    };
  }

  function navigation(request: IncomingMessage): "iframe" | "tab" {
    const metadata = common(request);
    if (metadata.site !== "same-origin" || metadata.mode !== "navigate") {
      throw new PreviewAdmissionError();
    }
    if (metadata.destination === "iframe") return "iframe";
    if (metadata.destination === "document") return "tab";
    throw new PreviewAdmissionError();
  }

  return {
    bootstrap(request: IncomingMessage) {
      if (request.method !== "POST" || single(request, "origin") !== controlOrigin) {
        throw new PreviewAdmissionError();
      }
      const contentType = single(request, "content-type");
      if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(contentType ?? "")) {
        throw new PreviewAdmissionError();
      }
      return navigation(request);
    },
    confirmation(request: IncomingMessage) {
      if (request.method !== "GET") throw new PreviewAdmissionError();
      return navigation(request);
    },
    application(request: IncomingMessage) {
      const metadata = common(request);
      const safe = request.method === "GET" || request.method === "HEAD";
      const explicitNavigation =
        request.method === "GET" &&
        metadata.site === "none" &&
        metadata.mode === "navigate" &&
        metadata.destination === "document" &&
        metadata.user === "?1";
      if (!explicitNavigation && metadata.site !== "same-origin") {
        throw new PreviewAdmissionError();
      }
      if (!safe && metadata.origin !== controlOrigin) throw new PreviewAdmissionError();
      if (!metadata.mode || metadata.destination === undefined) throw new PreviewAdmissionError();
      if (
        single(request, "service-worker") !== undefined ||
        single(request, "trailer") !== undefined
      ) {
        throw new PreviewAdmissionError();
      }
    },
    websocket(request: IncomingMessage) {
      const metadata = common(request);
      if (request.method !== "GET" || metadata.origin !== controlOrigin) {
        throw new PreviewAdmissionError();
      }
      const absent =
        metadata.site === undefined &&
        metadata.mode === undefined &&
        metadata.destination === undefined &&
        metadata.user === undefined;
      const sameOrigin =
        metadata.site === "same-origin" &&
        metadata.mode === "websocket" &&
        metadata.destination === "empty" &&
        metadata.user === undefined;
      if (!absent && !sameOrigin) throw new PreviewAdmissionError();
    },
  };
}
