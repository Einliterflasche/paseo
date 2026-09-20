import { expect, test } from "vitest";
import { createProcessTreeTerminator, ProcessTreeOwnershipUnknownError } from "./tree-kill.js";
import type { ProcessIdentity, ProcessTreeInspection } from "./process-tree-inspection.js";

function harness() {
  const child = { pid: 101, exitCode: null as number | null, signalCode: null, kill: () => true };
  const entries = new Map<number, ProcessIdentity>([
    [101, { pid: 101, parentPid: 1, created: "leader-a", stopped: false }],
    [202, { pid: 202, parentPid: 101, created: "child-a", stopped: false }],
  ]);
  const signals: Array<[number, NodeJS.Signals]> = [];
  const foreign = new Set<number>();
  let inspectionFailure = false;
  let onSignal: (pid: number, signal: NodeJS.Signals) => void = () => {};
  const inspect: ProcessTreeInspection = {
    async snapshot() {
      if (inspectionFailure) throw new Error("owned inspection refused");
      return [...entries.values()].map((value) => Object.assign({}, value));
    },
    async read(pid) {
      if (inspectionFailure) throw new Error("owned inspection refused");
      return entries.get(pid) ?? null;
    },
    async signal(pid, signal) {
      if (foreign.has(pid))
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
      signals.push([pid, signal]);
      if (signal === "SIGKILL" || pid === child.pid) {
        entries.get(pid)!.stopped = true;
        if (pid === child.pid) child.exitCode = 0;
      }
      onSignal(pid, signal);
    },
  };
  return {
    child,
    entries,
    signals,
    terminator: createProcessTreeTerminator(inspect),
    failInspection: (value: boolean) => {
      inspectionFailure = value;
    },
    markForeign: (pid: number) => {
      foreign.add(pid);
    },
    onSignal: (fn: typeof onSignal) => {
      onSignal = fn;
    },
  };
}

const timeout = { gracefulTimeoutMs: 0, forceTimeoutMs: 0 };

test("leader exit does not certify a surviving descendant; force signals retained descendants first", async () => {
  const h = harness();
  await expect(h.terminator.terminate(h.child, timeout)).resolves.toBe("killed");
  expect(h.signals).toEqual([
    [202, "SIGTERM"],
    [101, "SIGTERM"],
    [202, "SIGKILL"],
  ]);
});

test("a failed force attempt retains descendants for retry after the leader exits", async () => {
  const h = harness();
  await expect(
    h.terminator.terminate(h.child, { ...timeout, forceSignal: "SIGTERM" }),
  ).resolves.toBe("kill-timeout");
  expect(h.child.exitCode).toBe(0);
  expect(h.entries.get(202)?.stopped).toBe(false);
  await expect(h.terminator.terminate(h.child, timeout)).resolves.toBe("killed");
  expect(h.entries.get(202)?.stopped).toBe(true);
});

test("descendants born under a surviving owner during grace join the force inventory", async () => {
  const h = harness();
  h.onSignal((pid, signal) => {
    if (pid === 202 && signal === "SIGTERM")
      h.entries.set(303, { pid: 303, parentPid: 202, created: "late-child", stopped: false });
  });
  await expect(h.terminator.terminate(h.child, timeout)).resolves.toBe("killed");
  expect(
    h.signals.indexOf(h.signals.find(([pid, signal]) => pid === 303 && signal === "SIGKILL")!),
  ).toBeLessThan(
    h.signals.indexOf(h.signals.find(([pid, signal]) => pid === 202 && signal === "SIGKILL")!),
  );
  expect(h.entries.get(303)?.stopped).toBe(true);
});

test("a replacement process with a reused PID is never signaled", async () => {
  const h = harness();
  await h.terminator.prepare(h.child, { timeoutMs: 100 });
  h.entries.set(202, { pid: 202, parentPid: 999, created: "replacement", stopped: false });
  await expect(h.terminator.terminate(h.child, timeout)).resolves.toBe("terminated");
  expect(h.signals).toEqual([[101, "SIGTERM"]]);
  expect(h.entries.get(202)?.stopped).toBe(false);
});

test("owned inspection failures remain retryable and cannot certify success", async () => {
  const h = harness();
  await h.terminator.prepare(h.child, { timeoutMs: 100 });
  h.failInspection(true);
  await expect(h.terminator.terminate(h.child, timeout)).rejects.toThrow("inspection refused");
  expect(h.signals).toEqual([]);
  h.failInspection(false);
  await expect(h.terminator.terminate(h.child, timeout)).resolves.toBe("killed");
});

test("first inspection after leader death needs independent native completion evidence", async () => {
  const h = harness();
  h.child.exitCode = 1;
  await expect(h.terminator.terminate(h.child, timeout)).rejects.toBeInstanceOf(
    ProcessTreeOwnershipUnknownError,
  );
  expect(h.signals).toEqual([]);
  await expect(
    h.terminator.terminate(h.child, { ...timeout, completedExecution: true }),
  ).resolves.toBe("already-exited");
});

test("omitting the force timeout still requires descendant cessation", async () => {
  const h = harness();
  await expect(
    h.terminator.terminate(h.child, { gracefulTimeoutMs: 0, forceSignal: "SIGTERM" }),
  ).resolves.toBe("kill-timeout");
});

test("a descendant owned by another user cannot be signaled and never blocks certification", async () => {
  const h = harness();
  h.entries.set(303, { pid: 303, parentPid: 202, created: "sudo-child", stopped: false });
  h.markForeign(303);
  await expect(h.terminator.terminate(h.child, timeout)).resolves.toBe("killed");
  expect(h.signals).toEqual([
    [202, "SIGTERM"],
    [101, "SIGTERM"],
    [202, "SIGKILL"],
  ]);
  expect(h.entries.get(202)?.stopped).toBe(true);
  expect(h.entries.get(303)?.stopped).toBe(false);
});

test("owned descendants beneath a foreign process are still stopped before certification", async () => {
  const h = harness();
  h.entries.set(303, { pid: 303, parentPid: 101, created: "sudo-child", stopped: false });
  h.entries.set(404, { pid: 404, parentPid: 303, created: "owned-grandchild", stopped: false });
  h.markForeign(303);
  await expect(h.terminator.terminate(h.child, timeout)).resolves.toBe("killed");
  expect(h.signals).toContainEqual([404, "SIGTERM"]);
  expect(h.signals).toContainEqual([404, "SIGKILL"]);
  expect(h.entries.get(404)?.stopped).toBe(true);
  expect(h.entries.get(303)?.stopped).toBe(false);
});
