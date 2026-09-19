import type {
  ProviderOwnedProcessInput,
  ProviderProcessCloseOptions,
  ProviderProcessLifecycle,
  ProviderProcessOwner,
} from "@getpaseo/plugin/server/provider";
import { prepareProcessTreeTermination, terminateWithTreeKill } from "../../utils/tree-kill.js";

interface OwnedProcess {
  sessionId?: string;
  owner: ProviderProcessOwner;
}

export class PluginProviderProcesses implements ProviderProcessLifecycle {
  private readonly processes = new Set<OwnedProcess>();
  private readonly onOwnershipChange: ((owned: boolean) => void) | undefined;
  constructor(onOwnershipChange?: (owned: boolean) => void) {
    this.onOwnershipChange = onOwnershipChange;
  }

  own(input: ProviderOwnedProcessInput): ProviderProcessOwner {
    let closing: Promise<void> | null = null;
    const drained = new Promise<void>((resolve) => input.process.once("close", () => resolve()));
    const prepare = () => prepareProcessTreeTermination(input.process, { timeoutMs: 5_000 });
    const entry: OwnedProcess = {
      sessionId: input.sessionId,
      owner: {
        prepare,
        close: (options?: ProviderProcessCloseOptions): Promise<void> => {
          if (closing) return closing;
          const attempt = (async () => {
            const result = await terminateWithTreeKill(input.process, {
              gracefulTimeoutMs: 5_000,
              forceTimeoutMs: 1_000,
              completedExecution: options?.completedExecution,
            });
            if (result === "kill-timeout") throw new Error("Plugin provider process did not stop");
            await drained;
            this.processes.delete(entry);
            if (this.processes.size === 0) this.onOwnershipChange?.(false);
          })();
          closing = attempt;
          void attempt.catch(() => {
            if (closing === attempt) closing = null;
          });
          return attempt;
        },
      },
    };
    this.processes.add(entry);
    this.onOwnershipChange?.(true);
    // Capture creation identities while the spawned leader is still inspectable.
    void prepare().catch(() => undefined);
    return entry.owner;
  }

  async close(sessionId?: string): Promise<void> {
    const owners = [...this.processes].filter(
      (entry) => sessionId === undefined || entry.sessionId === sessionId,
    );
    await Promise.all(owners.map((entry) => entry.owner.close()));
  }
}
