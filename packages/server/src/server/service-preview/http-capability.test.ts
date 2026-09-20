import http from "node:http";
import net from "node:net";
import { afterEach, expect, it } from "vitest";
import { probeHttpCapability } from "./http-capability.js";

const servers: Array<http.Server | net.Server> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

it("recognizes an HTTP endpoint regardless of its response status", async () => {
  const port = await listen(
    http.createServer((_request, response) => response.writeHead(503).end()),
  );
  await expect(probeHttpCapability(port)).resolves.toBe(true);
});

it("does not advertise a custom TCP protocol as a web preview", async () => {
  const port = await listen(
    net.createServer((socket) => {
      socket.once("data", () => socket.end("ASB/1 READY\r\n"));
    }),
  );
  await expect(probeHttpCapability(port)).resolves.toBe(false);
});
