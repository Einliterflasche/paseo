import { attempt, type RestartFailureReporter } from "./best-effort.js";
import type { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import type {
  WorkspaceServiceIdentity,
  WorkspaceServiceRestartSnapshot,
} from "./workspace-service-checkpoint.js";

function key(identity: WorkspaceServiceIdentity): string {
  return `${identity.workspaceId}\0${identity.scriptName}`;
}

export class WorkspaceServiceRelaunchError extends Error {
  constructor(
    readonly identity: WorkspaceServiceIdentity,
    cause: unknown,
  ) {
    super(`Workspace service ${identity.workspaceId}/${identity.scriptName} did not relaunch`, {
      cause,
    });
    this.name = "WorkspaceServiceRelaunchError";
  }
}

export class WorkspaceServiceRestoration {
  private desired: WorkspaceServiceRestartSnapshot = [];

  constructor(
    private readonly runtimeStore: WorkspaceScriptRuntimeStore,
    private readonly launch: (
      identity: WorkspaceServiceIdentity,
    ) => Promise<{ terminalId: string }>,
    private readonly report: RestartFailureReporter,
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

  /** Launches every installed service. A failed launch is reported as step `service` and
   *  skipped. Never rejects. Forgets the installed list when it ends. */
  async resume(): Promise<void> {
    for (const identity of this.desired) {
      await attempt(
        this.report,
        "service",
        () =>
          this.launch(identity).catch((error: unknown) => {
            throw new WorkspaceServiceRelaunchError(identity, error);
          }),
        null,
      );
    }
    this.desired = [];
  }
}
