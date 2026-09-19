import type { createPreviewCoordinator } from "./preview-coordinator";

export interface PreviewBrowserIdentity {
  serverId: string;
  serviceId: string;
}

type Coordinator = ReturnType<typeof createPreviewCoordinator>;

interface BrowserEntry {
  lifetime: AbortController;
  coordinator: Coordinator;
  users: number;
  stop: () => void;
}

interface BrowserOwnerOptions {
  create(identity: PreviewBrowserIdentity, lifetime: AbortSignal): Coordinator;
  onCloseFailure(): void | Promise<void>;
}

/** Active standalone previews outlive panels; unused controllers do not. */
export function createPreviewBrowserOwner(options: BrowserOwnerOptions) {
  const entries = new Map<string, BrowserEntry>();
  let closed = false;

  function dispose(key: string, entry: BrowserEntry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    entry.stop();
    entry.lifetime.abort();
  }

  async function reportCloseFailure() {
    try {
      await options.onCloseFailure();
    } catch {
      // Reporting must not prevent releasing the source subscriptions.
    }
  }

  function collect(key: string, entry: BrowserEntry) {
    if (entry.users > 0 || entries.get(key) !== entry) return;
    const state = entry.coordinator.getSnapshot();
    if (state.status !== "idle" && state.status !== "error" && state.status !== "closed") return;
    dispose(key, entry);
    // Cancel's refused Close may finish after the last panel disappears. Keep
    // that outcome visible through the root reporter instead of an orphan UI.
    if (state.status === "error" && state.code === "close") void reportCloseFailure();
  }

  return {
    acquire(identity: PreviewBrowserIdentity) {
      if (closed) return null;
      const key = JSON.stringify([identity.serverId, identity.serviceId]);
      let entry = entries.get(key);
      if (!entry) {
        const lifetime = new AbortController();
        entry = {
          lifetime,
          coordinator: options.create(identity, lifetime.signal),
          users: 0,
          stop: () => {},
        };
        entries.set(key, entry);
        const owned = entry;
        entry.stop = entry.coordinator.subscribe(() => collect(key, owned));
      }
      entry.users += 1;
      const owned = entry;
      let released = false;
      return {
        coordinator: entry.coordinator,
        release() {
          if (released) return;
          released = true;
          owned.users -= 1;
          collect(key, owned);
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [key, entry] of entries) dispose(key, entry);
    },
  };
}
