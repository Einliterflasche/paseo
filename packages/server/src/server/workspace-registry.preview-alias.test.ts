import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";

const archivedAt = "2026-09-19T02:00:00.000Z";
const logger = pino({ level: "silent" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function fixture(options?: ConstructorParameters<typeof FileBackedWorkspaceRegistry>[2]) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-registry-preview-alias-"));
  const file = path.join(home, "workspaces.json");
  const registry = new FileBackedWorkspaceRegistry(file, logger, options);
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-a",
    projectId: "project-a",
    cwd: home,
    kind: "directory",
    displayName: "Workspace",
    labels: ["original"],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
  await registry.upsert(workspace);
  return { file, registry, workspace };
}

function requireRecord(
  record: PersistedWorkspaceRecord | null | undefined,
): PersistedWorkspaceRecord {
  if (!record) throw new Error("Expected workspace record");
  return record;
}

function mutateArchive(record: PersistedWorkspaceRecord) {
  record.archivedAt = archivedAt;
  record.updatedAt = archivedAt;
  if (!record.labels) throw new Error("Expected fixture labels");
  record.labels.push("outside mutation");
}

type Exposure = "get" | "list" | "update-result" | "label-result" | "mutation-payload";

async function exposedRecord(f: Awaited<ReturnType<typeof fixture>>, exposure: Exposure) {
  switch (exposure) {
    case "get":
      return requireRecord(await f.registry.get(f.workspace.workspaceId));
    case "list":
      return requireRecord((await f.registry.list())[0]);
    case "update-result":
      return requireRecord(
        await f.registry.update(f.workspace.workspaceId, (record) => ({
          ...record,
          title: "Updated",
        })),
      );
    case "label-result":
      return f.registry.commitWorkspaceLabelMutation({
        stage: (records) => {
          const record = {
            ...requireRecord(records.get(f.workspace.workspaceId)),
            title: "Staged",
          };
          return { updates: [record], result: record, forcePersist: false };
        },
        beforeWorkspaceWrite: async () => {},
        afterWorkspaceWrite: async () => {},
        afterCommit: () => {},
      });
    case "mutation-payload": {
      const published = deferred<PersistedWorkspaceRecord>();
      const stop = f.registry.subscribeToMutations((mutation) => {
        if (mutation.workspace) published.resolve(mutation.workspace);
      });
      await f.registry.update(f.workspace.workspaceId, (record) => ({
        ...record,
        title: "Published",
      }));
      stop();
      return published.promise;
    }
  }
}

describe("workspace preview committed state isolation", () => {
  it.each(["get", "list", "update-result", "label-result", "mutation-payload"] as const)(
    "does not let an exposed %s record bypass the archive veto",
    async (exposure) => {
      const f = await fixture();
      const record = await exposedRecord(f, exposure);
      const saved = await readFile(f.file, "utf8");
      const expected: PersistedWorkspaceRecord[] = JSON.parse(saved);
      mutateArchive(record);
      expect(await f.registry.list()).toEqual(expected);
      const veto = new Error("preview access revocation failed");
      const observed: string[] = [];
      f.registry.subscribeBeforeUnavailable((workspaceId) => {
        observed.push(workspaceId);
        throw veto;
      });
      await expect(f.registry.upsert(record)).rejects.toMatchObject({ errors: [veto] });
      expect(observed).toEqual([f.workspace.workspaceId]);
      expect(await readFile(f.file, "utf8")).toBe(saved);
      expect(await f.registry.list()).toEqual(expected);
    },
  );

  it("does not expose staged cache values to a before-write hook", async () => {
    const f = await fixture();
    const revoked: string[] = [];
    f.registry.subscribeBeforeUnavailable((id) => {
      revoked.push(id);
    });
    await f.registry.commitWorkspaceLabelMutation({
      stage: (records) => ({
        updates: [{ ...requireRecord(records.get(f.workspace.workspaceId)), title: "Metadata" }],
        result: undefined,
        forcePersist: false,
      }),
      beforeWorkspaceWrite: async (records) => {
        mutateArchive(requireRecord(records[0]));
      },
      afterWorkspaceWrite: async () => {},
      afterCommit: () => {},
    });
    const expected = { ...f.workspace, title: "Metadata" };
    expect(await f.registry.get(f.workspace.workspaceId)).toEqual(expected);
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([expected]);
    expect(revoked).toEqual([]);
  });

  it("retains committed state when a real writer later mutates its received records", async () => {
    let mutateReceived = false;
    const f = await fixture({
      async writeRecords(file, records) {
        await writeJsonFileAtomic(file, records);
        if (mutateReceived) mutateArchive(requireRecord(records[0]));
      },
    });
    mutateReceived = true;
    const returned = await f.registry.update(f.workspace.workspaceId, (record) => ({
      ...record,
      title: "Written",
    }));
    const expected = { ...f.workspace, title: "Written" };
    expect(returned).toEqual(expected);
    expect(await f.registry.get(f.workspace.workspaceId)).toEqual(expected);
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([expected]);
  });

  it("publishes committed availability before a later archive can enter despite delayed metadata delivery", async () => {
    const f = await fixture();
    const deliveryEntered = deferred<void>();
    const deliveryReleased = deferred<void>();
    const archiveEntered = deferred<void>();
    const archiveReleased = deferred<void>();
    const events: string[] = [];
    let available = true;
    f.registry.subscribeAvailabilityCommitted((id, next) => {
      events.push(`commit:${id}:${next}`);
      available = next;
      return undefined;
    });
    f.registry.subscribeBeforeUnavailable(async (id) => {
      available = false;
      events.push(`revoke:${id}`);
      archiveEntered.resolve();
      await archiveReleased.promise;
    });
    f.registry.subscribeToMutations(async (mutation) => {
      if (mutation.kind !== "upsert") return;
      deliveryEntered.resolve();
      await deliveryReleased.promise;
      events.push("metadata-delivered");
    });
    const updating = f.registry.update(f.workspace.workspaceId, (record) => ({
      ...record,
      title: "Earlier metadata",
    }));
    await deliveryEntered.promise;
    const archiving = f.registry.archive(f.workspace.workspaceId, archivedAt);
    await archiveEntered.promise;
    try {
      expect(events).toEqual(["commit:workspace-a:true", "revoke:workspace-a"]);
      expect(available).toBe(false);
      deliveryReleased.resolve();
      await updating;
      expect(events).toEqual([
        "commit:workspace-a:true",
        "revoke:workspace-a",
        "metadata-delivered",
      ]);
      expect(available).toBe(false);
      expect((await f.registry.get(f.workspace.workspaceId))?.archivedAt).toBeNull();
    } finally {
      deliveryReleased.resolve();
      archiveReleased.resolve();
      await archiving;
    }
    expect(events.at(-1)).toBe("commit:workspace-a:false");
    expect((await f.registry.get(f.workspace.workspaceId))?.archivedAt).toBe(archivedAt);
  });

  it("announces committed active, archived and removed states in queue order and permits unsubscribe", async () => {
    const f = await fixture();
    const events: Array<[string, boolean]> = [];
    const stopFailing = f.registry.subscribeAvailabilityCommitted(() => {
      throw new Error("observer diagnostic");
    });
    const stop = f.registry.subscribeAvailabilityCommitted((id, available) => {
      events.push([id, available]);
      return undefined;
    });
    await f.registry.archive(f.workspace.workspaceId, archivedAt);
    await f.registry.upsert(f.workspace);
    await f.registry.remove(f.workspace.workspaceId);
    stop();
    stopFailing();
    await f.registry.upsert(f.workspace);
    expect(events).toEqual([
      [f.workspace.workspaceId, false],
      [f.workspace.workspaceId, true],
      [f.workspace.workspaceId, false],
    ]);
    expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
  });
});
