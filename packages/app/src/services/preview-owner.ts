import { collectAllTabs, type WorkspaceLayout } from "@/stores/workspace-layout-actions";

export interface PreviewTabIdentity {
  workspaceKey: string;
  tabId: string;
  serviceId: string;
}

export interface PreviewTabLifetime {
  readonly identity: Readonly<PreviewTabIdentity>;
  readonly signal: AbortSignal;
}

export interface PreviewDocument<Placement> {
  place(placement: Placement | null): void;
  close(): void;
}

interface PreviewLayouts {
  getState(): { layoutByWorkspace: Record<string, WorkspaceLayout> };
  subscribe(listener: () => void): () => void;
}

interface PreviewOwnerOptions<Placement> {
  layouts: PreviewLayouts;
  create(lifetime: PreviewTabLifetime): PreviewDocument<Placement>;
}

interface Resident<Placement> {
  identity: Readonly<PreviewTabIdentity>;
  lifetime: AbortController;
  document: PreviewDocument<Placement>;
  placement: symbol | null;
}

interface PlacementRegistration<Placement> {
  identity: PreviewTabIdentity;
  generation: AbortSignal;
  placement: Placement;
}

function identityKey({ workspaceKey, tabId }: PreviewTabIdentity): string {
  return JSON.stringify([workspaceKey, tabId]);
}

/** Layout membership owns documents. Disposable pane placements only position them. */
export function createPreviewTabOwner<Placement>({
  layouts,
  create,
}: PreviewOwnerOptions<Placement>) {
  const residents = new Map<string, Resident<Placement>>();
  const listeners = new Set<() => void>();
  let closed = false;
  let synchronizing = false;
  let dirty = false;

  function remove(key: string, resident: Resident<Placement>) {
    residents.delete(key);
    resident.placement = null;
    resident.lifetime.abort();
    resident.document.close();
  }

  function reconcile() {
    let changed = false;
    const members = new Map<string, PreviewTabIdentity>();
    for (const [workspaceKey, layout] of Object.entries(layouts.getState().layoutByWorkspace)) {
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.kind !== "service_preview") continue;
        const identity = { workspaceKey, tabId: tab.tabId, serviceId: tab.target.serviceId };
        members.set(identityKey(identity), identity);
      }
    }
    for (const [key, resident] of residents) {
      if (members.get(key)?.serviceId !== resident.identity.serviceId) {
        remove(key, resident);
        changed = true;
      }
    }
    for (const [key, identity] of members) {
      if (residents.has(key)) continue;
      const lifetime = new AbortController();
      const frozenIdentity = Object.freeze(identity);
      residents.set(key, {
        identity: frozenIdentity,
        lifetime,
        document: create({ identity: frozenIdentity, signal: lifetime.signal }),
        placement: null,
      });
      changed = true;
    }
    if (changed) for (const listener of listeners) listener();
  }

  function synchronize() {
    if (closed) return;
    dirty = true;
    if (synchronizing) return;
    synchronizing = true;
    try {
      while (dirty) {
        if (closed) break;
        dirty = false;
        reconcile();
      }
    } finally {
      synchronizing = false;
    }
  }

  const unsubscribe = layouts.subscribe(synchronize);
  synchronize();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getGeneration(identity: PreviewTabIdentity): AbortSignal | null {
      const resident = residents.get(identityKey(identity));
      return resident?.identity.serviceId === identity.serviceId ? resident.lifetime.signal : null;
    },
    place({ identity, generation, placement }: PlacementRegistration<Placement>) {
      const resident = residents.get(identityKey(identity));
      if (
        !resident ||
        resident.identity.serviceId !== identity.serviceId ||
        resident.lifetime.signal !== generation
      )
        return null;
      const token = Symbol("preview-placement");
      resident.placement = token;
      resident.document.place(placement);
      const isCurrent = () => !resident.lifetime.signal.aborted && resident.placement === token;
      return {
        update(next: Placement) {
          if (isCurrent()) resident.document.place(next);
        },
        release() {
          if (!isCurrent()) return;
          resident.placement = null;
          resident.document.place(null);
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const [key, resident] of residents) remove(key, resident);
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}
