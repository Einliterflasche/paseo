import type { IncomingMessage, RequestOptions } from "node:http";

const HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);
const CONTROL_REQUEST_HEADERS = new Set([
  "authorization",
  "sec-websocket-protocol",
  "forwarded",
  "x-real-ip",
  "x-original-url",
  "x-rewrite-url",
]);
const ORIGIN_RESPONSE_HEADERS = new Set([
  "clear-site-data",
  "service-worker-allowed",
  "strict-transport-security",
  "alt-svc",
  "nel",
  "report-to",
]);
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

interface CookiePair {
  name: string;
  pair: string;
}

function parseCookiePair(pair: string): CookiePair {
  const separator = pair.indexOf("=");
  const name = pair.slice(0, separator).trim();
  const rawValue = pair.slice(separator + 1).trim();
  const quoted = rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"');
  const value = quoted ? rawValue.slice(1, -1) : rawValue;
  if (separator < 1 || !HEADER_TOKEN.test(name) || !COOKIE_OCTETS.test(value)) {
    throw new PreviewHttpPolicyError("invalid-cookie");
  }
  return { name, pair: `${name}=${rawValue}` };
}

function removeHopHeaders(message: IncomingMessage): Record<string, string | string[]> {
  const blocked = new Set(HOP_HEADERS);
  for (const value of message.headersDistinct.connection ?? []) {
    for (const item of value.split(",")) {
      const token = item.trim();
      if (token === "") continue;
      if (!HEADER_TOKEN.test(token)) throw new PreviewHttpPolicyError("invalid-headers");
      blocked.add(token.toLowerCase());
    }
  }
  const entries: Array<[string, string | string[]]> = [];
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined || blocked.has(name)) continue;
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function checkTransferCoding(message: IncomingMessage): void {
  const codings = message.headersDistinct["transfer-encoding"];
  if (!codings) return;
  const chunked = codings.length === 1 && codings[0].trim().toLowerCase() === "chunked";
  // Node removes chunk framing, but leaves other transfer codings in the body.
  if (!chunked) throw new PreviewHttpPolicyError("unsupported-transfer-coding");
}

export interface PreviewHttpRoute {
  readonly serviceId: string;
  readonly port: number;
  readonly mount: "preserve" | "strip";
}

export function assertPreviewHttpRoute(route: PreviewHttpRoute): void {
  const safeId =
    route.serviceId !== "" &&
    route.serviceId !== "." &&
    route.serviceId !== ".." &&
    encodeURIComponent(route.serviceId) === route.serviceId;
  const validPort = Number.isInteger(route.port) && route.port >= 1 && route.port <= 65535;
  const validMount = route.mount === "preserve" || route.mount === "strip";
  if (!safeId || !validPort || !validMount) throw new PreviewHttpPolicyError("invalid-route");
}

interface PreviewHttpPolicyOptions {
  controlOrigin: string;
  controlCookieNames: readonly string[];
}

interface PreviewHttpRequest {
  request: IncomingMessage;
  route: PreviewHttpRoute;
}

interface PreviewHttpResponse {
  response: IncomingMessage;
  route: PreviewHttpRoute;
}

export class PreviewHttpPolicyError extends Error {
  constructor(
    readonly code:
      | "invalid-origin"
      | "invalid-route"
      | "invalid-target"
      | "invalid-authority"
      | "invalid-cookie"
      | "invalid-headers"
      | "unsupported-transfer-coding",
  ) {
    super(code);
    this.name = "PreviewHttpPolicyError";
  }
}

