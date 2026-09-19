import { mkdtemp, mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExternalPreviewServices } from "./external.js";
import { PreviewBroker } from "./broker.js";
import { PreviewRegistrationStore, type PreviewExternalInput } from "./registrations.js";
import { PreviewRoutes } from "./routes.js";
import { PreviewSources } from "./sources.js";

const input: PreviewExternalInput = {
  name: "External React",
  port: 5173,
  workspaceId: "workspace-a",
  mount: "preserve",
};

// These owner tests use an explicitly trusted local caller; socket tests exercise source checks.
function trustedCaller() {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function fixture() {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-preview-external-"));
  const file = path.join(paseoHome, "services", "registrations-v1.json");
  const workspaces = new Set(["workspace-a"]);
  const excludedPorts = new Set([6767]);
  let held: {
    entered: ReturnType<typeof deferred<void>>;
    result: ReturnType<typeof deferred<boolean>>;
  } | null = null;
  const options = {
    paseoHome,
    async workspaceExists(workspaceId: string) {
      const pending = held;
      held = null;
      if (pending) {
        pending.entered.resolve();
        return pending.result.promise;
      }
      return workspaces.has(workspaceId);
    },
    excludedPorts: () => excludedPorts,
  };
  const store = new PreviewRegistrationStore(options);
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  return {
    store,
    routes,
    file,
    workspaces,
    excludedPorts,
    open: () => ExternalPreviewServices.open({ store, routes }),
    reopenStore: () => new PreviewRegistrationStore(options),
    holdNextValidation() {
      const next = { entered: deferred<void>(), result: deferred<boolean>() };
      held = next;
      return next;
    },
  };
}

async function expectPending(work: Promise<unknown>) {
  // Give a wrongly early result a full turn to settle before racing the original promise.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sentinel = Symbol("pending shutdown");
  expect(await Promise.race([work, Promise.resolve(sentinel)])).toBe(sentinel);
}

function ignoreRejection() {}

async function queuedDisconnect(
  f: Awaited<ReturnType<typeof fixture>>,
  owner: ExternalPreviewServices,
  serviceId: string,
) {
  const held = f.holdNextValidation();
  const connecting = owner.connect({ serviceId, assertCurrent: trustedCaller });
  void connecting.catch(ignoreRejection);
  await held.entered.promise;
  const disconnecting = owner.disconnect(serviceId);
  void disconnecting.catch(ignoreRejection);
  return { held, connecting, disconnecting };
}

describe("external preview route ownership", () => {
  it("publishes persisted and newly registered definitions unavailable until explicit Connect", async () => {
    const f = await fixture();
    const existing = await f.store.register(input);
    const publishedAvailability: boolean[] = [];
    f.routes.subscribe(() => {
      let available = false;
      for (const route of f.routes.describe()) available ||= route.available;
      publishedAvailability.push(available);
    });
    const owner = await f.open();
    expect(f.routes.capture(existing.serviceId)).toBeNull();
    expect(f.routes.describe()).toEqual([
      {
        serviceId: existing.serviceId,
        name: existing.name,
        port: existing.port,
        workspaceId: existing.workspaceId,
        scriptName: null,
        kind: "external",
        available: false,
        revision: expect.any(String),
      },
    ]);
    const created = await owner.register({
      input: { ...input, name: "Second page", port: 5174 },
      assertCurrent: trustedCaller,
    });
    expect(f.routes.capture(created.serviceId)).toBeNull();
    expect(f.routes.describe().map((route) => route.available)).toEqual([false, false]);
    expect(publishedAvailability).toEqual([false, false]);
    await owner.connect({ serviceId: created.serviceId, assertCurrent: trustedCaller });
    const connected = f.routes.capture(created.serviceId);
    expect(connected?.route.port).toBe(5174);
    expect(f.routes.capture(existing.serviceId)).toBeNull();
    await owner.connect({ serviceId: created.serviceId, assertCurrent: trustedCaller });
    expect(connected?.isCurrent()).toBe(false);
    expect(f.routes.capture(created.serviceId)?.isCurrent()).toBe(true);
    owner.close();
  });

  it("opens healthy definitions alongside stale workspace and infrastructure definitions", async () => {
    const f = await fixture();
    const staleWorkspace = await f.store.register(input);
    const stalePort = await f.store.register({ ...input, workspaceId: null, port: 5174 });
    const healthy = await f.store.register({ ...input, workspaceId: null, port: 5175 });
    f.workspaces.clear();
    f.excludedPorts.add(stalePort.port);
    const routes = new PreviewRoutes({ excludedPorts: [6767, stalePort.port] });
    const owner = await ExternalPreviewServices.open({ store: f.reopenStore(), routes });
    expect(routes.describe().map((route) => route.available)).toEqual([false, false, false]);
    await expect(
      owner.connect({ serviceId: staleWorkspace.serviceId, assertCurrent: trustedCaller }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });
    await expect(
      owner.connect({ serviceId: stalePort.serviceId, assertCurrent: trustedCaller }),
    ).rejects.toMatchObject({ code: "infrastructure-port" });
    await owner.connect({ serviceId: healthy.serviceId, assertCurrent: trustedCaller });
    expect(routes.capture(healthy.serviceId)?.isCurrent()).toBe(true);
    await owner.disconnect(staleWorkspace.serviceId);
    await owner.disconnect(stalePort.serviceId);
    expect(routes.describe().map((route) => route.serviceId)).toEqual([healthy.serviceId]);
    expect(await f.reopenStore().list()).toEqual([
      { ...staleWorkspace, archivedAt: expect.any(String) },
      { ...stalePort, archivedAt: expect.any(String) },
      healthy,
    ]);
    owner.close();
  });

  it("leaves an unrelated colliding route active when initialization rolls back acquired IDs", async () => {
    const f = await fixture();
    const first = await f.store.register(input);
    const collision = await f.store.register({ ...input, port: 5174 });
    f.routes.register({ serviceId: collision.serviceId, port: 6000, mount: "strip" });
    const unrelated = f.routes.capture(collision.serviceId);
    await expect(f.open()).rejects.toMatchObject({ code: "route-already-registered" });
    expect(unrelated?.isCurrent()).toBe(true);
    expect(f.routes.capture(collision.serviceId)?.route.port).toBe(6000);
    expect(f.routes.capture(first.serviceId)).toBeNull();
    expect(
      f.routes.describe().find((route) => route.serviceId === first.serviceId)?.available,
    ).toBe(false);
  });

  it("requires a fresh Connect after reopening persisted definitions", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const old = f.routes.capture(entry.serviceId);
    owner.close();
    const nextRoutes = new PreviewRoutes({ excludedPorts: [6767] });
    const replacement = await ExternalPreviewServices.open({
      store: f.reopenStore(),
      routes: nextRoutes,
    });
    expect(old?.isCurrent()).toBe(false);
    expect(nextRoutes.capture(entry.serviceId)).toBeNull();
    await replacement.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    expect(nextRoutes.capture(entry.serviceId)?.isCurrent()).toBe(true);
    expect(old?.isCurrent()).toBe(false);
    replacement.close();
  });

  it("revokes synchronously when Disconnect overtakes a held Connect and retains the archived definition", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const old = f.routes.capture(entry.serviceId);
    const held = f.holdNextValidation();
    const connecting = owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const rejected = expect(connecting).rejects.toMatchObject({ code: "unknown-registration" });
    await held.entered.promise;
    const disconnecting = owner.disconnect(entry.serviceId);
    expect(old?.isCurrent()).toBe(false);
    expect(f.routes.capture(entry.serviceId)).toBeNull();
    held.result.resolve(true);
    await rejected;
    await disconnecting;
    expect(f.routes.describe()).toEqual([]);
    const retained = await f.reopenStore().list();
    expect(retained).toEqual([{ ...entry, archivedAt: expect.any(String) }]);
    const saved = await readFile(f.file, "utf8");
    await owner.disconnect(entry.serviceId);
    expect(await readFile(f.file, "utf8")).toBe(saved);
    await expect(
      owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller }),
    ).rejects.toMatchObject({
      code: "unknown-registration",
    });
    owner.close();
  });

  it("does not persist a held registration after Close before its commit guard", async () => {
    const f = await fixture();
    const owner = await f.open();
    const held = f.holdNextValidation();
    const registering = owner.register({ input, assertCurrent: trustedCaller });
    const rejected = expect(registering).rejects.toMatchObject({ code: "closed" });
    await held.entered.promise;
    owner.close();
    held.result.resolve(true);
    await rejected;
    expect(await f.reopenStore().list()).toEqual([]);
    expect(f.routes.describe()).toEqual([]);
  });

  it.each(["register", "connect"] as const)(
    "rechecks the caller after held validation before %s can commit",
    async (operation) => {
      const f = await fixture();
      const owner = await f.open();
      const entry =
        operation === "connect"
          ? await owner.register({ input, assertCurrent: trustedCaller })
          : null;
      let current = true;
      const assertCurrent = () => {
        if (!current) throw new Error("source-invalidated");
      };
      const held = f.holdNextValidation();
      const pending = entry
        ? owner.connect({ serviceId: entry.serviceId, assertCurrent })
        : owner.register({ input, assertCurrent });
      const rejected = expect(pending).rejects.toThrow("source-invalidated");
      await held.entered.promise;
      current = false;
      held.result.resolve(true);
      await rejected;
      expect(await f.reopenStore().list()).toEqual(entry ? [entry] : []);
      expect(f.routes.describe().every((route) => !route.available)).toBe(true);
      owner.close();
    },
  );

  it("keeps failed archival disconnected and allows an explicit persistence retry", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const old = f.routes.capture(entry.serviceId);
    const backup = `${f.file}.retained-before-failure`;
    await rename(f.file, backup);
    await mkdir(f.file);
    const disconnecting = owner.disconnect(entry.serviceId);
    expect(old?.isCurrent()).toBe(false);
    await expect(disconnecting).rejects.toMatchObject({ code: "storage-error" });
    expect(f.routes.capture(entry.serviceId)).toBeNull();
    await expect(
      owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller }),
    ).rejects.toMatchObject({
      code: "unknown-registration",
    });
    expect(await f.store.list()).toEqual([entry]);
    await rename(f.file, `${f.file}.retained-obstruction`);
    await rename(backup, f.file);
    await owner.disconnect(entry.serviceId);
    expect(f.routes.describe()).toEqual([]);
    expect(await f.reopenStore().list()).toEqual([{ ...entry, archivedAt: expect.any(String) }]);
    owner.close();
  });

  it.each(["workspace", "infrastructure"] as const)(
    "revokes a connected route when current %s eligibility is lost",
    async (kind) => {
      const f = await fixture();
      const owner = await f.open();
      const entry = await owner.register({ input, assertCurrent: trustedCaller });
      await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
      const old = f.routes.capture(entry.serviceId);
      if (kind === "workspace") f.workspaces.delete("workspace-a");
      else f.excludedPorts.add(input.port);
      await expect(
        owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller }),
      ).rejects.toMatchObject({
        code: kind === "workspace" ? "unknown-workspace" : "infrastructure-port",
      });
      expect(f.routes.capture(entry.serviceId)).toBeNull();
      expect(old?.isCurrent()).toBe(false);
      expect(await f.reopenStore().list()).toEqual([entry]);
      owner.close();
    },
  );

  it("rejects a route conflict that appears while Connect validation is held", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const old = f.routes.capture(entry.serviceId);
    const held = f.holdNextValidation();
    const connecting = owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const rejected = expect(connecting).rejects.toMatchObject({ code: "already-registered" });
    await held.entered.promise;
    f.routes.register({ serviceId: "managed-page", port: input.port, mount: "preserve" });
    held.result.resolve(true);
    await rejected;
    expect(f.routes.capture(entry.serviceId)).toBeNull();
    expect(f.routes.capture("managed-page")?.isCurrent()).toBe(true);
    expect(old?.isCurrent()).toBe(false);
    owner.close();
    expect(f.routes.capture("managed-page")?.isCurrent()).toBe(true);
  });

  it("rejects duplicate ports and allows a new definition after explicit archival", async () => {
    const f = await fixture();
    const owner = await f.open();
    const first = await owner.register({ input, assertCurrent: trustedCaller });
    await expect(
      owner.register({ input: { ...input, name: "Duplicate page" }, assertCurrent: trustedCaller }),
    ).rejects.toMatchObject({
      code: "already-registered",
    });
    expect(await f.store.list()).toEqual([first]);
    await owner.disconnect(first.serviceId);
    const replacement = await owner.register({ input, assertCurrent: trustedCaller });
    expect(replacement.serviceId).not.toBe(first.serviceId);
    expect(f.routes.capture(replacement.serviceId)).toBeNull();
    expect((await f.store.list()).map((entry) => entry.serviceId)).toEqual([
      first.serviceId,
      replacement.serviceId,
    ]);
    owner.close();
  });

  it("invalidates every owned route despite a failing close observer", async () => {
    const f = await fixture();
    const owner = await f.open();
    const first = await owner.register({ input, assertCurrent: trustedCaller });
    const second = await owner.register({
      input: { ...input, name: "Second", port: 5174 },
      assertCurrent: trustedCaller,
    });
    await owner.connect({ serviceId: first.serviceId, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: second.serviceId, assertCurrent: trustedCaller });
    const firstCapture = f.routes.capture(first.serviceId);
    const secondCapture = f.routes.capture(second.serviceId);
    f.routes.subscribe(() => {
      throw new Error("catalog observer failed");
    });
    expect(() => owner.close()).toThrow("External preview shutdown failed");
    expect(firstCapture?.isCurrent()).toBe(false);
    expect(secondCapture?.isCurrent()).toBe(false);
    expect(() => owner.close()).not.toThrow();
  });

  it("does not retain an activated route when Connect publication throws", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    const original = new Error("connect observer failed");
    const stop = f.routes.subscribe(() => {
      throw original;
    });
    await expect(
      owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller }),
    ).rejects.toThrow(original);
    expect(f.routes.capture(entry.serviceId)).toBeNull();
    stop();
    owner.close();
  });
});

