import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { PluginAgentClientRegistry } from "./plugin-provider.js";

function harness() {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const inputs: ProviderInput[] = [];
  let closes = 0;
  let failSession = true;
  const capabilities = ["prompt.message", "session.persistence"] as const;
  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };
  const connection: ProviderConnection = {
    version: 1,
    capabilities,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(input) {
      inputs.push(input);
      if (input.type === "session.open") {
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities,
          restoration: "core",
          persistence: { version: 1, data: { native: "preserved" } },
          cwd: input.config.cwd,
        });
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      } else if (input.type === "session.close") {
        if (failSession) {
          failSession = false;
          throw new Error("native session still running");
        }
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "final", text: "last output" },
        });
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
      } else if ("requestId" in input)
        emit({ type: "request.completed", requestId: input.requestId });
    },
    async close() {
      if (++closes === 1) throw new Error("connection tree inspection failed");
    },
  };
  const registry = new PluginAgentClientRegistry(createTestLogger());
  registry.replace([
    { id: "retry-provider", label: "Retry provider", connect: async () => connection },
  ]);
  return {
    registry,
    client: registry.clients()["retry-provider"]!,
    inputs,
    closes: () => closes,
    emit,
  };
}

describe("Plugin provider certified close", () => {
  test("keeps isolated probe output attached when connection certification fails after session close", async () => {
    const { registry, client, inputs, emit } = harness();
    const probe = { signal: new AbortController().signal, own: () => () => undefined };
    const session = await client.createSession(
      { provider: "retry-provider", cwd: "/tmp/project" },
      undefined,
      { probe },
    );
    const text: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message")
        text.push(event.item.text);
    });
    await expect(session.close()).rejects.toThrow("native session still running");
    await expect(session.close()).rejects.toThrow("connection tree inspection failed");
    const open = inputs.find((input) => input.type === "session.open");
    if (open?.type !== "session.open") throw new Error("Missing native session open");
    emit({
      type: "timeline.item",
      sessionId: open.sessionId,
      item: { type: "assistant_message", id: "after-session", text: "last connection output" },
    });
    await session.close();
    expect(text).toEqual(["last output", "last connection output"]);
    expect(inputs.filter((input) => input.type === "session.close")).toHaveLength(2);
    await registry.shutdown();
  });

  test("retains the session subscription and retries a failed native close", async () => {
    const { registry, client } = harness();
    const session = await client.createSession({ provider: "retry-provider", cwd: "/tmp/project" });
    const text: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message")
        text.push(event.item.text);
    });
    await expect(session.close()).rejects.toThrow("native session still running");
    await session.close();
    expect(text).toEqual(["last output"]);
    await expect(registry.shutdown()).rejects.toThrow("connection tree inspection failed");
    await registry.shutdown();
  });

  test("keeps a failed connection owner reachable for registry shutdown retry", async () => {
    const { registry, client, closes } = harness();
    await client.createSession({ provider: "retry-provider", cwd: "/tmp/project" });
    await expect(registry.shutdown()).rejects.toThrow("connection tree inspection failed");
    expect(registry.clients()["retry-provider"]).toBe(client);
    await registry.shutdown();
    expect(closes()).toBe(2);
    expect(registry.clients()).toEqual({});
  });

  test("suppresses native replay only for checkpoint-owned history", async () => {
    const { registry, client, inputs } = harness();
    const original = await client.createSession({
      provider: "retry-provider",
      cwd: "/tmp/project",
    });
    const handle = original.describePersistence();
    if (!handle) throw new Error("Missing test persistence");
    await client.resumeSession(handle, { cwd: "/tmp/project" }, undefined, {
      replayHistory: false,
    });
    await client.resumeSession(handle, { cwd: "/tmp/project" });
    expect(
      inputs.filter((input) => input.type === "session.open").map((input) => input.history),
    ).toEqual(["skip", "skip", "replay"]);
    await expect(registry.shutdown()).rejects.toThrow("connection tree inspection failed");
    await registry.shutdown();
  });
});
