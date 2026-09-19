import { QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceManagedResponseMessage } from "@getpaseo/protocol/messages";
import {
  managedActionKey,
  managedErrorKey,
  runManagedAction,
  type ManagedActionInput,
  type ManagedActionState,
  type ManagedRuntime,
} from "./managed-actions";
import type { ServiceCatalogEntry } from "./catalog";
import { deferred } from "./test-support";

type ManagedResult = ServiceManagedResponseMessage["payload"]["result"];

const clients: QueryClient[] = [];

const entry: ServiceCatalogEntry = {
  id: '["host","workspace-a","web"]',
  workspaceId: "workspace-a",
  workspaceName: "Workspace A",
  projectName: "Atlas",
  scriptName: "web",
  port: 5173,
  lifecycle: "running",
  health: null,
  exitCode: null,
  terminalId: "terminal-a",
};

function enrollmentFor(enabled: boolean) {
  return {
    serviceId: "managed-atlas",
    workspaceId: entry.workspaceId,
    scriptName: entry.scriptName,
    name: entry.scriptName,
    mount: "preserve" as const,
    enabled,
  };
}

function fixture(
  options: {
    capturedOnline?: boolean;
    managedRegistration?: false;
    initialEnrollment?: ReturnType<typeof enrollmentFor> | undefined;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 3, gcTime: 0 } } });
  clients.push(client);
  interface ManagedRequestInput {
    workspaceId: string;
    scriptName: string;
    mount?: "preserve" | "strip";
  }
  interface Call {
    action: "enable" | "disable";
    input: ManagedRequestInput;
  }
  const calls: Call[] = [];
  const started = deferred<void>();
  const enableResult = deferred<{ result: ManagedResult }>();
  const disableResult = deferred<{ result: ManagedResult }>();
  let enrollments = options.initialEnrollment ? [options.initialEnrollment] : [];
  const managedClient = {
    getLastServerInfoMessage: () => ({
      servicePreviews: {
        version: 1 as const,
        origin: "https://control.test",
        ...(options.managedRegistration === false ? {} : { managedRegistration: 1 as const }),
        managedEnrollments: enrollments,
        services: [],
      },
    }),
    enableManagedServicePreview(input: ManagedRequestInput) {
      calls.push({ action: "enable", input });
      started.resolve();
      return enableResult.promise;
    },
    disableManagedServicePreview(input: ManagedRequestInput) {
      calls.push({ action: "disable", input });
      started.resolve();
      return disableResult.promise;
    },
  };
  let snapshot: ManagedRuntime | null = {
    connectionStatus: options.capturedOnline === false ? "offline" : "online",
    clientGeneration: 1,
    connectionEpoch: 1,
    client: managedClient,
  };
  const getSnapshot = () => snapshot;
  const baseOptions: ManagedActionInput = {
    client,
    serverId: "host",
    entry,
    action: "enable",
    mount: "preserve",
    getSnapshot,
  };
  const state = (target = entry) =>
    client.getQueryData<ManagedActionState>(managedActionKey("host", target));
  const observer = (target = entry) =>
    new QueryObserver<ManagedActionState>(client, {
      queryKey: managedActionKey("host", target),
      queryFn: skipToken,
      gcTime: Infinity,
    });
  function setEnrollment(next: ReturnType<typeof enrollmentFor> | null) {
    enrollments = next ? [next] : [];
  }
  function reconnect(patch: Partial<ManagedRuntime>) {
    snapshot = snapshot ? { ...snapshot, ...patch } : null;
  }
  function disconnect() {
    snapshot = null;
  }
  return {
    client,
    calls,
    started,
    enableResult,
    disableResult,
    options: baseOptions,
    state,
    observer,
    setEnrollment,
    reconnect,
    disconnect,
  };
}

