import { QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { externalActionKey, runExternalAction, type ExternalActionState } from "./external-actions";
import {
  ExternalServiceActionError,
  type ExternalCatalogEntry,
  type createExternalCatalogOperations,
} from "./external-catalog";
import { deferred } from "./test-support";

const clients: QueryClient[] = [];
const entry: ExternalCatalogEntry = {
  kind: "external",
  id: '["host","external-a"]',
  serverId: "host",
  serviceId: "external-a",
  name: "Atlas",
  port: 5173,
  workspaceId: null,
  workspaceName: null,
  available: false,
  revision: "revision-1",
};
type Operations = ReturnType<typeof createExternalCatalogOperations>;
type Call = Parameters<Operations["run"]>[0];

function fixture() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 3, gcTime: 0 } } });
  clients.push(client);
  const calls: Call[] = [];
  const started = deferred<void>();
  const result = deferred<void>();
  const operations: Operations = {
    register() {
      throw new Error("This fixture accepts lifecycle operations only");
    },
    run(call) {
      calls.push(call);
      started.resolve();
      return result.promise;
    },
  };
  const options = { client, operations, entry, rendered: null };
  const state = (target = entry) =>
    client.getQueryData<ExternalActionState>(externalActionKey(target));
  const observer = (target = entry) =>
    new QueryObserver<ExternalActionState>(client, {
      queryKey: externalActionKey(target),
      queryFn: skipToken,
      gcTime: Infinity,
    });
  return { client, calls, started, result, options, state, observer };
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

describe("external action ownership", () => {
  it("reserves synchronously against double and reentrant requests for the same host/service", async () => {
    const f = fixture();
    const reentrant: Promise<void>[] = [];
    const unsubscribe = f.client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && f.state()?.status === "pending") {
        reentrant.push(runExternalAction({ ...f.options, action: "disconnect" }));
      }
    });
    const first = runExternalAction({ ...f.options, action: "connect" });
    expect(f.state()).toEqual({ status: "pending", action: "connect" });
    await runExternalAction({
      ...f.options,
      entry: { ...entry, name: "Changed label" },
      action: "connect",
    });
    await f.started.promise;
    expect(reentrant).toHaveLength(1);
    await Promise.all(reentrant);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].action).toBe("connect");
    unsubscribe();
    f.result.resolve();
    await first;
    expect(f.state()).toEqual({ status: "success" });
  });

  it("keeps pending ownership when a card observer unmounts and a replacement mounts", async () => {
    const f = fixture();
    const first = f.observer();
    const unsubscribe = first.subscribe(() => {});
    const action = runExternalAction({ ...f.options, action: "connect" });
    await f.started.promise;
    unsubscribe();
    first.destroy();
    const second = f.observer();
    const stopSecond = second.subscribe(() => {});
    expect(second.getCurrentResult().data).toEqual({ status: "pending", action: "connect" });
    await runExternalAction({ ...f.options, action: "connect" });
    expect(f.calls).toHaveLength(1);
    f.result.resolve();
    await action;
    expect(second.getCurrentResult().data).toEqual({ status: "success" });
    stopSecond();
    second.destroy();
  });

  it("lets distinct hosts and services progress without sharing reservations or outcomes", async () => {
    const f = fixture();
    const otherService = { ...entry, serviceId: "external-b" };
    const otherHost = { ...entry, serverId: "another-host" };
    const pending = [entry, otherService, otherHost].map((target) =>
      runExternalAction({ ...f.options, entry: target, action: "connect" }),
    );
    await f.started.promise;
    expect(f.calls.map((call) => [call.entry.serverId, call.entry.serviceId])).toEqual([
      ["host", "external-a"],
      ["host", "external-b"],
      ["another-host", "external-a"],
    ]);
    for (const target of [entry, otherService, otherHost])
      expect(f.state(target)).toEqual({ status: "pending", action: "connect" });
    f.result.resolve();
    await Promise.all(pending);
    for (const target of [entry, otherService, otherHost])
      expect(f.state(target)).toEqual({ status: "success" });
  });

  it.each(["known", "unknown"] as const)(
    "retains a %s error after unmount and actual mutation garbage collection, without automatic retry",
    async (kind) => {
      const f = fixture();
      const observer = f.observer();
      const unsubscribe = observer.subscribe(() => {});
      const removed = nextRemoval(f.client);
      const action = runExternalAction({ ...f.options, action: "connect" });
      await f.started.promise;
      unsubscribe();
      observer.destroy();
      f.result.reject(
        kind === "known"
          ? new ExternalServiceActionError("unknown-workspace")
          : new Error("Fixture transport unavailable"),
      );
      await action;
      await removed;
      expect(f.client.getMutationCache().getAll()).toEqual([]);
      expect(f.calls).toHaveLength(1);
      const replacement = f.observer();
      const stop = replacement.subscribe(() => {});
      expect(replacement.getCurrentResult().data).toEqual({
        status: "error",
        code: kind === "known" ? "unknown-workspace" : "connection-ended",
      });
      stop();
      replacement.destroy();
    },
  );

  it("publishes a fresh explicit recovery without resurrecting a garbage-collected old failure", async () => {
    const f = fixture();
    const failedRemoval = nextRemoval(f.client);
    const failing = runExternalAction({ ...f.options, action: "connect" });
    await f.started.promise;
    f.result.reject(new ExternalServiceActionError("storage-error"));
    await failing;
    await failedRemoval;
    expect(f.state()).toEqual({ status: "error", code: "storage-error" });
    const recoveredCalls: Call[] = [];
    const recovery: Operations = {
      ...f.options.operations,
      async run(call) {
        recoveredCalls.push(call);
      },
    };
    const successRemoval = nextRemoval(f.client);
    await runExternalAction({ ...f.options, operations: recovery, action: "disconnect" });
    await successRemoval;
    expect(recoveredCalls).toHaveLength(1);
    expect(recoveredCalls[0].action).toBe("disconnect");
    expect(f.state()).toEqual({ status: "success" });
    expect(f.client.getMutationCache().getAll()).toEqual([]);
  });
});
