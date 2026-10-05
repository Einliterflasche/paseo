import { expect, test } from "vitest";
import { createProcessTreeTerminator, ProcessTreeOwnershipUnknownError } from "./tree-kill.js";
import type { ProcessIdentity, ProcessTreeInspection } from "./process-tree-inspection.js";
import {
  cleanupServiceCgroup,
  inspectServiceCgroup,
  type ServiceCgroup,
} from "./service-cgroup-cleanup.js";

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

test("a fork and parent exit during inspection cannot certify an empty service", async () => {
  let inventory = [202];
  const signals: number[] = [];
  const group = inspectServiceCgroup(
    {
      pids: async () => inventory,
      current: (pid) => (inventory.includes(pid) ? "late-orphan" : null),
      read: async (pid) => {
        if (pid === 202) {
          inventory = [303];
          return null;
        }
        return { pid, parentPid: 1, created: "late-orphan", stopped: false };
      },
      signal: async (pid) => {
        signals.push(pid);
        inventory = [];
      },
    },
    [],
  );
  await cleanupServiceCgroup(group, 100);
  expect(signals).toEqual([303]);
  expect(await group.members()).toEqual([]);
});

test("a read that resolves after the signal deadline never dispatches a late signal", async () => {
  const identity = { pid: 303, parentPid: 1, created: "slow-read", stopped: false };
  let finishRead!: (value: typeof identity) => void;
  const signals: number[] = [];
  const group = inspectServiceCgroup(
    {
      pids: async () => [303],
      current: () => identity.created,
      read: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      signal: async (pid) => {
        signals.push(pid);
      },
    },
    [],
  );
  const pending = group.signal(identity, "SIGKILL", Date.now() - 1);
  finishRead(identity);
  await pending;
  expect(signals).toEqual([]);
});

test("all members in a phase receive the same deadline instead of a fresh per-member budget", async () => {
  const identities = [202, 303, 404].map((pid) => ({
    pid,
    parentPid: 1,
    created: String(pid),
    stopped: false,
  }));
  const deadlines: number[] = [];
  let members = identities;
  const group: ServiceCgroup = {
    members: async () => members,
    signal: async (_identity, signal, deadline) => {
      deadlines.push(deadline!);
      if (signal === "SIGKILL") members = [];
    },
  };
  await cleanupServiceCgroup(group, 0);
  expect(deadlines.slice(0, 3)).toEqual([deadlines[0], deadlines[0], deadlines[0]]);
  expect(deadlines.slice(3)).toEqual([deadlines[3], deadlines[3], deadlines[3]]);
});

test("the phase stops before further slow members consume fresh budgets", async () => {
  let clock = Date.now();
  const signals: Array<[number, NodeJS.Signals]> = [];
  let members = [202, 303, 404].map((pid) => ({
    pid,
    parentPid: 1,
    created: String(pid),
    stopped: false,
  }));
  await cleanupServiceCgroup(
    {
      members: async () => members,
      signal: async (identity, signal) => {
        signals.push([identity.pid, signal]);
        clock += 10_000;
        if (signal === "SIGKILL") members = [];
      },
    },
    10_000,
    () => clock,
  );
  expect(signals).toEqual([
    [202, "SIGTERM"],
    [202, "SIGKILL"],
  ]);
});

test("a timed out identity read cannot send a signal when it later resolves", async () => {
  const identity = { pid: 303, parentPid: 1, created: "late-read", stopped: false };
  let finishRead!: (value: typeof identity) => void;
  let pending!: Promise<void>;
  const signals: number[] = [];
  const inspected = inspectServiceCgroup(
    {
      pids: async () => [303],
      current: () => identity.created,
      read: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      signal: async (pid) => {
        signals.push(pid);
      },
    },
    [],
  );
  await expect(
    cleanupServiceCgroup(
      {
        members: async () => [identity],
        signal: (target, signal, deadline) => {
          pending = inspected.signal(target, signal, deadline);
          return pending;
        },
      },
      10,
    ),
  ).rejects.toThrow("cleanup remains unconfirmed");
  finishRead(identity);
  await pending;
  expect(signals).toEqual([]);
});