function nextRemoval(client: QueryClient) {
  return new Promise<void>((resolve) => {
    const unsubscribe = client.getMutationCache().subscribe((event) => {
      if (event.type === "removed") {
        unsubscribe();
        resolve();
      }
    });
  });
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe("managed action ownership", () => {
  it("reserves synchronously against double and reentrant requests for the same host/service", async () => {
    const f = fixture();
    const reentrant: Promise<boolean>[] = [];
    const unsubscribe = f.client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && f.state()?.status === "pending") {
        reentrant.push(runManagedAction({ ...f.options, action: "enable" }));
      }
    });
    const first = runManagedAction({ ...f.options, action: "enable" });
    expect(f.state()).toEqual({ status: "pending", action: "enable" });
    await runManagedAction({
      ...f.options,
      entry: { ...entry, workspaceName: "Changed label" },
      action: "enable",
    });
    await f.started.promise;
    expect(reentrant).toHaveLength(1);
    await Promise.all(reentrant);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].action).toBe("enable");
    unsubscribe();
    f.enableResult.resolve({ result: { status: "ok", serviceId: "managed-atlas" } });
    expect(await first).toBe(true);
    expect(f.state()).toEqual({ status: "success", serviceId: "managed-atlas" });
  });

  it("keeps pending ownership when a card observer unmounts and a replacement mounts", async () => {
    const f = fixture();
    const first = f.observer();
    const unsubscribe = first.subscribe(() => {});
    const action = runManagedAction({ ...f.options, action: "enable" });
    await f.started.promise;
    unsubscribe();
    first.destroy();
    const second = f.observer();
    const stopSecond = second.subscribe(() => {});
    expect(second.getCurrentResult().data).toEqual({ status: "pending", action: "enable" });
    await runManagedAction({ ...f.options, action: "enable" });
    expect(f.calls).toHaveLength(1);
    f.enableResult.resolve({ result: { status: "ok", serviceId: "managed-atlas" } });
    await action;
    expect(second.getCurrentResult().data).toEqual({
      status: "success",
      serviceId: "managed-atlas",
    });
    stopSecond();
    second.destroy();
  });

  it.each(["known", "unknown"] as const)(
    "retains a %s error after unmount and actual mutation garbage collection, without automatic retry",
    async (kind) => {
      const f = fixture();
      const observer = f.observer();
      const unsubscribe = observer.subscribe(() => {});
      const removed = nextRemoval(f.client);
      const action = runManagedAction({ ...f.options, action: "enable" });
      await f.started.promise;
      unsubscribe();
      observer.destroy();
      if (kind === "known")
        f.enableResult.resolve({ result: { status: "error", code: "storage-error" } });
      else f.enableResult.reject(new Error("Fixture transport unavailable"));
      await action;
      await removed;
      expect(f.client.getMutationCache().getAll()).toEqual([]);
      expect(f.calls).toHaveLength(1);
      const replacement = f.observer();
      const stop = replacement.subscribe(() => {});
      expect(replacement.getCurrentResult().data).toEqual({
        status: "error",
        code: kind === "known" ? "storage-error" : "connection-ended",
      });
      stop();
      replacement.destroy();
    },
  );

  it("publishes a fresh explicit recovery without resurrecting a garbage-collected old failure", async () => {
    const f = fixture();
    const failedRemoval = nextRemoval(f.client);
    const failing = runManagedAction({ ...f.options, action: "enable" });
    await f.started.promise;
    f.enableResult.reject(new Error("Fixture transport unavailable"));
    await failing;
    await failedRemoval;
    expect(f.state()).toEqual({ status: "error", code: "connection-ended" });
    f.setEnrollment(enrollmentFor(true));
    const successRemoval = nextRemoval(f.client);
    const recovering = runManagedAction({ ...f.options, action: "disable" });
    f.disableResult.resolve({ result: { status: "ok", serviceId: "managed-atlas" } });
    await recovering;
    await successRemoval;
    expect(f.calls.at(-1)?.action).toBe("disable");
    expect(f.state()).toEqual({ status: "success", serviceId: "managed-atlas" });
    expect(f.client.getMutationCache().getAll()).toEqual([]);
  });

  it("reports connection-ended when the source changes while a reply is in flight, even if the reply says ok", async () => {
    const f = fixture();
    const action = runManagedAction({ ...f.options, action: "enable" });
    await f.started.promise;
    f.reconnect({ connectionEpoch: 2 });
    f.enableResult.resolve({ result: { status: "ok", serviceId: "managed-atlas" } });
    expect(await action).toBe(false);
    expect(f.state()).toEqual({ status: "error", code: "connection-ended" });
  });

  it("reports connection-ended when the connection drops entirely while a reply is in flight", async () => {
    const f = fixture();
    const action = runManagedAction({ ...f.options, action: "enable" });
    await f.started.promise;
    f.disconnect();
    f.enableResult.resolve({ result: { status: "ok", serviceId: "managed-atlas" } });
    expect(await action).toBe(false);
    expect(f.state()).toEqual({ status: "error", code: "connection-ended" });
  });

  it.each([
    {
      name: "an already-enabled enrollment",
      init: { initialEnrollment: enrollmentFor(true) },
      action: "enable" as const,
      code: "already-enabled",
    },
    {
      name: "a disable with no enabled enrollment",
      init: {},
      action: "disable" as const,
      code: "unknown-service",
    },
    {
      name: "a feature that is not registered on the current source",
      init: { managedRegistration: false as const },
      action: "enable" as const,
      code: "unavailable",
    },
    {
      name: "a captured snapshot that was not online",
      init: { capturedOnline: false },
      action: "enable" as const,
      code: "unavailable",
    },
  ])("refuses $name without sending a request", async ({ init, action, code }) => {
    const f = fixture(init);
    const outcome = await runManagedAction({ ...f.options, action });
    expect(outcome).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.state()).toEqual({ status: "error", code });
  });
});

describe("managed error keys", () => {
  it("maps every wire and local failure code to a distinct translation key", () => {
    const codes = [
      "unavailable",
      "restarting",
      "unknown-service",
      "already-enabled",
      "invalid-input",
      "storage-error",
      "connection-ended",
    ] as const;
    const keys = codes.map((code) => managedErrorKey(code));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
