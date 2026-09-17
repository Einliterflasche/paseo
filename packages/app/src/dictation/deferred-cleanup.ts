/** Effect replay may reattach an owner before its queued cleanup runs. */
export function createDeferredCleanup(dispose: () => void, enqueue: (task: () => void) => void) {
  let generation = 0;
  return () => {
    const current = ++generation;
    return () => {
      enqueue(() => {
        if (generation === current) dispose();
      });
    };
  };
}
