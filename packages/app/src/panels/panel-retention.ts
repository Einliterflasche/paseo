/** Leases keep in-flight panel work mounted without marking its document modified. */
export function createPanelRetention() {
  const leases = new Map<string, Set<symbol>>();
  const listeners = new Set<() => void>();
  let snapshot = new Set<string>();
  function publish() {
    snapshot = new Set(leases.keys());
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retain(tabId: string) {
      const token = Symbol(tabId);
      const owners = leases.get(tabId) ?? new Set<symbol>();
      owners.add(token);
      leases.set(tabId, owners);
      if (owners.size === 1) publish();
      return () => {
        if (!owners.delete(token) || owners.size > 0) return;
        leases.delete(tabId);
        publish();
      };
    },
  };
}

export type PanelRetention = ReturnType<typeof createPanelRetention>;