test("service cleanup stops reparented members gracefully and forces only stuck members", async () => {
  const members = new Map<number, ProcessIdentity>([
    [202, { pid: 202, parentPid: 1, created: "orphan", stopped: false }],
    [303, { pid: 303, parentPid: 1, created: "stuck-orphan", stopped: false }],
  ]);
  const signals: Array<[number, NodeJS.Signals]> = [];
  const group: ServiceCgroup = {
    members: async () => [...members.values()],
    signal: async (identity, signal) => {
      signals.push([identity.pid, signal]);
      if (identity.pid === 202 || signal === "SIGKILL") members.delete(identity.pid);
    },
  };
  await cleanupServiceCgroup(group, 0);
  expect(signals).toEqual([
    [202, "SIGTERM"],
    [303, "SIGTERM"],
    [303, "SIGKILL"],
  ]);
  expect(members.size).toBe(0);
});

test("service cleanup refuses certification when a member survives forced termination", async () => {
  const identity = { pid: 303, parentPid: 1, created: "unkillable", stopped: false };
  const signals: NodeJS.Signals[] = [];
  await expect(
    cleanupServiceCgroup(
      {
        members: async () => [identity],
        signal: async (_identity, signal) => {
          signals.push(signal);
        },
      },
      0,
    ),
  ).rejects.toThrow("cleanup remains unconfirmed");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

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

test.each(["creation", "membership"])(
  "a target changing during the proof guard is never signaled: %s",
  async (change) => {
    const identity = { pid: 303, parentPid: 1, created: "old", stopped: false };
    let created: string | null = identity.created;
    const signals: number[] = [];
    const group = inspectServiceCgroup(
      {
        pids: async () => [303],
        read: async () => identity,
        current: () => created,
        signal: (pid) => {
          signals.push(pid);
        },
      },
      [],
    );
    await group.signal(identity, "SIGKILL", Date.now() + 1000, async () => {
      created = change === "creation" ? "unrelated-reused-pid" : null;
    });
    expect(signals).toEqual([]);
  },
);

test("dispatch rechecks the deadline after the proof guard and synchronous target read", async () => {
  let clock = 0;
  const identity = { pid: 303, parentPid: 1, created: "old", stopped: false };
  const signals: number[] = [];
  const group = inspectServiceCgroup(
    {
      pids: async () => [303],
      read: async () => identity,
      current: () => {
        clock = 10;
        return identity.created;
      },
      signal: (pid) => {
        signals.push(pid);
      },
    },
    [],
    () => clock,
  );
  await group.signal(identity, "SIGKILL", 10, async () => {});
  expect(signals).toEqual([]);
});

test("an expired graceful inspection escalates and cannot dispatch its late signal", async () => {
  const identity = { pid: 303, parentPid: 1, created: "stuck", stopped: false };
  let alive = true;
  let reads = 0;
  let finishRead!: (value: typeof identity) => void;
  const signals: NodeJS.Signals[] = [];
  const group = inspectServiceCgroup(
    {
      pids: async () => (alive ? [303] : []),
      read: async () => {
        if (++reads === 2)
          return new Promise((resolve) => {
            finishRead = resolve;
          });
        return identity;
      },
      current: () => (alive ? identity.created : null),
      signal: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
    },
    [],
  );
  let term!: Promise<void>;
  await cleanupServiceCgroup(
    {
      members: (deadline) => group.members(deadline),
      signal: (target, signal, deadline) => {
        const pending = group.signal(target, signal, deadline);
        if (signal === "SIGTERM") term = pending;
        return pending;
      },
    },
    10,
  );
  finishRead(identity);
  await term;
  expect(signals).toEqual(["SIGKILL"]);
});

test.each([
  "Prepared generation changed; cleanup refused",
  "Service cgroup changed during cleanup",
])("phase expiry never hides a proof or ownership failure: %s", async (message) => {
  let clock = 0;
  let inspections = 0;
  const signals: NodeJS.Signals[] = [];
  await expect(
    cleanupServiceCgroup(
      {
        members: async () => {
          inspections++;
          clock = 10;
          throw new Error(message);
        },
        signal: async (_identity, signal) => {
          signals.push(signal);
        },
      },
      10,
      () => clock,
    ),
  ).rejects.toThrow(message);
  expect(inspections).toBe(1);
  expect(signals).toEqual([]);
});
