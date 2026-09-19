import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { admitControlRequest, controlAuthorities } from "./control-transport.js";

const cleanups: Array<() => Promise<void>> = [];

async function fixture(origin: string | null) {
  const observations: Array<{
    target: string | undefined;
    host: string | undefined;
    forwarded: string | string[] | undefined;
    forwardedHost: string | string[] | undefined;
    forwardedPort: string | string[] | undefined;
    forwardedProto: string | string[] | undefined;
  }> = [];
  let authorities: string[] = [];
  const sockets = new Set<Socket>();
  const admit = (request: IncomingMessage) => {
    if (!admitControlRequest(request, authorities)) return false;
    observations.push({
      target: request.url,
      host: request.headers.host,
      forwarded: request.headers.forwarded,
      forwardedHost: request.headers["x-forwarded-host"],
      forwardedPort: request.headers["x-forwarded-port"],
      forwardedProto: request.headers["x-forwarded-proto"],
    });
    return true;
  };
  const server = createServer((request, response) => {
    const allowed = admit(request);
    request.resume();
    response.writeHead(allowed ? 204 : 403);
    response.end();
  });
  server.on("upgrade", (request, socket) => {
    socket.end(
      `HTTP/1.1 ${admit(request) ? 204 : 403} Fixture\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing control fixture address");
  authorities = controlAuthorities(origin, [address.port]);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: address.port,
    observations,
    exchange(target: string, headers: string[], upgrade = false) {
      return new Promise<number>((resolve, reject) => {
        const socket = connect(address.port, "127.0.0.1");
        let response = "";
        socket.on("data", (part) => {
          response += part.toString();
        });
        socket.on("error", reject);
        socket.on("end", () => resolve(Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1])));
        socket.on("connect", () =>
          socket.write(
            `GET ${target} HTTP/1.1\r\n${headers.join("\r\n")}\r\nConnection: ${upgrade ? "Upgrade\r\nUpgrade: fixture" : "close"}\r\n\r\n`,
          ),
        );
      });
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("control request authority", () => {
  it("admits omitted or explicit HTTPS default port and hostname case, but not other authorities", async () => {
    const f = await fixture("https://control.test");
    for (const host of ["control.test", "control.test:443", "CONTROL.TEST:443"])
      expect(await f.exchange("/api/status?next=%2Fpreview", [`Host: ${host}`])).toBe(204);
    for (const host of [
      "control.test:80",
      "control.test:444",
      "control.test.",
      "control.test:0443",
      "alias.control.test",
      "control.test,legacy.test",
    ])
      expect(await f.exchange("/api/status", [`Host: ${host}`])).toBe(403);
    expect(f.observations.map((entry) => entry.host)).toEqual([
      "control.test",
      "control.test:443",
      "CONTROL.TEST:443",
    ]);
  });

  it("allows only explicit loopback CLI ports when public authority is unavailable", async () => {
    const f = await fixture(null);
    for (const host of [`127.0.0.1:${f.port}`, `localhost:${f.port}`])
      expect(await f.exchange("/api/status", [`Host: ${host}`])).toBe(204);
    for (const host of [
      "127.0.0.1",
      "localhost",
      "control.test",
      `127.0.0.2:${f.port}`,
      `[::1]:${f.port}`,
    ])
      expect(await f.exchange("/api/status", [`Host: ${host}`])).toBe(403);
    expect(f.observations).toHaveLength(2);
  });

  it("requires one Host and origin-form targets before both HTTP and upgrade handling", async () => {
    const f = await fixture("https://control.test:9443");
    for (const upgrading of [false, true]) {
      expect(
        await f.exchange("/ws", ["Host: control.test:9443", "hOsT: legacy.test"], upgrading),
      ).toBe(403);
      for (const target of [
        "https://control.test:9443/ws",
        "//control.test:9443/ws",
        "/path\\separator",
        "/path#fragment",
      ])
        expect(await f.exchange(target, ["Host: control.test:9443"], upgrading)).toBe(403);
    }
    expect(f.observations).toEqual([]);
  });

  it("forged forwarded authority cannot admit an alias and is replaced after an accepted Host", async () => {
    const f = await fixture("https://control.test:9443");
    for (const upgrading of [false, true]) {
      expect(
        await f.exchange(
          "/ws",
          [
            "Host: legacy.test",
            "X-Forwarded-Host: control.test:9443",
            "Forwarded: host=control.test:9443",
          ],
          upgrading,
        ),
      ).toBe(403);
      expect(
        await f.exchange(
          "/ws?retained=%2F",
          [
            "Host: control.test:9443",
            "X-Forwarded-Host: legacy.test",
            "X-Forwarded-Port: 1",
            "Forwarded: host=legacy.test;proto=http",
            "X-Forwarded-Proto: https",
          ],
          upgrading,
        ),
      ).toBe(204);
    }
    expect(f.observations).toEqual(
      [false, true].map(() => ({
        target: "/ws?retained=%2F",
        host: "control.test:9443",
        forwarded: undefined,
        forwardedHost: "control.test:9443",
        forwardedPort: undefined,
        forwardedProto: "https",
      })),
    );
  });
});
