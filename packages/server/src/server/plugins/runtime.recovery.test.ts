import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { PluginRuntime } from "./runtime.js";

function isCatalogEvent(
  event: ProviderEvent,
): event is Extract<ProviderEvent, { type: "catalog" }> {
  return event.type === "catalog";
}

function runtime() {
  return new PluginRuntime(createTestLogger(), "0.4.0", {
    sessionHost: {
      async attachPluginSocket(_pluginId, socket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string" || JSON.parse(data).type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "recovery-test",
                  hostname: "test",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  });
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/^[ZX] /.test(stat.slice(stat.lastIndexOf(") ") + 2))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function plugin(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-plugin-recovery-"));
  await writeFile(join(directory, "paseo-plugin.json"), JSON.stringify({ id: "recovery-test" }));
  await writeFile(
    join(directory, "index.server.ts"),
    source.replaceAll("__PID_PATH__", JSON.stringify(join(directory, "pid"))),
  );
  return directory;
}

describe.runIf(process.platform !== "win32")("Plugin worker restart ownership", () => {
  test.each(["external", "builtin"] as const)(
    "retries failed close across the %s worker boundary and drains final output",
    async (kind) => {
      const directory = await plugin(`import { spawn } from "node:child_process";
export default function contribute(server) {
  server.registerProvider({ id: "owned", label: "Owned", async connect(request) {
    if (!request.processes) throw new Error("Missing worker-local lifecycle port");
    const listeners = new Set();
    const child = spawn(process.execPath, ["-e", 'const { spawn } = require("node:child_process"); const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); process.on("SIGTERM", () => { process.stdout.write("final output"); process.exit(0); }); console.log("READY:" + descendant.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
    const owner = request.processes.own({ process: child });
    const ready = await new Promise((resolve) => child.stdout.once("data", (data) => resolve(data.toString())));
    const descendantPid = Number(ready.split(":")[1]);
    child.stdout.on("data", (data) => { for (const listener of listeners) listener({ type: "timeline.item", sessionId: "native", item: { type: "assistant_message", id: "late", text: data.toString() } }); });
    let attempt = 0;
    return { version: 1, capabilities: [], onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async send(input) { if (input.type === "catalog") { for (const listener of listeners) listener({ type: "catalog", requestId: input.requestId, catalog: { models: [{ id: String(descendantPid), label: "Descendant" }], modes: [] } }); } }, async close() { if (++attempt === 1) throw new Error("inspection denied"); await owner.close(); } };
  } });
  return () => {};
}`);
      const host = runtime();
      try {
        if (kind === "builtin") await host.startBuiltinPlugin({ id: "recovery-test", directory });
        else await host.startPlugin("recovery-test", directory);
        const connection = await host.connectProvider("recovery-test", "owned", {
          versions: [1],
          capabilities: [],
        });
        const events: ProviderEvent[] = [];
        connection.onEvent((event) => events.push(event));
        await connection.send({ type: "catalog", requestId: "owned-descendant" });
        await expect.poll(() => events.find(isCatalogEvent)).toBeDefined();
        const catalog = events.find(isCatalogEvent);
        if (catalog?.type !== "catalog") throw new Error("Missing native descendant report");
        const descendantPid = Number(catalog.catalog.models[0]?.id);
        expect(running(descendantPid)).toBe(true);
        await expect(connection.close()).rejects.toThrow("inspection denied");
        await connection.close();
        expect(running(descendantPid)).toBe(false);
        expect(events).toContainEqual({
          type: "timeline.item",
          sessionId: "native",
          item: { type: "assistant_message", id: "late", text: "final output" },
        });
      } finally {
        await host.stopAll();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each(["external", "builtin"] as const)(
    "certifies a pending status process through the %s restart barrier while keeping definitions published",
    async (kind) => {
      const directory = await plugin(`import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
export default function contribute(server) {
  server.registerProvider({ id: "owned", label: "Owned", async connect() { throw new Error("unused"); }, async status(request) {
    if (!request.processes) throw new Error("Missing worker-local lifecycle port");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    request.processes.own({ process: child });
    await writeFile(__PID_PATH__, String(child.pid));
    await new Promise((resolve) => child.once("close", resolve));
    return { available: true };
  } });
  return () => {};
}`);
      const host = runtime();
      try {
        if (kind === "builtin") await host.startBuiltinPlugin({ id: "recovery-test", directory });
        else await host.startPlugin("recovery-test", directory);
        const status = host.getProviderStatus("recovery-test", "owned", {});
        const pid = async () =>
          Number(await readFile(join(directory, "pid"), "utf8").catch(() => "0"));
        await expect.poll(pid).toBeGreaterThan(0);
        const processId = await pid();
        expect(running(processId)).toBe(true);
        await host.prepareForRestart();
        await expect(status).resolves.toEqual({ available: true });
        expect(running(processId)).toBe(false);
        expect(host.getProviderRegistrations("recovery-test")).toEqual([
          expect.objectContaining({ id: "owned" }),
        ]);
        await host.prepareForRestart();
      } finally {
        await host.stopAll();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