describe("external preview shutdown drain", () => {
  it("reserves Disconnect archival before an invalidation subscriber starts shutdown", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const capture = f.routes.capture(entry.serviceId);
    // Hold the real store queue independently of the owner's queue. This makes
    // archival pending without placing an earlier owner operation before Close.
    const held = f.holdNextValidation();
    const storeWrite = f.store.register({ ...input, port: 5174 });
    await held.entered.promise;
    const state: { started: boolean; closing: Promise<void> | null } = {
      started: false,
      closing: null,
    };
    const stop = f.routes.subscribe(() => {
      if (state.started) return;
      state.started = true;
      state.closing = owner.shutdown();
      void state.closing.catch(ignoreRejection);
    });
    const disconnecting = owner.disconnect(entry.serviceId);
    void disconnecting.catch(ignoreRejection);
    try {
      expect(capture?.isCurrent()).toBe(false);
      expect(state.started).toBe(true);
      const closing = state.closing;
      if (!closing) throw new Error("invalidation did not initiate shutdown");
      await expectPending(closing);
      expect(await f.reopenStore().list()).toEqual([entry]);
    } finally {
      stop();
      held.result.resolve(true);
      await storeWrite;
      await disconnecting;
      await state.closing;
    }
    expect(await f.reopenStore().list()).toEqual([
      { ...entry, archivedAt: expect.any(String) },
      expect.objectContaining({ port: 5174, archivedAt: null }),
    ]);
  });

  it("waits for accepted Disconnect archival while revoking synchronously and denying later writes", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const capture = f.routes.capture(entry.serviceId);
    const pending = await queuedDisconnect(f, owner, entry.serviceId);
    const closing = owner.shutdown();
    const concurrentClosing = owner.shutdown();
    try {
      expect(capture?.isCurrent()).toBe(false);
      expect(f.routes.capture(entry.serviceId)).toBeNull();
      await expectPending(closing);
      await expectPending(concurrentClosing);
    } finally {
      pending.held.result.resolve(true);
    }
    await expect(pending.connecting).rejects.toMatchObject({ code: "closed" });
    await pending.disconnecting;
    await closing;
    await concurrentClosing;
    expect(f.routes.describe()).toEqual([]);
    expect(await f.reopenStore().list()).toEqual([{ ...entry, archivedAt: expect.any(String) }]);
    const saved = await readFile(f.file, "utf8");
    await expect(
      owner.register({ input: { ...input, port: 5174 }, assertCurrent: trustedCaller }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller }),
    ).rejects.toMatchObject({ code: "closed" });
    expect(() => owner.disconnect(entry.serviceId)).toThrow("closed");
    expect(await readFile(f.file, "utf8")).toBe(saved);
  });

  it("waits for a held precommit Register refusal without treating ordinary closure as failed persistence", async () => {
    const f = await fixture();
    const owner = await f.open();
    const held = f.holdNextValidation();
    const registering = owner.register({ input, assertCurrent: trustedCaller });
    void registering.catch(ignoreRejection);
    await held.entered.promise;
    const closing = owner.shutdown();
    try {
      await expectPending(closing);
    } finally {
      held.result.resolve(true);
    }
    await expect(registering).rejects.toMatchObject({ code: "closed" });
    await expect(closing).resolves.toBeUndefined();
    expect(await f.reopenStore().list()).toEqual([]);
    expect(f.routes.describe()).toEqual([]);
    await expect(readFile(f.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports failed accepted archival after shutdown and retains the persisted definition", async () => {
    const f = await fixture();
    const owner = await f.open();
    const entry = await owner.register({ input, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
    const retained = `${f.file}.retained-before-shutdown`;
    const saved = await readFile(f.file, "utf8");
    await rename(f.file, retained);
    await mkdir(f.file);
    const pending = await queuedDisconnect(f, owner, entry.serviceId);
    const closing = owner.shutdown();
    void closing.catch(ignoreRejection);
    try {
      await expectPending(closing);
    } finally {
      pending.held.result.resolve(true);
    }
    await expect(pending.connecting).rejects.toMatchObject({ code: "closed" });
    await expect(pending.disconnecting).rejects.toMatchObject({ code: "storage-error" });
    await expect(closing).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.objectContaining({ code: "storage-error" })],
    });
    expect(await readFile(retained, "utf8")).toBe(saved);
    expect(await f.store.list()).toEqual([entry]);
    expect(f.routes.capture(entry.serviceId)).toBeNull();
    await expect(owner.shutdown()).rejects.toThrow("External preview shutdown failed");
  });

  it("still drains an accepted archive when synchronous route invalidation reports a failure", async () => {
    const f = await fixture();
    const owner = await f.open();
    const first = await owner.register({ input, assertCurrent: trustedCaller });
    const second = await owner.register({
      input: { ...input, port: 5174 },
      assertCurrent: trustedCaller,
    });
    await owner.connect({ serviceId: first.serviceId, assertCurrent: trustedCaller });
    await owner.connect({ serviceId: second.serviceId, assertCurrent: trustedCaller });
    const capture = f.routes.capture(second.serviceId);
    const pending = await queuedDisconnect(f, owner, first.serviceId);
    const original = new Error("shutdown observer failed");
    const stop = f.routes.subscribe(() => {
      throw original;
    });
    const closing = owner.shutdown();
    void closing.catch(ignoreRejection);
    stop();
    try {
      expect(capture?.isCurrent()).toBe(false);
      await expectPending(closing);
    } finally {
      pending.held.result.resolve(true);
    }
    await expect(pending.connecting).rejects.toMatchObject({ code: "closed" });
    await pending.disconnecting;
    await expect(closing).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: expect.arrayContaining([original]) })],
    });
    expect(await f.reopenStore().list()).toEqual([
      { ...first, archivedAt: expect.any(String) },
      second,
    ]);
  });

  it.each([false, true])(
    "the broker drains accepted writes when its catalog observer fails=%s",
    async (failObserver) => {
      const f = await fixture();
      const owner = await f.open();
      const entry = await owner.register({ input, assertCurrent: trustedCaller });
      await owner.connect({ serviceId: entry.serviceId, assertCurrent: trustedCaller });
      const sources = new PreviewSources("https://control.test");
      const broker = new PreviewBroker({
        sources,
        routes: f.routes,
        externalServices: owner,
        onFailure: ignoreRejection,
      });
      const pending = await queuedDisconnect(f, owner, entry.serviceId);
      const original = new Error("broker shutdown observer failed");
      if (failObserver) {
        broker.subscribeCatalog(() => {
          throw original;
        });
      }
      const closing = broker.shutdown();
      void closing.catch(ignoreRejection);
      try {
        expect(broker.isClosed).toBe(true);
        await expectPending(closing);
      } finally {
        pending.held.result.resolve(true);
        sources.close();
      }
      await expect(pending.connecting).rejects.toMatchObject({ code: "closed" });
      await pending.disconnecting;
      if (failObserver) await expect(closing).rejects.toMatchObject({ errors: [original] });
      else await expect(closing).resolves.toBeUndefined();
      expect(await f.reopenStore().list()).toEqual([{ ...entry, archivedAt: expect.any(String) }]);
    },
  );
});
