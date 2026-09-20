import pino from "pino";
import { describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { createServiceProxySubsystem, ServiceProxyRouteRegistry } from "../service-proxy.js";
import {
  WorkspaceScriptRuntimeStore,
  type ScriptRuntimeEntry,
} from "../workspace-script-runtime-store.js";
import { PreviewBroker, type PreviewAuthorizedJob } from "./broker.js";
import { ManagedPreviewRoutes, type ManagedPreviewEnrollment } from "./managed.js";
import { managedPreviewServiceId } from "./policy.js";
import { PreviewRouteError, PreviewRoutes } from "./routes.js";
import { PreviewSources, PREVIEW_SOURCE_CAPABILITY } from "./sources.js";

const enrollment: ManagedPreviewEnrollment = {
  serviceId: "atlas",
  workspaceId: "workspace-a",
  scriptName: "web",
  name: "Atlas React",
  mount: "preserve",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function runtimeEntry(overrides: Partial<ScriptRuntimeEntry> = {}): ScriptRuntimeEntry {
  return {
    workspaceId: enrollment.workspaceId,
    scriptName: enrollment.scriptName,
    type: "service",
    lifecycle: "running",
    terminalId: "terminal-a",
    exitCode: null,
    ...overrides,
  };
}

function fixture(report: (error: unknown) => void | Promise<void> = () => {}) {
  const runtime = new WorkspaceScriptRuntimeStore();
  const endpoints = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  const sources = new PreviewSources("https://control.test");
  const brokerFailures: unknown[] = [];
  const broker = new PreviewBroker({
    sources,
    routes,
    onFailure(error) {
      brokerFailures.push(error);
    },
  });
  const failures: unknown[] = [];
  const managed = new ManagedPreviewRoutes({
    runtime,
    endpoints,
    qualifyHttp: () => true,
    routes,
    onFailure(error) {
      failures.push(error);
      return report(error);
    },
  });
  function endpoint(input: { workspaceId?: string; scriptName?: string; port?: number } = {}) {
    const workspaceId = input.workspaceId ?? enrollment.workspaceId;
    return endpoints.registerWorkspaceService({
      workspaceId,
      projectSlug: "react-preview",
      branchName: workspaceId,
      scriptName: input.scriptName ?? enrollment.scriptName,
      port: input.port ?? 5173,
    });
  }
  const frames: string[] = [];
  const socket = { readyState: 1 };
  sources.admitDirectOwner({
    socket,
    connectionId: "control-source",
    principalId: "owner",
    origin: "https://control.test",
    permissions: OWNER_PERMISSIONS,
    send: async (frame) => {
      frames.push(frame);
      return true;
    },
  });
  sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
  return {
    runtime,
    endpoints,
    endpoint,
    routes,
    sources,
    broker,
    managed,
    socket,
    frames,
    failures,
    brokerFailures,
  };
}

type Fixture = ReturnType<typeof fixture>;

it("enables a running managed service by default with a stripped mount", () => {
  const f = fixture();
  f.endpoint();
  f.runtime.set(runtimeEntry());
  f.managed.restoreDefault(enrollment.workspaceId, enrollment.scriptName);

  const serviceId = managedPreviewServiceId(enrollment);
  expect(f.routes.describe()).toContainEqual(
    expect.objectContaining({
      serviceId,
      workspaceId: enrollment.workspaceId,
      scriptName: enrollment.scriptName,
      port: 5173,
    }),
  );
});

it("keeps a reachable custom TCP service running without advertising a web route", async () => {
  const runtime = new WorkspaceScriptRuntimeStore();
  const endpoints = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
  const routes = new PreviewRoutes({ excludedPorts: [] });
  const checked: number[] = [];
  const managed = new ManagedPreviewRoutes({
    runtime,
    endpoints,
    routes,
    qualifyHttp(port) {
      checked.push(port);
      return Promise.resolve(false);
    },
    onFailure() {},
  });
  endpoints.registerWorkspaceService({
    workspaceId: enrollment.workspaceId,
    projectSlug: "custom-protocol",
    branchName: "main",
    scriptName: enrollment.scriptName,
    port: 7132,
  });
  runtime.set(runtimeEntry());
  managed.restoreDefault(enrollment.workspaceId, enrollment.scriptName);
  await Promise.resolve();

  expect(runtime.get(enrollment)?.lifecycle).toBe("running");
  expect(endpoints.getWorkspaceHealthTargets(enrollment.workspaceId)).toHaveLength(1);
  expect(routes.capture(managedPreviewServiceId(enrollment))).toBeNull();
  expect(checked).toEqual([7132]);

  runtime.set(runtimeEntry());
  await Promise.resolve();
  expect(checked).toEqual([7132, 7132]);
  expect(routes.capture(managedPreviewServiceId(enrollment))).toBeNull();
  managed.close();
});

it("requalifies the same binding after a later lifecycle notification", async () => {
  const runtime = new WorkspaceScriptRuntimeStore();
  const endpoints = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
  const routes = new PreviewRoutes({ excludedPorts: [] });
  let attempts = 0;
  const managed = new ManagedPreviewRoutes({
    runtime,
    endpoints,
    routes,
    qualifyHttp() {
      attempts += 1;
      return Promise.resolve(attempts > 1);
    },
    onFailure() {},
  });
  endpoints.registerWorkspaceService({
    workspaceId: enrollment.workspaceId,
    projectSlug: "slow-http",
    branchName: "main",
    scriptName: enrollment.scriptName,
    port: 7133,
  });
  runtime.set(runtimeEntry());
  managed.restoreDefault(enrollment.workspaceId, enrollment.scriptName);
  await Promise.resolve();
  expect(routes.capture(managedPreviewServiceId(enrollment))).toBeNull();

  runtime.set(runtimeEntry());
  await Promise.resolve();
  expect(attempts).toBe(2);
  expect(routes.capture(managedPreviewServiceId(enrollment))?.route.port).toBe(7133);
  managed.close();
});

function start(f: Fixture) {
  f.endpoint();
  f.runtime.set(runtimeEntry());
  f.managed.enroll(enrollment);
  const route = f.routes.capture(enrollment.serviceId);
  if (!route) throw new Error("Expected enrolled route");
  return route;
}

async function open({ f, attemptId }: { f: Fixture; attemptId: string }) {
  await f.broker.prepare({
    socket: f.socket,
    request: {
      type: "service.preview.prepare.request",
      requestId: `request-${attemptId}`,
      attemptId,
      browserHandle: "shared-browser",
      serviceId: enrollment.serviceId,
      mode: "iframe",
    },
  });
  const response = ServicePreviewPrepareResponseMessageSchema.parse(
    JSON.parse(f.frames.at(-1)!).message,
  );
  const result = response.payload.result;
  if (result.status !== "prepared") throw new Error("Expected prepared reply");
  const credential = f.broker.redeem(result);
  const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
  f.broker.confirm({ bootstrapId: result.bootstrapId, cookieHeader, mode: result.mode });
  return { cookieHeader, serviceId: enrollment.serviceId };
}

it("invalidates managed preview metadata synchronously on registry port removal", () => {
  const runtime = new WorkspaceScriptRuntimeStore();
  const endpoints = new ServiceProxyRouteRegistry();
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  const failures: unknown[] = [];
  const managed = new ManagedPreviewRoutes({
    runtime,
    endpoints,
    qualifyHttp: () => true,
    routes,
    onFailure: (error) => {
      failures.push(error);
    },
  });
  const endpoint = {
    workspaceId: enrollment.workspaceId,
    projectSlug: "react-preview",
    branchName: "main",
    scriptName: enrollment.scriptName,
    port: 5173,
  };
  endpoints.registerWorkspaceService(endpoint);
  runtime.set(runtimeEntry());
  managed.enroll(enrollment);
  const old = routes.capture(enrollment.serviceId);
  expect(old?.isCurrent()).toBe(true);
  const observed: boolean[] = [];
  const stop = endpoints.subscribeWorkspaceServices(() => {
    observed.push(routes.capture(enrollment.serviceId) === null);
  });
  try {
    endpoints.removeRoutesForPort(endpoint.port);
    expect(observed).toEqual([true]);
    expect(old?.isCurrent()).toBe(false);
    expect(routes.capture(enrollment.serviceId)).toBeNull();
    expect(routes.describe()[0].available).toBe(false);
    expect(runtime.get(enrollment)).toEqual(runtimeEntry());
    endpoints.registerWorkspaceService(endpoint);
    expect(routes.capture(enrollment.serviceId)?.isCurrent()).toBe(true);
    expect(old?.isCurrent()).toBe(false);
    expect(failures).toEqual([]);
  } finally {
    stop();
    managed.close();
  }
});

describe("managed preview routes", () => {
  it.each(["endpoint-first", "runtime-first"] as const)(
    "restores stopped policy without starting a service, then follows %s activation and replacement",
    (order) => {
      const f = fixture();
      const stopped = runtimeEntry({ lifecycle: "stopped", exitCode: 0 });
      f.runtime.set(stopped);
      f.managed.restore(enrollment);
      expect(f.runtime.get(enrollment)).toEqual(stopped);
      expect(f.endpoints.getWorkspaceHealthTargets(enrollment.workspaceId)).toEqual([]);
      expect(f.routes.describe()).toEqual([]);
      if (order === "endpoint-first") f.endpoint();
      else f.runtime.set(runtimeEntry());
      expect(f.routes.describe()).toEqual([]);
      if (order === "endpoint-first") f.runtime.set(runtimeEntry());
      else f.endpoint();
      const original = f.routes.capture(enrollment.serviceId);
      expect(original?.isCurrent()).toBe(true);
      expect(original?.route.port).toBe(5173);
      f.runtime.set(runtimeEntry());
      f.endpoint();
      expect(original?.isCurrent()).toBe(true);
      f.runtime.set(runtimeEntry({ terminalId: "replacement-terminal" }));
      expect(original?.isCurrent()).toBe(false);
      const replacement = f.routes.capture(enrollment.serviceId);
      expect(replacement?.isCurrent()).toBe(true);
      f.endpoint({ port: 5180 });
      expect(replacement?.isCurrent()).toBe(false);
      expect(f.routes.capture(enrollment.serviceId)?.route.port).toBe(5180);
      expect(f.failures).toEqual([]);
      f.managed.close();
    },
  );

  it("retains a detached saved enrollment and rejects duplicate inactive identities", () => {
    const f = fixture();
    const saved = { ...enrollment };
    f.managed.restore(saved);
    expect(() => f.managed.restore({ ...enrollment, serviceId: "duplicate-script" })).toThrow(
      "already-enrolled",
    );
    expect(() => f.managed.restore({ ...enrollment, workspaceId: "different-workspace" })).toThrow(
      "already-enrolled",
    );
    saved.workspaceId = "changed-workspace";
    saved.scriptName = "changed-script";
    saved.name = "Changed local copy";
    f.endpoint();
    f.runtime.set(runtimeEntry());
    expect(f.routes.describe()[0]).toMatchObject({
      serviceId: enrollment.serviceId,
      workspaceId: enrollment.workspaceId,
      scriptName: enrollment.scriptName,
      name: enrollment.name,
      available: true,
    });
    f.managed.close();
  });

  it("does not claim a conflicting route inserted before a saved enrollment activates", () => {
    const f = fixture();
    f.managed.restore(enrollment);
    f.routes.register({ serviceId: enrollment.serviceId, port: 6000, mount: "strip" });
    const unrelated = f.routes.capture(enrollment.serviceId);
    f.endpoint();
    expect(() => f.runtime.set(runtimeEntry())).not.toThrow();
    expect(f.failures).toEqual([expect.objectContaining({ code: "route-already-registered" })]);
    expect(unrelated?.isCurrent()).toBe(true);
    expect(f.routes.capture(enrollment.serviceId)?.route.port).toBe(6000);
    f.managed.close();
    expect(unrelated?.isCurrent()).toBe(true);
    expect(f.runtime.get(enrollment)).toEqual(runtimeEntry());
  });

  it("retires an inserted restored route when its first publication fails", () => {
    const f = fixture();
    f.managed.restore(enrollment);
    const original = new Error("restored route observer failed");
    f.routes.subscribe(() => {
      throw original;
    });
    f.endpoint();
    expect(() => f.runtime.set(runtimeEntry())).not.toThrow();
    expect(f.routes.capture(enrollment.serviceId)).toBeNull();
    expect(f.routes.describe()[0].available).toBe(false);
    expect(f.managed.diagnostic).toBe(original);
    expect(f.failures).toEqual([original]);
    expect(f.runtime.get(enrollment)).toEqual(runtimeEntry());
    f.managed.close();
  });

  it.each(["missing-runtime", "plain-script", "stopped-runtime", "missing-endpoint"] as const)(
    "rejects enrollment for %s without publishing a route",
    (state) => {
      const f = fixture();
      if (state !== "missing-endpoint") f.endpoint();
      if (state !== "missing-runtime") {
        f.runtime.set(
          runtimeEntry({
            type: state === "plain-script" ? "script" : "service",
            lifecycle: state === "stopped-runtime" ? "stopped" : "running",
          }),
        );
      }
      expect(() => f.managed.enroll(enrollment)).toThrow("not-running");
      expect(f.routes.describe()).toEqual([]);
    },
  );

  it("derives the endpoint port from its owner and retains an independent enrollment", () => {
    const f = fixture();
    f.endpoint({ port: 5190 });
    f.runtime.set(runtimeEntry());
    const input = { ...enrollment };
    f.managed.enroll(input);
    input.workspaceId = "changed-workspace";
    input.scriptName = "changed-script";
    input.name = "Changed title";
    expect(f.routes.describe()).toEqual([
      {
        serviceId: "atlas",
        workspaceId: "workspace-a",
        scriptName: "web",
        name: "Atlas React",
        port: 5190,
        available: true,
        revision: expect.any(String),
      },
    ]);
    f.runtime.set(runtimeEntry({ lifecycle: "stopped", exitCode: 0 }));
    expect(f.routes.capture("atlas")).toBeNull();
  });

  it("rejects infrastructure endpoints without creating a preview binding", () => {
    const f = fixture();
    f.endpoint({ port: 6767 });
    f.runtime.set(runtimeEntry());
    expect(() => f.managed.enroll(enrollment)).toThrow("infrastructure-port");
    expect(f.routes.describe()).toEqual([]);
  });

  it("isolates a replacement binding on an infrastructure port and recovers once a valid port returns", () => {
    const f = fixture();
    const old = start(f);
    f.endpoint({ workspaceId: "workspace-b", port: 5200 });
    f.runtime.set(runtimeEntry({ workspaceId: "workspace-b", terminalId: "terminal-b" }));
    f.managed.enroll({ ...enrollment, serviceId: "other", workspaceId: "workspace-b" });
    const sibling = f.routes.capture("other");

    f.endpoint({ port: 6767 });
    expect(old.isCurrent()).toBe(false);
    expect(f.routes.capture("atlas")).toBeNull();
    expect(sibling?.isCurrent()).toBe(true);
    expect(f.managed.diagnostic).toBeInstanceOf(PreviewRouteError);
    expect((f.managed.diagnostic as PreviewRouteError).code).toBe("infrastructure-port");

    f.endpoint({ port: 5174 });
    const recovered = f.routes.capture("atlas");
    expect(recovered?.isCurrent()).toBe(true);
    expect(recovered?.route.port).toBe(5174);
    expect(sibling?.isCurrent()).toBe(true);
  });

  it("preserves the current binding across unchanged runtime, endpoint and branch updates", async () => {
    const f = fixture();
    const route = start(f);
    const authority = await open({ f, attemptId: "original-open" });
    const before = await f.broker.run(authority, (job) => job.activationId);
    f.runtime.set(runtimeEntry());
    f.endpoint();
    expect(
      f.endpoints.replaceWorkspaceBranchRoutes({
        workspaceId: "workspace-a",
        newBranch: "renamed",
      }),
    ).toBe(true);
    expect(route.isCurrent()).toBe(true);
    expect(await f.broker.run(authority, (job) => job.activationId)).toBe(before);
    const pending = Symbol("pending");
    expect(await Promise.race([route.invalidated, Promise.resolve(pending)])).toBe(pending);
  });

  it("cancels old work on stop even when the same port restarts and a fresh Open completes", async () => {
    const f = fixture();
    const route = start(f);
    const authority = await open({ f, attemptId: "first-open" });
    const entered = deferred<PreviewAuthorizedJob>();
    const held = deferred<void>();
    const waitHeld = () => held.promise;
    let writes = 0;
    const write = () => {
      writes += 1;
    };
    const oldJob = f.broker
      .run(authority, async (job) => {
        entered.resolve(job);
        await job.wait(waitHeld);
        job.write(write);
      })
      .catch((error: Error) => error.message);
    const captured = await entered.promise;
    f.runtime.set(runtimeEntry({ lifecycle: "stopped", exitCode: 0 }));
    expect(route.isCurrent()).toBe(false);
    expect(f.routes.capture("atlas")).toBeNull();
    expect(() => captured.write(write)).toThrow("authorization-ended");
    f.runtime.set(runtimeEntry({ terminalId: "terminal-b" }));
    await expect(f.broker.run(authority, write)).rejects.toThrow("authorization-ended");
    const fresh = await open({ f, attemptId: "second-open" });
    expect(await oldJob).toBe("authorization-ended");
    const nextActivation = await f.broker.run(fresh, (job) => job.activationId);
    expect(nextActivation).not.toBe(captured.activationId);
    held.resolve();
    await expect(captured.wait(write)).rejects.toThrow("authorization-ended");
    expect(writes).toBe(0);
    expect(route.isCurrent()).toBe(false);
  });

  it.each(["terminal", "port"] as const)(
    "invalidates the old route synchronously on %s replacement before catalog delivery",
    (kind) => {
      const f = fixture();
      const old = start(f);
      const observations: boolean[] = [];
      f.routes.subscribe(() => observations.push(old.isCurrent()));
      if (kind === "terminal") f.runtime.set(runtimeEntry({ terminalId: "terminal-b" }));
      else f.endpoint({ port: 5174 });
      expect(old.isCurrent()).toBe(false);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every((current) => !current)).toBe(true);
      expect(f.routes.capture("atlas")?.route.port).toBe(kind === "port" ? 5174 : 5173);
    },
  );

  it.each(["one-script", "workspace"] as const)(
    "invalidates removed %s runtime immediately",
    (kind) => {
      const f = fixture();
      const old = start(f);
      if (kind === "one-script") f.runtime.remove(enrollment);
      else f.runtime.removeForWorkspace(enrollment.workspaceId);
      expect(old.isCurrent()).toBe(false);
      expect(f.routes.capture("atlas")).toBeNull();
      expect(f.endpoints.getWorkspaceHealthTargets(enrollment.workspaceId)).toHaveLength(1);
    },
  );

  it("treats endpoint removal and re-addition at the same port as a fresh binding", () => {
    const f = fixture();
    const old = start(f);
    f.endpoints.removeWorkspaceService(enrollment);
    expect(old.isCurrent()).toBe(false);
    expect(f.routes.capture("atlas")).toBeNull();
    expect(f.runtime.get(enrollment)?.lifecycle).toBe("running");
    f.endpoint();
    expect(f.routes.capture("atlas")?.isCurrent()).toBe(true);
    expect(old.isCurrent()).toBe(false);
  });

  it("keeps a blocked workspace unavailable through replacement and preserves sibling ownership", () => {
    const f = fixture();
    const old = start(f);
    f.endpoint({ workspaceId: "workspace-b", port: 5200 });
    f.runtime.set(runtimeEntry({ workspaceId: "workspace-b", terminalId: "terminal-b" }));
    f.managed.enroll({ ...enrollment, serviceId: "other", workspaceId: "workspace-b" });
    const sibling = f.routes.capture("other");
    f.managed.blockWorkspace("workspace-a");
    expect(old.isCurrent()).toBe(false);
    f.endpoint({ port: 5174 });
    f.runtime.set(runtimeEntry({ terminalId: "terminal-replaced" }));
    expect(f.routes.capture("atlas")).toBeNull();
    expect(() => f.managed.enroll({ ...enrollment, serviceId: "blocked-new" })).toThrow(
      "unavailable",
    );
    expect(sibling?.isCurrent()).toBe(true);
    expect(f.runtime.get(enrollment)?.lifecycle).toBe("running");
    expect(f.endpoints.getWorkspaceHealthTargets("workspace-a")[0].port).toBe(5174);
    f.managed.unblockWorkspace("workspace-a");
    expect(f.routes.capture("atlas")?.route.port).toBe(5174);
    expect(old.isCurrent()).toBe(false);
    expect(sibling?.isCurrent()).toBe(true);
  });

  it("rejects duplicate service and workspace-script enrollments without disturbing the original", () => {
    const f = fixture();
    const old = start(f);
    expect(() => f.managed.enroll({ ...enrollment, workspaceId: "elsewhere" })).toThrow(
      "already-enrolled",
    );
    expect(() => f.managed.enroll({ ...enrollment, serviceId: "other" })).toThrow(
      "already-enrolled",
    );
    expect(old.isCurrent()).toBe(true);
    expect(f.routes.describe()).toHaveLength(1);
  });

  it("terminalizes every preview and releases observation on close without stopping services", () => {
    const f = fixture();
    const old = start(f);
    const beforeRuntime = f.runtime.get(enrollment);
    const beforeEndpoints = f.endpoints.getWorkspaceHealthTargets("workspace-a");
    f.managed.close();
    expect(old.isCurrent()).toBe(false);
    expect(f.runtime.get(enrollment)).toEqual(beforeRuntime);
    expect(f.endpoints.getWorkspaceHealthTargets("workspace-a")).toEqual(beforeEndpoints);
    const publications: unknown[] = [];
    f.routes.subscribe(() => publications.push(f.routes.describe()));
    f.managed.close();
    f.managed.unblockWorkspace("workspace-a");
    f.runtime.set(runtimeEntry({ terminalId: "terminal-b" }));
    f.endpoint({ port: 5180 });
    expect(publications).toEqual([]);
    expect(f.routes.capture("atlas")).toBeNull();
    expect(() => f.managed.enroll(enrollment)).toThrow("unavailable");
  });

  it.each(["throw", "reject"] as const)(
    "contains observer failure even when diagnostics %s",
    async (mode) => {
      const reportingFailure = new Error("report-failure");
      const f = fixture(() => {
        if (mode === "throw") throw reportingFailure;
        return Promise.reject(reportingFailure);
      });
      const old = start(f);
      f.endpoint({ scriptName: "api", port: 5180 });
      f.runtime.set(runtimeEntry({ scriptName: "api", terminalId: "api-terminal" }));
      f.managed.enroll({ ...enrollment, serviceId: "api", scriptName: "api" });
      const sibling = f.routes.capture("api");
      const original = new Error("catalog-observer-failed");
      f.routes.subscribe(() => {
        throw original;
      });
      expect(() => f.runtime.set(runtimeEntry({ terminalId: "replacement" }))).not.toThrow();
      expect(old.isCurrent()).toBe(false);
      expect(sibling?.isCurrent()).toBe(false);
      expect(f.routes.capture("atlas")).toBeNull();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.failures).toEqual([original]);
      expect(f.managed.diagnostic).toBe(original);
      expect(f.runtime.get(enrollment)?.terminalId).toBe("replacement");
    },
  );

  it("does not leave a live unowned route when enrollment publication fails", async () => {
    const f = fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    const original = new Error("enrollment-observer-failed");
    f.routes.subscribe(() => {
      throw original;
    });
    expect(() => f.managed.enroll(enrollment)).toThrow(original);
    expect(f.routes.capture("atlas")).toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.failures).toEqual([original]);
    expect(f.managed.diagnostic).toBe(original);
  });

  it("invalidates all workspace previews if an observer fails during an archive block", () => {
    const f = fixture();
    const old = start(f);
    f.endpoint({ scriptName: "api", port: 5180 });
    f.runtime.set(runtimeEntry({ scriptName: "api", terminalId: "api-terminal" }));
    f.managed.enroll({ ...enrollment, serviceId: "api", scriptName: "api" });
    const sibling = f.routes.capture("api");
    const original = new Error("archive-observer-failed");
    f.routes.subscribe(() => {
      throw original;
    });
    expect(() => f.managed.blockWorkspace("workspace-a")).not.toThrow();
    expect(old.isCurrent()).toBe(false);
    expect(sibling?.isCurrent()).toBe(false);
    expect(f.routes.capture("api")).toBeNull();
    expect(f.managed.diagnostic).toBe(original);
  });
});