// This policy consumes an already authorized, registered route. It grants no access.
export function createPreviewHttpPolicy({
  controlOrigin,
  controlCookieNames,
}: PreviewHttpPolicyOptions) {
  const origin = new URL(controlOrigin);
  if (origin.protocol !== "https:" || origin.origin !== controlOrigin) {
    throw new PreviewHttpPolicyError("invalid-origin");
  }
  const controlCookies = new Set(controlCookieNames);

  function isReservedCookie(name: string): boolean {
    return name.startsWith("__Secure-PaseoPreview-") || controlCookies.has(name);
  }

  function requestHeaders(request: IncomingMessage) {
    const headers = removeHopHeaders(request);
    // IncomingMessage has decoded chunk framing. Node's client does not infer a
    // streamed body for every method, so reconstruct framing after hop removal.
    const hadBodyFraming =
      request.headers["transfer-encoding"] !== undefined ||
      request.headers["content-length"] !== undefined;
    if (hadBodyFraming && headers["content-length"] === undefined) {
      headers["transfer-encoding"] = "chunked";
    }
    for (const name of Object.keys(headers)) {
      if (CONTROL_REQUEST_HEADERS.has(name) || name.startsWith("x-forwarded-"))
        delete headers[name];
    }
    const rawCookies = headers.cookie;
    if (rawCookies !== undefined) {
      const cookieLines = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
      const appCookies: string[] = [];
      for (const line of cookieLines) {
        for (const pair of line.split(";")) {
          const cookie = parseCookiePair(pair);
          if (!isReservedCookie(cookie.name)) appCookies.push(cookie.pair);
        }
      }
      delete headers.cookie;
      if (appCookies.length > 0) headers.cookie = appCookies.join("; ");
    }
    headers.host = origin.host;
    headers["x-forwarded-host"] = origin.host;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-port"] = origin.port || "443";
    return headers;
  }

  function planRequest({ request, route }: PreviewHttpRequest): RequestOptions {
    assertPreviewHttpRoute(route);
    checkTransferCoding(request);

    const hosts = request.headersDistinct.host;
    if (!hosts || hosts.length !== 1 || hosts[0] !== origin.host) {
      throw new PreviewHttpPolicyError("invalid-authority");
    }
    const target = request.url ?? "";
    const prefix = `/__paseo_services/apps/${route.serviceId}/`;
    if (!target.startsWith(prefix) || /[\\#\s]/.test(target)) {
      throw new PreviewHttpPolicyError("invalid-target");
    }
    const rawPath = target.split("?", 1)[0];
    if (new URL(controlOrigin + target).pathname !== rawPath) {
      throw new PreviewHttpPolicyError("invalid-target");
    }
    const path = route.mount === "preserve" ? target : target.slice(prefix.length - 1);
    return {
      hostname: "127.0.0.1",
      port: route.port,
      method: request.method,
      path,
      headers: requestHeaders(request),
      agent: false,
    };
  }

  function responseCookie(
    value: string,
    prefix: string,
    mount: PreviewHttpRoute["mount"],
  ): string | null {
    const parts = value.split(";");
    let cookie: CookiePair;
    try {
      cookie = parseCookiePair(parts[0]);
    } catch (error) {
      if (error instanceof PreviewHttpPolicyError && error.code === "invalid-cookie") return null;
      throw error;
    }
    if (isReservedCookie(cookie.name)) return null;
    const attributes: string[] = [];
    let hasPath = false;
    for (const raw of parts.slice(1)) {
      const attribute = raw.trim();
      const separator = attribute.indexOf("=");
      const attributeName = separator === -1 ? attribute : attribute.slice(0, separator);
      const name = attributeName.trim().toLowerCase();
      if (name === "domain") continue;
      if (name === "path") {
        if (hasPath) return null;
        hasPath = true;
        let path = attribute.slice(separator + 1).trim();
        const withinMount = path === prefix.slice(0, -1) || path.startsWith(prefix);
        if (mount === "strip") {
          // Non-rooted/missing Path means browser default-path. The public
          // request already lives inside this mount; omit the invalid attribute.
          if (separator === -1 || !path.startsWith("/")) continue;
          if (!withinMount) path = prefix + path.slice(1);
        } else if (separator === -1 || !withinMount) return null;
        attributes.push(`Path=${path}`);
        continue;
      }
      if (attribute !== "") attributes.push(attribute);
    }
    return [cookie.pair, ...attributes].join("; ");
  }

  function responseHeaders({ response, route }: PreviewHttpResponse) {
    checkTransferCoding(response);
    const headers = removeHopHeaders(response);
    for (const name of ORIGIN_RESPONSE_HEADERS) delete headers[name];
    const prefix = `/__paseo_services/apps/${route.serviceId}/`;
    const rawCookies = headers["set-cookie"];
    if (rawCookies !== undefined) {
      const cookies = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
      const accepted: string[] = [];
      for (const cookie of cookies) {
        const filtered = responseCookie(cookie, prefix, route.mount);
        if (filtered !== null) accepted.push(filtered);
      }
      delete headers["set-cookie"];
      if (accepted.length > 0) headers["set-cookie"] = accepted;
    }
    const existingCsp = headers["content-security-policy"];
    const policies: string[] = [];
    if (typeof existingCsp === "string") policies.push(existingCsp);
    else if (existingCsp) policies.push(...existingCsp);
    policies.push("worker-src 'none'");
    headers["content-security-policy"] = policies;
    headers["cache-control"] = "no-store";
    return headers;
  }

  return { request: planRequest, response: responseHeaders };
}
