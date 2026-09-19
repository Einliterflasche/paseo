import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PreviewRegistrationStore, type PreviewExternalInput } from "./registrations.js";

type StorePorts = Pick<
  ConstructorParameters<typeof PreviewRegistrationStore>[0],
  "workspaceExists" | "excludedPorts"
>;

const input: PreviewExternalInput = {
  name: "Atlas",
  port: 5173,
  workspaceId: null,
  mount: "preserve",
};
const saved = {
  ...input,
  serviceId: "external-11111111-1111-4111-8111-111111111111",
  createdAt: "2026-09-18T12:00:00.000Z",
  archivedAt: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function fixture(ports: Partial<StorePorts> = {}) {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-preview-registrations-"));
  const file = path.join(paseoHome, "services", "registrations-v1.json");
  const options = {
    paseoHome,
    workspaceExists: ports.workspaceExists ?? (async () => true),
    excludedPorts: ports.excludedPorts ?? (() => new Set<number>()),
  };
  const store = new PreviewRegistrationStore(options);
  return { store, file, reopen: () => new PreviewRegistrationStore(options) };
}

describe("external preview registration persistence", () => {
  it("serializes duplicate-port claims and retains archived history when that port is reused", async () => {
    const f = await fixture();
    const first = f.store.register(input);
    const duplicate = f.store.register({ ...input, name: "Conflicting page" });
    const rejected = expect(duplicate).rejects.toMatchObject({ code: "already-registered" });
    const created = await first;
    await rejected;
    expect(await f.reopen().list()).toEqual([created]);
    await f.store.archive(created.serviceId);
    const replacement = await f.store.register(input);
    expect(replacement.serviceId).not.toBe(created.serviceId);
    expect(await f.reopen().list()).toEqual([
      { ...created, archivedAt: expect.any(String) },
      replacement,
    ]);
  });

  it.each([
    ["invalid JSON", "{not-json"],
    ["unknown version", JSON.stringify({ version: 2, registrations: [saved] })],
    ["unknown fields", JSON.stringify({ version: 1, registrations: [saved], future: true })],
    ["duplicate IDs", JSON.stringify({ version: 1, registrations: [saved, saved] })],
  ])("preserves %s verbatim across failed reads and mutations", async (_name, content) => {
    const f = await fixture();
    await mkdir(path.dirname(f.file), { recursive: true });
    await writeFile(f.file, content, "utf8");
    await expect(f.store.list()).rejects.toMatchObject({ code: "invalid-store" });
    await expect(f.store.register(input)).rejects.toMatchObject({ code: "invalid-store" });
    await expect(f.store.archive(saved.serviceId)).rejects.toMatchObject({ code: "invalid-store" });
    expect(await readFile(f.file, "utf8")).toBe(content);
  });

  it("serializes concurrent registrations and lets list observe both committed writes", async () => {
    const entered = deferred<void>();
    const release = deferred<boolean>();
    const f = await fixture({
      workspaceExists: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const first = f.store.register({ ...input, workspaceId: "workspace-a" });
    await entered.promise;
    const second = f.store.register({ ...input, name: "Beacon", port: 5174 });
    const listed = f.store.list();
    try {
      await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve(true);
    }
    const created = await Promise.all([first, second]);
    expect(new Set(created.map((entry) => entry.serviceId)).size).toBe(2);
    expect(await listed).toEqual(created);
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({
      version: 1,
      registrations: created,
    });
    expect(await f.reopen().list()).toEqual(created);
  });

  it("returns independent records and snapshots without modifying persisted definitions", async () => {
    const f = await fixture();
    expect(await f.store.list()).toEqual([]);
    await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const created = await f.store.register({ ...input, name: "  Atlas  " });
    expect(created.name).toBe("Atlas");
    expect(created.serviceId).toMatch(/^external-[0-9a-f]{8}-[0-9a-f-]+$/);
    const expected = { ...created };
    created.name = "Changed by caller";
    created.port = 6767;
    const listed = await f.store.list();
    expect(listed).toEqual([expected]);
    listed[0].name = "Changed snapshot";
    listed[0].archivedAt = "2026-09-18T15:00:00.000Z";
    listed.length = 0;
    expect(await f.store.list()).toEqual([expected]);
    expect(await f.reopen().list()).toEqual([expected]);
  });

  it("archives without deleting definitions and preserves the result after reopening", async () => {
    const f = await fixture();
    const first = await f.store.register(input);
    const second = await f.store.register({ ...input, name: "Beacon", port: 5174 });
    await f.store.archive(first.serviceId);
    const archived = await f.store.list();
    expect(archived).toHaveLength(2);
    expect(archived[0]).toEqual({ ...first, archivedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(archived[0].archivedAt!))).toBe(true);
    expect(archived[1]).toEqual(second);
    expect(await f.reopen().list()).toEqual(archived);
    const persisted = await readFile(f.file, "utf8");
    await f.store.archive(first.serviceId);
    await expect(f.store.archive("external-not-found")).rejects.toMatchObject({
      code: "unknown-registration",
    });
    expect(await readFile(f.file, "utf8")).toBe(persisted);
  });

  it("rejects unknown workspaces and currently excluded infrastructure ports before persistence", async () => {
    const ports = new Set([6767]);
    const f = await fixture({
      workspaceExists: async (id) => id === "workspace-a",
      excludedPorts: () => ports,
    });
    await expect(f.store.register({ ...input, workspaceId: "missing" })).rejects.toMatchObject({
      code: "unknown-workspace",
    });
    await expect(f.store.register({ ...input, port: 6767 })).rejects.toMatchObject({
      code: "infrastructure-port",
    });
    expect(await f.store.list()).toEqual([]);
    await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const created = await f.store.register({ ...input, workspaceId: "workspace-a" });
    expect(created.workspaceId).toBe("workspace-a");
    ports.add(5174);
    await expect(f.store.register({ ...input, port: 5174 })).rejects.toMatchObject({
      code: "infrastructure-port",
    });
    expect(await f.store.list()).toEqual([created]);
  });

  it("rechecks excluded ports after asynchronous workspace validation", async () => {
    const entered = deferred<void>();
    const release = deferred<boolean>();
    const ports = new Set<number>();
    const f = await fixture({
      workspaceExists: () => {
        entered.resolve();
        return release.promise;
      },
      excludedPorts: () => ports,
    });
    const creating = f.store.register({ ...input, workspaceId: "workspace-a" });
    const rejected = expect(creating).rejects.toMatchObject({ code: "infrastructure-port" });
    await entered.promise;
    ports.add(input.port);
    release.resolve(true);
    await rejected;
    expect(await f.store.list()).toEqual([]);
    await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid definitions without creating the store file", async () => {
    const f = await fixture();
    expect(() => f.store.register({ ...input, name: "   " })).toThrow();
    for (const port of [0, 65536, 1.5, Number.NaN]) {
      expect(() => f.store.register({ ...input, port })).toThrow();
    }
    const unknownField = { ...input, publicAddress: "https://external.test" };
    expect(() => f.store.register(unknownField)).toThrow();
    expect(await f.store.list()).toEqual([]);
    await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish an unpersisted registration when atomic replacement fails", async () => {
    const f = await fixture();
    expect(await f.store.list()).toEqual([]);
    await mkdir(f.file, { recursive: true });
    await expect(f.store.register(input)).rejects.toThrow();
    expect((await stat(f.file)).isDirectory()).toBe(true);
    expect(await f.store.list()).toEqual([]);
  });
});
