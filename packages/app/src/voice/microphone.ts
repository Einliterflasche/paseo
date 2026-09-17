/** A lease covers permission prompts and teardown as well as active recording. */
export function createMicrophoneCoordinator() {
  let owner: "dictation" | "voice" | null = null;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => owner,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire(nextOwner: "dictation" | "voice"): (() => void) | null {
      if (owner) return null;
      owner = nextOwner;
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        owner = null;
        emit();
      };
    },
  };
}

export type MicrophoneCoordinator = ReturnType<typeof createMicrophoneCoordinator>;
