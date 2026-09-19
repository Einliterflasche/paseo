import { QueryClient, QueryObserver, MutationObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { fetchQueryOptions } from "@/data/query";
import {
  createServicesPreferencesStore,
  servicesPreferencesKey,
  servicesPreferenceOutcomeKey,
} from "./preferences-state";
import { MemoryServicesStorage, waitForResult } from "./test-support";

const clients: QueryClient[] = [];
function fixture() {
  const storage = new MemoryServicesStorage();
  const client = new QueryClient();
  clients.push(client);
  const preferences = createServicesPreferencesStore(storage);
  const scope = { serverId: "host" };
  const read = (target = scope) => fetchQueryOptions(preferences.readOptions(target));
  const writer = (target = scope) =>
    new MutationObserver(client, {
      ...preferences.writeOptions(target, client),
      gcTime: 0,
    });
  return { storage, client, preferences, scope, read, writer };
}
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
});

describe("Services view preferences", () => {
  it("isolates host and workspace choices without writing during reads", async () => {
    const { storage, client, preferences } = fixture();
    const host = { serverId: "host/one" };
    const workspace = { serverId: "host/one", workspaceId: "workspace:null" };
    const other = { serverId: "host", workspaceId: "one/workspace:null" };
    storage.data.set(servicesPreferencesKey(host), '{"view":"list"}');
    const values = await Promise.all(
      [host, workspace, other].map((scope) =>
        client.fetchQuery(fetchQueryOptions(preferences.readOptions(scope))),
      ),
    );
    expect(values).toEqual([{ view: "list" }, { view: "grid" }, { view: "grid" }]);
    expect(storage.writes).toEqual([]);
    expect(storage.removals).toEqual([]);
  });

  it.each(['{"view":"carousel","otherField":"preserve"}', "broken json"])(
    "retains unreadable data %s and recovers after explicit reload",
    async (raw) => {
      const { storage, client, scope, read } = fixture();
      const key = servicesPreferencesKey(scope);
      storage.data.set(key, raw);
      await expect(client.fetchQuery(read())).rejects.toThrow();
      expect(storage.data.get(key)).toBe(raw);
      expect(storage.writes).toEqual([]);
      expect(storage.removals).toEqual([]);
      storage.data.set(key, '{"view":"list"}');
      expect(await client.fetchQuery(read())).toEqual({ view: "list" });
    },
  );

  it("serializes writes from two surfaces and publishes only committed values", async () => {
    const { storage, client, scope, read, writer } = fixture();
    await client.fetchQuery(read());
    const held = storage.holdNextWrite();
    const first = writer();
    const second = writer();
    const firstSave = first.mutate("list");
    await held.started.promise;
    const secondSave = second.mutate("grid");
    await waitForResult(second, (result) => result.isPaused);
    expect(storage.writes).toEqual([
      { key: servicesPreferencesKey(scope), value: '{"view":"list"}' },
    ]);
    expect(client.getQueryData([servicesPreferencesKey(scope)])).toEqual({ view: "grid" });
    held.release.resolve();
    await Promise.all([firstSave, secondSave]);
    expect(storage.writes.map((write) => write.value)).toEqual([
      '{"view":"list"}',
      '{"view":"grid"}',
    ]);
    expect(storage.data.get(servicesPreferencesKey(scope))).toBe('{"view":"grid"}');
    expect(client.getQueryData([servicesPreferencesKey(scope)])).toEqual({ view: "grid" });
  });

  it("does not replay a failed save and shares successful recovery across surfaces", async () => {
    const { storage, client, scope, read, writer } = fixture();
    await client.fetchQuery(read());
    storage.writeError = new Error("Storage unavailable");
    await expect(writer().mutate("list")).rejects.toThrow("Storage unavailable");
    expect(client.getQueryData(servicesPreferenceOutcomeKey(scope))).toBe("failed");
    expect(client.getQueryData([servicesPreferencesKey(scope)])).toEqual({ view: "grid" });
    expect(storage.writes).toHaveLength(1);
    storage.writeError = null;
    await writer().mutate("list");
    expect(client.getQueryData(servicesPreferenceOutcomeKey(scope))).toBe("saved");
    expect(client.getQueryData([servicesPreferencesKey(scope)])).toEqual({ view: "list" });
    expect(storage.writes).toHaveLength(2);
  });

  it("finishes an old-host write without changing the newly selected host", async () => {
    const { storage, client, read, writer } = fixture();
    const observer = new QueryObserver(client, read({ serverId: "old" }));
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    const held = storage.holdNextWrite();
    const save = writer({ serverId: "old" }).mutate("list");
    await held.started.promise;
    observer.setOptions(read({ serverId: "new" }));
    await observer.refetch();
    held.release.resolve();
    await save;
    expect(observer.getCurrentResult().data).toEqual({ view: "grid" });
    expect(storage.data.get(servicesPreferencesKey({ serverId: "old" }))).toBe('{"view":"list"}');
    expect(storage.data.has(servicesPreferencesKey({ serverId: "new" }))).toBe(false);
    unsubscribe();
  });

  it("prevents a second surface's late read from replacing a committed choice", async () => {
    const { storage, client, read, writer } = fixture();
    await client.fetchQuery(read());
    const heldWrite = storage.holdNextWrite();
    const save = writer().mutate("list");
    await heldWrite.started.promise;
    const heldRead = storage.holdNextRead();
    const second = new QueryObserver(client, read());
    const unsubscribe = second.subscribe(() => {});
    await heldRead.started.promise;
    const pendingRead = second.refetch({ cancelRefetch: false });
    heldWrite.release.resolve();
    await save;
    heldRead.result.resolve('{"view":"grid"}');
    await pendingRead;
    expect(second.getCurrentResult().data).toEqual({ view: "list" });
    expect(client.getQueryData(read().queryKey)).toEqual({ view: "list" });
    unsubscribe();
  });

  it("keeps recovered status after the successful writer unmounts and is garbage-collected", async () => {
    const { storage, client, scope, writer } = fixture();
    const first = writer();
    const second = writer();
    storage.writeError = new Error("Storage unavailable");
    await expect(first.mutate("list")).rejects.toThrow("Storage unavailable");
    storage.writeError = null;
    await second.mutate("list");
    const removed = new Promise<void>((resolve) => {
      const unsubscribe = client.getMutationCache().subscribe((event) => {
        if (event.type === "removed" && event.mutation.state.status === "success") {
          unsubscribe();
          resolve();
        }
      });
    });
    // reset detaches the successful observer; real GC runs with gcTime=0.
    second.reset();
    await removed;
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.status),
    ).toEqual(["error"]);
    expect(client.getQueryData(servicesPreferenceOutcomeKey(scope))).toBe("saved");
    expect(client.getQueryData([servicesPreferencesKey(scope)])).toEqual({ view: "list" });
  });
});
