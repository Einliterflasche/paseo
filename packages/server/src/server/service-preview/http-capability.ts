import http from "node:http";

const HTTP_CAPABILITY_TIMEOUT_MS = 500;

/** A response at any status proves the local endpoint speaks HTTP. */
export function probeHttpCapability(
  port: number,
  signal?: AbortSignal,
  timeoutMs = HTTP_CAPABILITY_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      method: "HEAD",
      headers: { Connection: "close" },
      agent: false,
      signal,
    });
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve(supported);
    };
    request.setTimeout(timeoutMs, () => finish(false));
    request.once("response", (response) => {
      response.destroy();
      finish(true);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}
