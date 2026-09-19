import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createServiceProxySubsystem } from "../service-proxy.js";
import {
  WorkspaceScriptRuntimeStore,
  type ScriptRuntimeEntry,
} from "../workspace-script-runtime-store.js";
import { ManagedPreviewServices } from "./managed-services.js";
import { ManagedPreviewRoutes } from "./managed.js";
import type { PreviewManagedServicePolicy } from "./policy.js";
import { PreviewRoutes } from "./routes.js";

const declaration: PreviewManagedServicePolicy = {
  workspaceId: "workspace-a",
  scriptName: "web",
  name: "Atlas React",
  mount: "preserve",
};
// enable() always derives the display name from the script name, distinct from the policy's name.
const enabledEntry = { ...declaration, name: declaration.scriptName };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runtimeEntry(overrides: Partial<ScriptRuntimeEntry> = {}): ScriptRuntimeEntry {
  return {
    workspaceId: declaration.workspaceId,
    scriptName: declaration.scriptName,
    type: "service",
    lifecycle: "running",
    terminalId: "terminal-a",
    exitCode: null,
    ...overrides,
  };
}

async function fixture(
  options: {
    policy?: readonly PreviewManagedServicePolicy[];
    validateService?: (input: { workspaceId: string; scriptName: string }) => Promise<void>;
  } = {},
) {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-services-"));
  const file = path.join(paseoHome, "services", "managed-enrollments-v1.json");
  const runtime = new WorkspaceScriptRuntimeStore();
  const endpoints = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
  const routes = new PreviewRoutes({ excludedPorts: [] });
  const managedFailures: unknown[] = [];
  const managed = new ManagedPreviewRoutes({
    runtime,
    endpoints,
    routes,
    onFailure(error) {
      managedFailures.push(error);
    },
  });
  const blocked = new Set<string>();
  const validations: unknown[] = [];
  let validateImpl: (input: { workspaceId: string; scriptName: string }) => Promise<void> =
    options.validateService ?? (async () => {});
  function endpoint(input: { workspaceId?: string; scriptName?: string; port?: number } = {}) {
    const workspaceId = input.workspaceId ?? declaration.workspaceId;
    return endpoints.registerWorkspaceService({
      workspaceId,
      projectSlug: "react-preview",
      branchName: workspaceId,
      scriptName: input.scriptName ?? declaration.scriptName,
      port: input.port ?? 5173,
    });
  }
  const services = await ManagedPreviewServices.open({
    paseoHome,
    policy: options.policy ?? [],
    managed,
    isWorkspaceBlocked: (workspaceId) => blocked.has(workspaceId),
    async validateService(input) {
      validations.push(input);
      await validateImpl(input);
    },
  });
  return {
    paseoHome,
    file,
    runtime,
    endpoints,
    endpoint,
    routes,
    managed,
    managedFailures,
    services,
    blocked,
    validations,
    setValidate(impl: (input: { workspaceId: string; scriptName: string }) => Promise<void>) {
      validateImpl = impl;
    },
    reopen: (policy: readonly PreviewManagedServicePolicy[] = options.policy ?? []) =>
      ManagedPreviewServices.open({
        paseoHome,
        policy,
        managed,
        isWorkspaceBlocked: (workspaceId) => blocked.has(workspaceId),
        async validateService(input) {
          await validateImpl(input);
        },
      }),
  };
}

const noop = () => {};

