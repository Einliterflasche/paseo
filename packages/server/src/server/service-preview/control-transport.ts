import type { IncomingMessage } from "node:http";

/** One explicit browser origin; paths, credentials and URL aliases are not settings. */
export function parseControlOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.origin !== value) {
    throw new Error("Control transport requires an exact HTTPS origin");
  }
  return origin;
}

export function controlAuthorities(controlOrigin: string | null, localPorts: readonly number[]) {
  const authorities = new Set<string>();
  if (controlOrigin) {
    const origin = parseControlOrigin(controlOrigin);
    authorities.add(origin.host.toLowerCase());
    if (!origin.port) authorities.add(`${origin.hostname.toLowerCase()}:443`);
  }
  for (const port of localPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    authorities.add(`127.0.0.1:${port}`);
    authorities.add(`localhost:${port}`);
  }
  return [...authorities];
}

/** Runs before Express and upgrade dispatch; forwarding headers never grant access. */
export function admitControlRequest(
  request: IncomingMessage,
  authorities: readonly string[],
): boolean {
  const target = request.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//") || /[\\#\s]/.test(target)) return false;
  let hostCount = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i].toLowerCase() === "host") hostCount++;
  }
  const host = request.headers.host;
  if (hostCount !== 1 || !host || !authorities.includes(host.toLowerCase())) return false;
  // Downstream control URL helpers see the same authority we admitted. Retain
  // only the established trusted-proxy scheme contract, not forwarded authority.
  delete request.headers.forwarded;
  delete request.headers["x-forwarded-port"];
  request.headers["x-forwarded-host"] = host;
  return true;
}
