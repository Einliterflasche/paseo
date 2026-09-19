import type { ServicesPreferenceStorage } from "./preferences-state";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export class MemoryServicesStorage implements ServicesPreferenceStorage {
  readonly data = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: { key: string; value: string }[] = [];
  readonly removals: string[] = [];
  writeError: Error | null = null;
  private heldRead: ReturnType<MemoryServicesStorage["holdNextRead"]> | null = null;
  private heldWrite: ReturnType<MemoryServicesStorage["holdNextWrite"]> | null = null;

  holdNextRead(): {
    started: ReturnType<typeof deferred<void>>;
    result: ReturnType<typeof deferred<string | null>>;
  } {
    const read = { started: deferred<void>(), result: deferred<string | null>() };
    this.heldRead = read;
    return read;
  }

  holdNextWrite(): {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } {
    const write = { started: deferred<void>(), release: deferred<void>() };
    this.heldWrite = write;
    return write;
  }

  async getItem(key: string): Promise<string | null> {
    this.reads.push(key);
    const held = this.heldRead;
    this.heldRead = null;
    if (held) {
      held.started.resolve();
      return held.result.promise;
    }
    return this.data.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.writes.push({ key, value });
    const held = this.heldWrite;
    this.heldWrite = null;
    if (held) {
      held.started.resolve();
      await held.release.promise;
    }
    if (this.writeError) throw this.writeError;
    this.data.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.removals.push(key);
    this.data.delete(key);
  }
}

export function waitForResult<T>(
  observer: { getCurrentResult(): T; subscribe(listener: (result: T) => void): () => void },
  accept: (result: T) => boolean,
): Promise<T> {
  const current = observer.getCurrentResult();
  if (accept(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (accept(result)) {
        unsubscribe();
        resolve(result);
      }
    });
  });
}
