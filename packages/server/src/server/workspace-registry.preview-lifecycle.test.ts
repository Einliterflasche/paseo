import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
  type WorkspaceMutation,
} from "./workspace-registry.js";

const archivedAt = "2026-09-19T01:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-workspace-preview-lifecycle-"));
  const file = path.join(home, "workspaces.json");
  const registry = new FileBackedWorkspaceRegistry(file, pino({ level: "silent" }));
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-a",
    projectId: "project-a",
    cwd: path.join(home, "project"),
    kind: "directory",
    displayName: "React workspace",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
  await registry.upsert(workspace);
  const saved = await readFile(file, "utf8");
  const mutations: WorkspaceMutation[] = [];
  registry.subscribeToMutations((mutation) => {
    mutations.push(mutation);
  });
  return { file, registry, workspace, saved, mutations };
}

type MutationKind = "archive" | "remove" | "update" | "upsert" | "label-batch";

function makeUnavailable({
  registry,
  workspace,
  kind,
  events,
}: {
  registry: FileBackedWorkspaceRegistry;
  workspace: PersistedWorkspaceRecord;
  kind: MutationKind;
  events: string[];
}): Promise<unknown> {
  const archived = { ...workspace, archivedAt, updatedAt: archivedAt };
  switch (kind) {
    case "archive":
      return registry.archive(workspace.workspaceId, archivedAt);
    case "remove":
      return registry.remove(workspace.workspaceId);
    case "update":
      return registry.update(workspace.workspaceId, (record) => ({
        ...record,
        archivedAt,
        updatedAt: archivedAt,
      }));
    case "upsert":
      return registry.upsert(archived);
    case "label-batch":
      return registry.commitWorkspaceLabelMutation({
        stage: () => ({ updates: [archived], result: "archived", forcePersist: false }),
        beforeWorkspaceWrite: async () => {
          events.push("before-label-write");
        },
        afterWorkspaceWrite: async () => {
          events.push("after-label-write");
        },
        afterCommit: () => {
          events.push("label-committed");
        },
      });
  }
}

