import path from "node:path";
import { controlAuthorities, parseControlOrigin } from "./control-transport.js";

interface PreviewFrontOptions {
  listenPort: number;
  daemonPort: number;
  gatewaySocketPath: string;
  controlOrigin: string;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid preview front port");
  }
}

function proxy(dial: string) {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial }],
    headers: {
      request: {
        delete: ["Forwarded", "X-Forwarded-Host", "X-Forwarded-Port"],
        set: { "X-Forwarded-Host": ["{http.request.hostport}"] },
      },
    },
    transport: {
      protocol: "http",
      versions: ["1.1"],
      compression: false,
      network_proxy: { from: "none" },
      // Prevent the HTTP transport from replaying a request on a reused socket.
      keep_alive: { enabled: false },
    },
    // No URI rewrite, body buffers, retry policy or stream deadline. In
    // particular, flush_interval=-1 would defeat client-abort cancellation.
  };
}

/** Caddy 2.11.2 configuration, consumed by a separately supervised front. */
export function createPreviewFrontConfig({
  listenPort,
  daemonPort,
  gatewaySocketPath,
  controlOrigin,
}: PreviewFrontOptions) {
  assertPort(listenPort);
  assertPort(daemonPort);
  if (listenPort === daemonPort) throw new Error("Preview front and daemon ports must differ");
  const authorities = controlAuthorities(parseControlOrigin(controlOrigin).origin, [listenPort]);
  const authorityPattern = `(?i)^(?:${authorities
    .map((authority) => authority.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})$`;
  if (
    !path.isAbsolute(gatewaySocketPath) ||
    /[{}]/.test(gatewaySocketPath) ||
    gatewaySocketPath.includes("\0")
  ) {
    throw new Error("Preview gateway requires an absolute socket path without placeholders");
  }
  return {
    admin: { disabled: true, config: { persist: false } },
    // Keep request targets, cookies and authorization out of new access/error
    // logs. Process/configuration errors remain available on stderr.
    // Reverse-proxy cancellation warnings also carry a request object, outside
    // the access/error loggers. Exclude the whole HTTP namespace.
    logging: { logs: { default: { exclude: ["http"] } } },
    apps: {
      // This HTTP-only front must never sweep the operator's existing Caddy data.
      tls: { disable_storage_clean: true },
      http: {
        servers: {
          paseo: {
            listen: [`127.0.0.1:${listenPort}`],
            protocols: ["h1"],
            automatic_https: { disable: true },
            // This listener is private and follows the existing loopback HTTPS
            // ingress. Preserve its forwarded scheme instead of inventing HTTP.
            trusted_proxies: { source: "static", ranges: ["127.0.0.1/32"] },
            routes: [
              {
                match: [
                  {
                    expression: `!{http.request.hostport}.matches(${JSON.stringify(authorityPattern)})`,
                  },
                ],
                handle: [{ handler: "static_response", status_code: 403 }],
                terminal: true,
              },
              {
                match: [{ method: ["CONNECT"] }],
                handle: [{ handler: "static_response", status_code: 405 }],
                terminal: true,
              },
              {
                // orig_uri is net/http's original RequestURI. The ordinary URI
                // placeholder would already hide absolute-form distinctions.
                match: [
                  {
                    expression: `!{http.request.orig_uri}.startsWith('/') || {http.request.orig_uri}.startsWith('//') || {http.request.orig_uri}.contains('#') || {http.request.orig_uri}.contains(${JSON.stringify("\\")})`,
                  },
                ],
                handle: [{ handler: "static_response", status_code: 400 }],
                terminal: true,
              },
              {
                match: [
                  {
                    expression:
                      "{http.request.orig_uri}.split('?')[0] == '/__paseo_services' || {http.request.orig_uri}.startsWith('/__paseo_services/')",
                  },
                ],
                handle: [proxy(`unix/${gatewaySocketPath}`)],
                terminal: true,
              },
              {
                // The daemon must also install createPreviewIngress(null).
                // It rejects encoded/dot/slash aliases using the untouched raw
                // target; no normalized alias may fall through to its SPA.
                handle: [proxy(`127.0.0.1:${daemonPort}`)],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  };
}
