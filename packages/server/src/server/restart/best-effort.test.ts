import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attempt, attemptWithin, RestartStepTimeoutError } from "./best-effort.js";

interface ReportedFailure {
  step: string;
  error: unknown;
}

function recordingReporter() {
  const failures: ReportedFailure[] = [];
  return {
    failures,
    report: (step: string, error: unknown) => {
      failures.push({ step, error });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("attempt returns the operation result without reporting", async () => {
  const { failures, report } = recordingReporter();
  await expect(attempt(report, "load", async () => "saved", "fallback")).resolves.toBe("saved");
  expect(failures).toEqual([]);
});

test("attempt reports a rejection or a synchronous throw and returns the fallback", async () => {
  const { failures, report } = recordingReporter();
  const rejected = new Error("disk full");
  const thrown = new Error("bad input");
  await expect(attempt(report, "commit", () => Promise.reject(rejected), "fallback")).resolves.toBe(
    "fallback",
  );
  await expect(
    attempt(
      report,
      "install",
      () => {
        throw thrown;
      },
      "fallback",
    ),
  ).resolves.toBe("fallback");
  expect(failures).toEqual([
    { step: "commit", error: rejected },
    { step: "install", error: thrown },
  ]);
});

test("a throwing reporter cannot make attempt reject", async () => {
  await expect(
    attempt(
      () => {
        throw new Error("logger closed");
      },
      "resume",
      () => Promise.reject(new Error("resume failed")),
      "fallback",
    ),
  ).resolves.toBe("fallback");
});

test("attemptWithin returns an early result and clears its deadline", async () => {
  const { failures, report } = recordingReporter();
  await expect(
    attemptWithin(report, "stop", 1_000, async () => "stopped", "fallback"),
  ).resolves.toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
  expect(failures).toEqual([]);
});

test("attemptWithin reports a timeout, returns the fallback, and ignores the late result", async () => {
  const { failures, report } = recordingReporter();
  const operation = Promise.withResolvers<string>();
  const result = attemptWithin(report, "checkpoint", 1_000, () => operation.promise, "fallback");
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(result).resolves.toBe("fallback");
  operation.resolve("late");
  await vi.runAllTimersAsync();
  expect(failures).toEqual([
    { step: "checkpoint", error: new RestartStepTimeoutError("checkpoint", 1_000) },
  ]);
  expect(failures[0]!.error).toBeInstanceOf(RestartStepTimeoutError);
  expect(failures[0]!.error).toMatchObject({ step: "checkpoint", timeoutMs: 1_000 });
});

test("attemptWithin reports a late rejection without throwing it", async () => {
  const { failures, report } = recordingReporter();
  const operation = Promise.withResolvers<string>();
  const result = attemptWithin(report, "restore", 500, () => operation.promise, "fallback");
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toBe("fallback");
  const late = new Error("late failure");
  operation.reject(late);
  await vi.runAllTimersAsync();
  expect(failures.map((failure) => failure.step)).toEqual(["restore", "restore"]);
  expect(failures[1]!.error).toBe(late);
});

test("attemptWithin reports an early rejection or a synchronous throw once", async () => {
  const { failures, report } = recordingReporter();
  const rejected = new Error("stop failed");
  const thrown = new Error("hook threw");
  await expect(
    attemptWithin(report, "stop", 1_000, () => Promise.reject(rejected), "fallback"),
  ).resolves.toBe("fallback");
  await expect(
    attemptWithin(
      report,
      "stop",
      1_000,
      () => {
        throw thrown;
      },
      "fallback",
    ),
  ).resolves.toBe("fallback");
  await vi.runAllTimersAsync();
  expect(failures).toEqual([
    { step: "stop", error: rejected },
    { step: "stop", error: thrown },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
