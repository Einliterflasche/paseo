import type { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import type {
  WorkspaceServiceIdentity,
  WorkspaceServiceRestartSnapshot,
} from "./workspace-service-checkpoint.js";

function key(identity: WorkspaceServiceIdentity): string {
  return `${identity.workspaceId}\0${identity.scriptName}`;
}

export class WorkspaceServiceRestoration {
  private desired: WorkspaceServiceRestartSnapshot = [];
  private readonly launchedTerminalIds: string[] = [];

  constructor(
    private readonly runtimeStore: WorkspaceScriptRuntimeStore,
    private readonly launch: (
      identity: WorkspaceServiceIdentity,
    ) => Promise<{ terminalId: string }>,
    private readonly stopTerminal: (terminalId: string) => Promise<void>,
  ) {}

  capture(): WorkspaceServiceRestartSnapshot {
    if (this.desired.length) return this.desired.map((identity) => ({ ...identity }));
    return this.runtimeStore
      .listAll()
      .filter((entry) => entry.type === "service" && entry.lifecycle === "running")
      .map(({ workspaceId, scriptName }) => ({ workspaceId, scriptName }))
      .sort((left, right) => key(left).localeCompare(key(right)));
  }

  install(snapshot: WorkspaceServiceRestartSnapshot | undefined): void {
    const identities = new Map<string, WorkspaceServiceIdentity>();
    for (const identity of snapshot ?? []) {
      const identityKey = key(identity);
      if (identities.has(identityKey)) {
        throw new Error(
          `Duplicate workspace service in restart checkpoint: ${identity.workspaceId}/${identity.scriptName}`,
        );
      }
      identities.set(identityKey, { ...identity });
    }
    this.desired = [...identities.values()].sort((left, right) =>
      key(left).localeCompare(key(right)),
    );
  }

  async resume(): Promise<void> {
    if (this.launchedTerminalIds.length) {
      throw new Error("Workspace service restoration already owns launched terminals");
    }
    try {
      for (const identity of this.desired) {
        const result = await this.launch(identity);
        this.launchedTerminalIds.push(result.terminalId);
      }
    } catch (error) {
      const cleanupErrors = await this.rollback();
      if (cleanupErrors.length) {
        const failure = new Error("Workspace service restoration and rollback failed", {
          cause: error,
        });
        Object.assign(failure, { cleanupErrors });
        throw failure;
      }
      throw error;
    }
  }

  async rollback(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const terminalId of this.launchedTerminalIds.splice(0).toReversed()) {
      try {
        await this.stopTerminal(terminalId);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async rollbackOrThrow(): Promise<void> {
    const errors = await this.rollback();
    if (errors.length) {
      throw new AggregateError(errors, "Failed to stop restored workspace services");
    }
  }

  finalize(): void {
    this.desired = [];
    this.launchedTerminalIds.length = 0;
  }
}
