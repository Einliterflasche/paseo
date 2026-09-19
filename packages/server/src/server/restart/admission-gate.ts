import { AsyncLocalStorage } from "node:async_hooks";
import { RestartInProgressError } from "./restart-errors.js";

/** Owns short admission operations, never the duration of a model turn. */
export class AdmissionGate {
  private frozen = false;
  private readonly admitted = new Set<Promise<unknown>>();
  private readonly scope = new AsyncLocalStorage<{ active: boolean }>();

  assertOpen(): void {
    if (this.frozen && !this.scope.getStore()?.active) throw new RestartInProgressError();
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.own(operation);
  }

  private own<T>(operation: () => Promise<T>): Promise<T> {
    const scope = { active: true };
    const result = this.scope.run(scope, async () => operation());
    this.admitted.add(result);
    void result
      .finally(() => {
        scope.active = false;
        this.admitted.delete(result);
      })
      .catch(() => undefined);
    return result;
  }

  async freeze(): Promise<void> {
    this.frozen = true;
    while (this.admitted.size) await Promise.allSettled(this.admitted);
  }

  get isOpen(): boolean {
    return !this.frozen;
  }

  /** Provider events own settlement, never authority to admit a new command. */
  outside<T>(operation: () => T): T {
    return this.scope.exit(operation);
  }

  open(): void {
    this.frozen = false;
  }
}
