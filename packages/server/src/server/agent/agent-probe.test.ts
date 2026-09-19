import { expect, test } from "vitest";
import { AgentProbe } from "./agent-probe.js";
import { ProviderInitializationCleanupError } from "./provider-initialization-cleanup-error.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("probe stop reaches the resource before joining its pending native query", async () => {
  const probe = new AgentProbe();
  const entered = gate();
  const nativeReply = gate();
  const events: string[] = [];
  const result = probe.run(async (context) => {
    context.own({
      close: async () => {
        events.push("closed");
        nativeReply.resolve();
      },
    });
    entered.resolve();
    await nativeReply.promise;
    events.push("query settled");
    return "result";
  });
  await entered.promise;
  await probe.close();
  expect(await result).toBe("result");
  expect(events).toEqual(["closed", "query settled"]);
});

test("a successful query whose cleanup failed still transfers a retryable cleanup owner", async () => {
  const probe = new AgentProbe();
  let attempts = 0;
  const result = probe.run(async (context) => {
    context.own({
      close: async () => {
        if (++attempts === 1) throw new Error("process still alive");
      },
    });
    return "result";
  });
  let failure: unknown;
  try {
    await result;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProviderInitializationCleanupError);
  await (failure as ProviderInitializationCleanupError).cleanup.close();
  expect(attempts).toBe(2);
});

test("a resource acquired after stop began is closed before the probe can settle", async () => {
  const probe = new AgentProbe();
  const acquiring = gate();
  const acquired = gate();
  const closed = gate();
  let closeCount = 0;
  const result = probe.run(async (context) => {
    acquiring.resolve();
    await acquired.promise;
    context.own({
      close: async () => {
        closeCount++;
        closed.resolve();
      },
    });
    await closed.promise;
    return "late acquisition";
  });
  await acquiring.promise;
  const stop = probe.close();
  acquired.resolve();
  await stop;
  expect(await result).toBe("late acquisition");
  expect(closeCount).toBe(1);
});