describe("managed preview enrollment persistence", () => {
  it("enables a stopped service, persists it, and leaves the workspace without a live route until the script runs", async () => {
    const f = await fixture();
    const serviceId = await f.services.enable(
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        mount: "preserve",
      },
      noop,
    );
    expect(f.validations).toEqual([
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        name: declaration.scriptName,
        mount: "preserve",
        enabled: true,
      },
    ]);
    expect(f.services.describe()).toEqual([{ ...enabledEntry, enabled: true, serviceId }]);
    expect(f.routes.describe()).toEqual([]);
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved).toEqual({ version: 1, enrollments: [{ ...enabledEntry, enabled: true }] });
    f.endpoint();
    f.runtime.set(runtimeEntry());
    const route = f.routes.capture(serviceId);
    expect(route?.isCurrent()).toBe(true);
    expect(route?.route.port).toBe(5173);
  });

  it("throws already-enabled for a concurrent duplicate and for enabling an already-enabled service, without disturbing the original", async () => {
    const f = await fixture();
    const input = {
      workspaceId: declaration.workspaceId,
      scriptName: declaration.scriptName,
      mount: "preserve" as const,
    };
    const first = f.services.enable(input, noop);
    expect(() => f.services.enable(input, noop)).toThrow("already-enabled");
    const serviceId = await first;
    expect(() => f.services.enable(input, noop)).toThrow("already-enabled");
    expect(f.services.describe()).toEqual([{ ...enabledEntry, enabled: true, serviceId }]);
  });

  it("disable leaves the runtime service running, revokes the previous route immediately, and persists disabled", async () => {
    const f = await fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    const serviceId = await f.services.enable(
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        mount: "preserve",
      },
      noop,
    );
    const before = f.routes.capture(serviceId);
    expect(before?.isCurrent()).toBe(true);
    await f.services.disable(
      { workspaceId: declaration.workspaceId, scriptName: declaration.scriptName },
      noop,
    );
    expect(before?.isCurrent()).toBe(false);
    expect(f.routes.capture(serviceId)).toBeNull();
    expect(f.runtime.get(declaration)).toEqual(runtimeEntry());
    expect(f.services.describe()).toEqual([{ ...enabledEntry, enabled: false, serviceId }]);
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved).toEqual({ version: 1, enrollments: [{ ...enabledEntry, enabled: false }] });
  });

  it("reenables the same workspace/script identity with a fresh route after a disable", async () => {
    const f = await fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    const input = {
      workspaceId: declaration.workspaceId,
      scriptName: declaration.scriptName,
      mount: "preserve" as const,
    };
    const serviceId = await f.services.enable(input, noop);
    const original = f.routes.capture(serviceId);
    await f.services.disable(
      { workspaceId: declaration.workspaceId, scriptName: declaration.scriptName },
      noop,
    );
    const reenabledId = await f.services.enable(input, noop);
    expect(reenabledId).toBe(serviceId);
    const reenabled = f.routes.capture(serviceId);
    expect(original?.isCurrent()).toBe(false);
    expect(reenabled?.isCurrent()).toBe(true);
    expect(reenabled).not.toBe(original);
  });

  it("merges a disabled store override onto a policy declaration and skips restoring a dormant workspace", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-services-"));
    const file = path.join(paseoHome, "services", "managed-enrollments-v1.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, enrollments: [{ ...declaration, enabled: false }] }),
    );
    const runtime = new WorkspaceScriptRuntimeStore();
    const endpoints = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const managed = new ManagedPreviewRoutes({ runtime, endpoints, routes, onFailure() {} });
    const blocked = new Set<string>([declaration.workspaceId]);
    const services = await ManagedPreviewServices.open({
      paseoHome,
      policy: [declaration],
      managed,
      isWorkspaceBlocked: (workspaceId) => blocked.has(workspaceId),
      async validateService() {},
    });
    expect(services.describe()).toEqual([
      { ...declaration, enabled: false, serviceId: services.describe()[0].serviceId },
    ]);
    const serviceId = services.describe()[0].serviceId;
    services.restoreWorkspace(declaration.workspaceId);
    expect(routes.describe()).toEqual([]);
    expect(routes.capture(serviceId)).toBeNull();
  });

  it("persists only the explicit decision beside a policy default, drops the default on reload once removed from policy, and still persists an explicit Disable of a policy default", async () => {
    const other: PreviewManagedServicePolicy = {
      workspaceId: "workspace-b",
      scriptName: "api",
      name: "Other",
      mount: "preserve",
    };
    const otherEnabledEntry = { ...other, name: other.scriptName };
    const f = await fixture({ policy: [declaration] });

    // Explicitly enabling an unrelated service must not promote the untouched
    // policy default (A) into a permanent stored override.
    const otherServiceId = await f.services.enable(
      { workspaceId: other.workspaceId, scriptName: other.scriptName, mount: other.mount },
      noop,
    );
    const savedAfterEnable = JSON.parse(await readFile(f.file, "utf8"));
    expect(savedAfterEnable).toEqual({
      version: 1,
      enrollments: [{ ...otherEnabledEntry, enabled: true }],
    });

    // Reloading with the policy default removed must keep the explicit decision
    // (B) and must not resurrect the never-decided default (A).
    const reopened = await f.reopen([]);
    expect(reopened.describe()).toEqual([
      { ...otherEnabledEntry, enabled: true, serviceId: otherServiceId },
    ]);

    // An explicit Disable of a policy default that was never previously decided
    // must still persist its own override, same as before this fix.
    const declarationServiceId = await f.services.disable(
      { workspaceId: declaration.workspaceId, scriptName: declaration.scriptName },
      noop,
    );
    const savedAfterDisable = JSON.parse(await readFile(f.file, "utf8"));
    expect(savedAfterDisable.enrollments).toEqual(
      expect.arrayContaining([
        { ...otherEnabledEntry, enabled: true },
        { ...declaration, enabled: false },
      ]),
    );
    expect(savedAfterDisable.enrollments).toHaveLength(2);
    const reopenedAfterDisable = await f.reopen([]);
    expect(reopenedAfterDisable.describe()).toEqual(
      expect.arrayContaining([
        { ...otherEnabledEntry, enabled: true, serviceId: otherServiceId },
        { ...declaration, enabled: false, serviceId: declarationServiceId },
      ]),
    );
  });

  it("rejects a malformed managed-enrollments file with invalid-store and leaves it untouched", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-services-"));
    const file = path.join(paseoHome, "services", "managed-enrollments-v1.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json");
    const runtime = new WorkspaceScriptRuntimeStore();
    const endpoints = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
    const routes = new PreviewRoutes({ excludedPorts: [] });
    const managed = new ManagedPreviewRoutes({ runtime, endpoints, routes, onFailure() {} });
    await expect(
      ManagedPreviewServices.open({
        paseoHome,
        policy: [],
        managed,
        isWorkspaceBlocked: () => false,
        async validateService() {},
      }),
    ).rejects.toMatchObject({ code: "invalid-store" });
    expect(await readFile(file, "utf8")).toBe("not json");
  });

  it("refuses activation when the workspace is blocked mid-validation, without persisting or installing a route", async () => {
    const f = await fixture();
    const held = deferred<void>();
    f.setValidate(() => held.promise);
    const pending = f.services.enable(
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        mount: "preserve",
      },
      noop,
    );
    f.blocked.add(declaration.workspaceId);
    held.resolve();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(f.services.describe()).toEqual([]);
    await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets a pending Disable overtake a held Enable so the final persisted and routed state is disabled", async () => {
    const f = await fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    const held = deferred<void>();
    f.setValidate(() => held.promise);
    const enabling = f.services.enable(
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        mount: "preserve",
      },
      noop,
    );
    const disabling = f.services.disable(
      { workspaceId: declaration.workspaceId, scriptName: declaration.scriptName },
      noop,
    );
    held.resolve();
    await expect(enabling).rejects.toMatchObject({ code: "unavailable" });
    const serviceId = await disabling;
    expect(f.services.describe()).toEqual([{ ...enabledEntry, enabled: false, serviceId }]);
    expect(f.routes.capture(serviceId)).toBeNull();
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved).toEqual({ version: 1, enrollments: [{ ...enabledEntry, enabled: false }] });
  });

  it("checks currentness again after a route-publication reentrant Disable, converging on the disabled write", async () => {
    const f = await fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    let reentered = false;
    let reentrantDisable: Promise<string> | null = null;
    const stop = f.routes.subscribe(() => {
      // Guard must latch before the nested call returns: archive() re-publishes
      // synchronously from inside disable() itself, before this assignment runs.
      if (reentered) return;
      reentered = true;
      reentrantDisable = f.services.disable(
        { workspaceId: declaration.workspaceId, scriptName: declaration.scriptName },
        noop,
      );
    });
    const enabling = f.services.enable(
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        mount: "preserve",
      },
      noop,
    );
    await expect(enabling).rejects.toMatchObject({ code: "unavailable" });
    expect(reentrantDisable).not.toBeNull();
    const serviceId = await reentrantDisable!;
    stop();
    expect(f.routes.capture(serviceId)).toBeNull();
    expect(f.services.describe()).toEqual([{ ...enabledEntry, enabled: false, serviceId }]);
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved).toEqual({ version: 1, enrollments: [{ ...enabledEntry, enabled: false }] });
  });

  it("keeps a committed enrollment visible when the source detaches right after the write, but withholds route activation", async () => {
    const f = await fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    let current = true;
    const assertCurrent = () => {
      if (!current) throw new Error("source-detached");
    };
    const snapshots: unknown[] = [];
    const stop = f.services.subscribe(() => {
      snapshots.push(f.services.describe());
      // The source detaches at the exact moment the write commits.
      current = false;
    });
    const enabling = f.services.enable(
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        mount: "preserve",
      },
      assertCurrent,
    );
    await expect(enabling).rejects.toThrow("source-detached");
    stop();
    expect(snapshots).toHaveLength(1);
    const [committed] = snapshots[0] as Array<{ serviceId: string }>;
    expect(snapshots[0]).toEqual([
      { ...enabledEntry, enabled: true, serviceId: committed.serviceId },
    ]);
    expect(f.services.describe()).toEqual(snapshots[0]);
    expect(f.routes.describe()).toEqual([]);
    expect(f.routes.capture(committed.serviceId)).toBeNull();
  });

  it("permanently revisions a pending Enable across an archive block, so a later restore before release still rejects it", async () => {
    const f = await fixture();
    f.endpoint();
    f.runtime.set(runtimeEntry());
    const held = deferred<void>();
    f.setValidate(() => held.promise);
    const enabling = f.services.enable(
      {
        workspaceId: declaration.workspaceId,
        scriptName: declaration.scriptName,
        mount: "preserve",
      },
      noop,
    );
    f.services.blockWorkspace(declaration.workspaceId);
    f.managed.unblockWorkspace(declaration.workspaceId);
    // The workspace comes back before Enable ever releases; the entry is not
    // yet enabled, so this restore is a no-op for it.
    f.services.restoreWorkspace(declaration.workspaceId);
    held.resolve();
    await expect(enabling).rejects.toMatchObject({ code: "unavailable" });
    expect(f.services.describe()).toEqual([]);
    await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drains an accepted Disable write on shutdown and surfaces a real storage failure", async () => {
    const f = await fixture({ policy: [declaration] });
    await mkdir(path.dirname(f.file), { recursive: true });
    await chmod(path.dirname(f.file), 0o500);
    try {
      const disabling = f.services
        .disable({ workspaceId: declaration.workspaceId, scriptName: declaration.scriptName }, noop)
        .catch((error: unknown) => error);
      await expect(f.services.shutdown()).rejects.toBeInstanceOf(AggregateError);
      const disableOutcome = await disabling;
      expect(disableOutcome).toMatchObject({ code: "storage-error" });
    } finally {
      await chmod(path.dirname(f.file), 0o700);
    }
  });
});
