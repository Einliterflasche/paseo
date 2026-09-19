import { describe, expect, it } from "vitest";
import { createPreviewBrowserOwner, type PreviewBrowserIdentity } from "./preview-browser-owner";
import {
  createPreviewCoordinator,
  type PreparedPreview,
  type PreviewClientPort,
  type PreviewClientSource,
} from "./preview-coordinator";
import { createPreviewProfile, type PreviewProfilePort } from "./preview-profile";
import { deferred } from "./test-support";

const HANDLE = "11111111-1111-4111-8111-111111111111";

class MemoryProfile implements PreviewProfilePort {
  value: string | null = HANDLE;
  read(): string | null {
    return this.value;
  }
  write(next: string): void {
    this.value = next;
  }
  createId(): string {
    return HANDLE;
  }
  lock<T>(work: () => T): Promise<T> {
    return Promise.resolve(work());
  }
}

class MemoryClient implements PreviewClientPort {
  readonly prepares: Array<{
    input: Parameters<PreviewClientPort["prepareServicePreview"]>[0];
    reply: ReturnType<
      typeof deferred<Awaited<ReturnType<PreviewClientPort["prepareServicePreview"]>>>
    >;
  }> = [];
  readonly closes: Array<{
    attemptId: string;
    reply: ReturnType<
      typeof deferred<Awaited<ReturnType<PreviewClientPort["closeServicePreview"]>>>
    >;
  }> = [];

  prepareServicePreview(input: Parameters<PreviewClientPort["prepareServicePreview"]>[0]) {
    const reply = deferred<Awaited<ReturnType<PreviewClientPort["prepareServicePreview"]>>>();
    this.prepares.push({ input, reply });
    return reply.promise;
  }

  closeServicePreview(input: { attemptId: string }) {
    const reply = deferred<Awaited<ReturnType<PreviewClientPort["closeServicePreview"]>>>();
    this.closes.push({ attemptId: input.attemptId, reply });
    return reply.promise;
  }
}

interface CreatedEntry {
  identity: PreviewBrowserIdentity;
  client: MemoryClient;
  coordinator: ReturnType<typeof createPreviewCoordinator>;
  setSource(next: PreviewClientSource | null): void;
}

