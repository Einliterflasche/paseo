import { setImmediate as flushCallbacks } from "node:timers/promises";
import pino from "pino";
import { describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { JsonlRpcTransportClosedError } from "./jsonl-rpc-process.js";
import { PiRpcAgentClient } from "./pi/agent.js";
import { FakePi } from "./pi/test-utils/fake-pi.js";
import { OmpAgentClient } from "./omp/agent.js";
import { FakeOmp } from "./omp/test-utils/fake-omp.js";

async function setup(provider: "pi" | "omp") {
  const logger = pino({ level: "silent" });
  const pi = new FakePi();
  const omp = new FakeOmp();
  const client =
    provider === "pi"
      ? new PiRpcAgentClient({ logger, runtime: pi })
      : new OmpAgentClient({ logger, runtime: omp });
  const session = await client.createSession({ provider, cwd: "/tmp/paseo-close-outcomes" });
  const runtime = provider === "pi" ? pi.latestSession() : omp.latestSession();
  const prompt = Promise.withResolvers<never>();
  runtime.prompt = () => prompt.promise;
  const stopped = Promise.withResolvers<void>();
  runtime.close = () => stopped.promise;
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const { turnId } = await session.startTurn("preserve this unfinished work");
  runtime.emit({ type: "turn_start" });
  const terminals = () =>
    events.filter(
      (event) =>
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled",
    );
  return { session, runtime, prompt, stopped, events, turnId, terminals };
}

describe.each(["pi", "omp"] as const)("%s owned close outcomes", (provider) => {
  test("transport shutdown keeps late output attributed and cancels only after drain", async () => {
    const { session, runtime, prompt, stopped, events, turnId, terminals } = await setup(provider);
    const close = session.close();
    prompt.reject(new JsonlRpcTransportClosedError("RPC process exited with code 0"));
    runtime.emit({ type: "process_exit", error: "RPC process exited with code 0" });
    await flushCallbacks();
    runtime.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "last" },
    });
    runtime.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "last" },
      assistantMessageEvent: { type: "text_delta", delta: "final stdout" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        turnId,
        item: expect.objectContaining({ type: "assistant_message", text: "final stdout" }),
      }),
    );
    expect(terminals()).toEqual([]);
    stopped.resolve();
    await close;
    await session.close();
    expect(terminals()).toEqual([
      { type: "turn_canceled", provider, turnId, reason: "session closed" },
    ]);
  });

  test("a real prompt rejection racing close remains a failed turn", async () => {
    const { session, runtime, prompt, stopped, turnId, terminals } = await setup(provider);
    // The native response was decoded before close; its promise callback runs
    // after the close flag is set. A blanket closed check would lose it.
    prompt.reject(new Error("native prompt validation rejected"));
    const close = session.close();
    await flushCallbacks();
    runtime.finishTurn({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "native prompt validation rejected",
    });
    stopped.resolve();
    await close;
    expect(terminals()).toEqual([
      { type: "turn_failed", provider, turnId, error: "native prompt validation rejected" },
    ]);
  });

  test.each(["error", "stop"] as const)(
    "a final native %s outcome survives close",
    async (stopReason) => {
      const { session, runtime, prompt, stopped, turnId, terminals } = await setup(provider);
      const close = session.close();
      prompt.reject(new JsonlRpcTransportClosedError("closed"));
      runtime.finishTurn({
        role: "assistant",
        content: [],
        stopReason,
        ...(stopReason === "error" ? { errorMessage: "genuine model failure" } : {}),
      });
      await flushCallbacks();
      stopped.resolve();
      await close;
      expect(terminals()).toHaveLength(1);
      expect(terminals()[0]).toMatchObject({
        type: stopReason === "error" ? "turn_failed" : "turn_completed",
        turnId,
      });
      if (stopReason === "error")
        expect(terminals()[0]).toMatchObject({
          error: expect.stringContaining("genuine model failure"),
        });
    },
  );

  test("a failed close keeps an aborted turn owned until fresh successful cleanup", async () => {
    const { session, runtime, prompt, stopped, turnId, terminals } = await setup(provider);
    const close = session.close();
    const failed = expect(close).rejects.toThrow("termination unconfirmed");
    prompt.reject(new JsonlRpcTransportClosedError("closed"));
    runtime.finishTurn({
      role: "assistant",
      content: [],
      stopReason: "aborted",
      errorMessage: "native cancellation",
    });
    stopped.reject(new Error("termination unconfirmed"));
    await failed;
    await flushCallbacks();
    expect(terminals()).toEqual([]);
    const certified = Promise.withResolvers<void>();
    runtime.close = () => certified.promise;
    const retry = session.close();
    expect(terminals()).toEqual([]);
    certified.resolve();
    await retry;
    expect(terminals()).toEqual([
      { type: "turn_canceled", provider, turnId, reason: "session closed" },
    ]);
  });
});