describe("workspace preview pre-unavailability observation", () => {
  it.each(["archive", "remove", "update", "upsert", "label-batch"] as const)(
    "awaits access revocation before %s becomes durable or visible",
    async (kind) => {
      const f = await fixture();
      const entered = deferred<void>();
      const held = deferred<void>();
      const events: string[] = [];
      f.registry.subscribeBeforeUnavailable(async (workspaceId) => {
        events.push(`revoke:${workspaceId}`);
        entered.resolve();
        await held.promise;
        events.push("revocation-settled");
      });
      const mutation = makeUnavailable({ ...f, kind, events });
      await entered.promise;
      try {
        expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
        expect(await readFile(f.file, "utf8")).toBe(f.saved);
        expect(f.mutations).toEqual([]);
        expect(events).toEqual(["revoke:workspace-a"]);
      } finally {
        held.resolve();
      }
      await mutation;
      const expected =
        kind === "remove" ? null : { ...f.workspace, archivedAt, updatedAt: archivedAt };
      expect(await f.registry.get(f.workspace.workspaceId)).toEqual(expected);
      const persisted: unknown = JSON.parse(await readFile(f.file, "utf8"));
      expect(persisted).toEqual(expected ? [expected] : []);
      expect(f.mutations).toHaveLength(1);
      expect(events.slice(0, 2)).toEqual(["revoke:workspace-a", "revocation-settled"]);
      if (kind === "label-batch") {
        expect(events.slice(2)).toEqual([
          "before-label-write",
          "after-label-write",
          "label-committed",
        ]);
      }
    },
  );

  it.each(["throw", "reject"] as const)(
    "notifies all listeners after a %s failure and preserves cache and disk",
    async (mode) => {
      const f = await fixture();
      const original = new Error("preview revocation failed");
      const calls: string[] = [];
      f.registry.subscribeBeforeUnavailable(() => {
        calls.push("failing-listener");
        if (mode === "throw") throw original;
        return Promise.reject(original);
      });
      f.registry.subscribeBeforeUnavailable((workspaceId) => {
        calls.push(`other-listener:${workspaceId}`);
      });
      await expect(f.registry.archive(f.workspace.workspaceId, archivedAt)).rejects.toMatchObject({
        name: "AggregateError",
        errors: [original],
      });
      expect(calls).toEqual(["failing-listener", "other-listener:workspace-a"]);
      expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
      expect(await readFile(f.file, "utf8")).toBe(f.saved);
      expect(f.mutations).toEqual([]);
    },
  );

  it("does not notify preview revocation for ordinary metadata updates", async () => {
    const f = await fixture();
    const calls: string[] = [];
    f.registry.subscribeBeforeUnavailable((workspaceId) => {
      calls.push(workspaceId);
    });
    await f.registry.update(f.workspace.workspaceId, (record) => ({ ...record, title: "Renamed" }));
    const renamed = await f.registry.get(f.workspace.workspaceId);
    if (!renamed) throw new Error("Expected active workspace");
    await f.registry.upsert({ ...renamed, pinnedAt: archivedAt });
    await f.registry.commitWorkspaceLabelMutation({
      stage: (records) => {
        const current = records.get(f.workspace.workspaceId);
        if (!current) throw new Error("Expected active workspace");
        return {
          updates: [{ ...current, labels: ["label-a"] }],
          result: undefined,
          forcePersist: false,
        };
      },
      beforeWorkspaceWrite: async () => {},
      afterWorkspaceWrite: async () => {},
      afterCommit: () => {},
    });
    expect(calls).toEqual([]);
    expect(await f.registry.get(f.workspace.workspaceId)).toMatchObject({
      title: "Renamed",
      pinnedAt: archivedAt,
      labels: ["label-a"],
      archivedAt: null,
    });
    expect(f.mutations).toHaveLength(3);
  });

  it("does not re-revoke already unavailable or absent workspaces and releases listeners", async () => {
    const f = await fixture();
    const calls: string[] = [];
    const stop = f.registry.subscribeBeforeUnavailable((workspaceId) => {
      calls.push(workspaceId);
    });
    await f.registry.archive(f.workspace.workspaceId, archivedAt);
    await f.registry.archive(f.workspace.workspaceId, "2026-09-19T02:00:00.000Z");
    await f.registry.remove(f.workspace.workspaceId);
    await f.registry.remove("missing");
    expect(calls).toEqual([f.workspace.workspaceId]);
    await f.registry.upsert(f.workspace);
    stop();
    await f.registry.archive(f.workspace.workspaceId, archivedAt);
    expect(calls).toEqual([f.workspace.workspaceId]);
  });

  it("serializes a later metadata change behind held revocation without losing either update", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const held = deferred<void>();
    f.registry.subscribeBeforeUnavailable(async () => {
      entered.resolve();
      await held.promise;
    });
    const archiving = f.registry.archive(f.workspace.workspaceId, archivedAt);
    await entered.promise;
    const renaming = f.registry.update(f.workspace.workspaceId, (record) => ({
      ...record,
      title: "Later title",
    }));
    try {
      expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
      expect(await readFile(f.file, "utf8")).toBe(f.saved);
    } finally {
      held.resolve();
    }
    await archiving;
    await renaming;
    const expected = { ...f.workspace, archivedAt, updatedAt: archivedAt, title: "Later title" };
    expect(await f.registry.get(f.workspace.workspaceId)).toEqual(expected);
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([expected]);
  });

  it.each(["update", "label-batch"] as const)(
    "does not let an in-place %s bypass precommit revocation or publish failed state",
    async (kind) => {
      const f = await fixture();
      const original = new Error("revocation veto");
      const calls: string[] = [];
      f.registry.subscribeBeforeUnavailable((workspaceId) => {
        calls.push(workspaceId);
        throw original;
      });
      const archiveRecord = (record: PersistedWorkspaceRecord) => {
        record.archivedAt = archivedAt;
        record.updatedAt = archivedAt;
        return record;
      };
      const updating =
        kind === "update"
          ? f.registry.update(f.workspace.workspaceId, archiveRecord)
          : f.registry.commitWorkspaceLabelMutation({
              stage: (records) => {
                const record = records.get(f.workspace.workspaceId);
                if (!record) throw new Error("Expected active workspace");
                return { updates: [archiveRecord(record)], result: undefined, forcePersist: false };
              },
              beforeWorkspaceWrite: async () => {},
              afterWorkspaceWrite: async () => {},
              afterCommit: () => {},
            });
      await expect(updating).rejects.toMatchObject({ errors: [original] });
      expect(calls).toEqual([f.workspace.workspaceId]);
      expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
      expect(await readFile(f.file, "utf8")).toBe(f.saved);
      expect(f.mutations).toEqual([]);
    },
  );
});