function fixture() {
  const created: CreatedEntry[] = [];
  const closeFailures: number[] = [];
  let nextAttemptId = 0;
  const owner = createPreviewBrowserOwner({
    onCloseFailure() {
      closeFailures.push(created.length);
    },
    create(identity, lifetime) {
      const client = new MemoryClient();
      let current: PreviewClientSource | null = {
        client,
        clientGeneration: 1,
        connectionEpoch: 1,
      };
      const listeners = new Set<() => void>();
      const coordinator = createPreviewCoordinator({
        serviceId: identity.serviceId,
        mode: "tab",
        lifetime,
        profile: createPreviewProfile(new MemoryProfile()),
        createId: () => `attempt-${nextAttemptId++}`,
        getSource: () => current,
        subscribeSource(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        launch() {},
        onCloseFailure() {},
      });
      const entry: CreatedEntry = {
        identity,
        client,
        coordinator,
        setSource(next) {
          current = next;
          for (const listener of listeners) listener();
        },
      };
      created.push(entry);
      return coordinator;
    },
  });
  return { owner, created, closeFailures };
}

const atlas: PreviewBrowserIdentity = { serverId: "host", serviceId: "atlas" };
const orbit: PreviewBrowserIdentity = { serverId: "host", serviceId: "orbit" };

function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Drives a freshly acquired lease's coordinator to an "open" (tab-launched) state. */
async function driveToOpen(entry: CreatedEntry) {
  const opening = entry.coordinator.open();
  await tick();
  const pending = entry.client.prepares.at(-1);
  if (!pending) throw new Error("Expected a pending prepare request");
  const prepared: PreparedPreview = {
    status: "prepared",
    attemptId: pending.input.attemptId,
    bootstrapId: "bootstrap",
    ticket: "ticket",
    serviceId: pending.input.serviceId,
    mode: pending.input.mode,
    expiresInMs: 60_000,
  };
  pending.reply.resolve({ result: prepared });
  await opening;
  expect(entry.coordinator.getSnapshot().status).toBe("ready");
  entry.coordinator.launch();
  expect(entry.coordinator.getSnapshot().status).toBe("open");
}

describe("preview browser owner reachable retention", () => {
  it("disposes each idle, distinct-service lease independently", () => {
    const f = fixture();
    const atlasLease = f.owner.acquire(atlas);
    const orbitLease = f.owner.acquire(orbit);
    expect(f.created).toHaveLength(2);
    atlasLease?.release();
    orbitLease?.release();
    // Both entries were idle at release: reacquiring either identity must
    // build a fresh coordinator, proving neither survived its release.
    f.owner.acquire(atlas);
    f.owner.acquire(orbit);
    expect(f.created).toHaveLength(4);
  });

  it("keeps an active contribution alive with no UI users, and a remount reuses the same coordinator", async () => {
    const f = fixture();
    const first = f.owner.acquire(atlas);
    if (!first) throw new Error("Expected a lease");
    await driveToOpen(f.created[0]);
    first.release();
    // Open with zero users: must not be disposed.
    expect(f.created).toHaveLength(1);
    const second = f.owner.acquire(atlas);
    expect(second?.coordinator).toBe(first.coordinator);
    expect(f.created).toHaveLength(1);
  });

  it.each(["cancel", "source-loss"] as const)(
    "releases an active-but-unwatched lease once %s ends it, after the last UI user is gone",
    async (trigger) => {
      const f = fixture();
      const lease = f.owner.acquire(atlas);
      if (!lease) throw new Error("Expected a lease");
      await driveToOpen(f.created[0]);
      lease.release();
      expect(f.created).toHaveLength(1);
      if (trigger === "cancel") {
        lease.coordinator.cancel();
        const closing = f.created[0].client.closes.at(-1);
        closing?.reply.resolve({
          requestId: "close",
          result: { status: "closed", attemptId: closing.attemptId },
        });
        await tick();
      } else {
        f.created[0].setSource(null);
      }
      // Reaching idle (cancel) or error (source loss) with zero users
      // triggers immediate, synchronous disposal — the owner's lifetime
      // abort cascades into the coordinator's own terminal "closed" state
      // within that same notification.
      expect(lease.coordinator.getSnapshot()).toEqual({ status: "closed" });
      // The now-released, zero-user entry must not be handed back: a fresh
      // acquire builds a new coordinator instead of returning the stale one.
      const replacement = f.owner.acquire(atlas);
      expect(f.created).toHaveLength(2);
      expect(replacement?.coordinator).not.toBe(lease.coordinator);
    },
  );

  it("does not let a stale double release clear a replacement entry for the same identity", async () => {
    const f = fixture();
    const first = f.owner.acquire(atlas);
    if (!first) throw new Error("Expected a lease");
    // Idle at release: disposed immediately.
    first.release();
    expect(f.created).toHaveLength(1);
    const second = f.owner.acquire(atlas);
    expect(f.created).toHaveLength(2);
    await driveToOpen(f.created[1]);
    // A stale caller releasing the same lease handle again (e.g. a duplicate
    // unmount effect) must be inert, not touch the live replacement entry.
    first.release();
    expect(second?.coordinator.getSnapshot().status).toBe("open");
    expect(f.owner.acquire(atlas)?.coordinator).toBe(second?.coordinator);
    expect(f.created).toHaveLength(2);
  });

  it("reports a durable failed-Close failure through the root reporter once the UI has disappeared", async () => {
    const f = fixture();
    const lease = f.owner.acquire(atlas);
    if (!lease) throw new Error("Expected a lease");
    await driveToOpen(f.created[0]);
    lease.coordinator.cancel();
    expect(lease.coordinator.getSnapshot()).toEqual({ status: "cancelling" });
    // The UI unmounts while the Close RPC is still in flight.
    lease.release();
    expect(f.created).toHaveLength(1);
    const closing = f.created[0].client.closes.at(-1);
    closing?.reply.reject(new Error("Close RPC failed"));
    await tick();
    // The refused-Close error arrives with zero users watching: the owner's
    // reporter fires and the entry is disposed within that same notification
    // (the coordinator's own terminal "closed" state, same cascade as above).
    expect(lease.coordinator.getSnapshot()).toEqual({ status: "closed" });
    expect(f.closeFailures).toEqual([1]);
    // Reported and released: no orphaned entry remains for this identity.
    f.owner.acquire(atlas);
    expect(f.created).toHaveLength(2);
  });

  it("drains every entry on root close, regardless of active state or outstanding users", async () => {
    const f = fixture();
    const idleLease = f.owner.acquire(orbit);
    const activeLease = f.owner.acquire(atlas);
    if (!idleLease || !activeLease) throw new Error("Expected leases");
    await driveToOpen(f.created[1]);
    f.owner.close();
    expect(f.owner.acquire(atlas)).toBeNull();
    expect(f.owner.acquire(orbit)).toBeNull();
  });
});
