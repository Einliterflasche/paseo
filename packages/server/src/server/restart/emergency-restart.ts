import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { DaemonLifecycleIntent } from "../bootstrap.js";
import type { RestartController } from "./restart-controller.js";
import { loadEmergencyHistory, saveEmergencyHistory } from "./emergency-history.js";

interface EmergencyRestartOptions {
  home: string;
  agentManager: Pick<AgentManager, "exportEmergencyHistory" | "installEmergencyHistory">;
  controller: Pick<
    RestartController<unknown>,
    "status" | "abandonForRestart" | "reportEmergencyFailure"
  >;
  logger: Logger;
  supported: boolean;
  replace?: (intent: DaemonLifecycleIntent) => void | Promise<void>;
}

/** Owns the explicit escape from checkpoint recovery, including its bounded history rescue. */
export class EmergencyRestart {
  private attempt: Promise<{ restartId: string }> | null = null;

  constructor(private readonly options: EmergencyRestartOptions) {}

  async installHistory(restartId?: string): Promise<void> {
    if (!restartId) return;
    try {
      this.options.agentManager.installEmergencyHistory(
        await loadEmergencyHistory(this.options.home, restartId),
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error, restartId },
        "Emergency history unavailable; retained checkpoints remain untouched and native history loads on demand",
      );
    }
  }

  request(
    intent: Extract<DaemonLifecycleIntent, { type: "restart" }>,
  ): Promise<{ restartId: string }> {
    const { controller, supported, replace, logger } = this.options;
    if (!supported || !replace)
      return Promise.reject(new Error("This host does not support Restart anyway"));
    if (this.attempt) return this.attempt;
    const status = controller.status;
    if (
      !intent.restartAnyway ||
      status.error !== intent.restartAnyway.expectedError ||
      (status.generationId ?? null) !== intent.restartAnyway.expectedGenerationId
    )
      return Promise.reject(
        new Error("Recovery changed. Review the current error before restarting anyway."),
      );
    controller.abandonForRestart();
    const restartId = randomUUID();
    logger.warn(
      { restartId, requester: intent.acknowledgmentRequester, previousStatus: status },
      "User requested Restart anyway and accepted loss of unfinished recovery work",
    );
    this.attempt = this.replaceWithHistory(intent, restartId, replace).catch((error) => {
      this.failed(error);
      throw error;
    });
    return this.attempt;
  }

  private async replaceWithHistory(
    intent: DaemonLifecycleIntent,
    restartId: string,
    replace: NonNullable<EmergencyRestartOptions["replace"]>,
  ): Promise<{ restartId: string }> {
    const save = Promise.resolve()
      .then(() =>
        saveEmergencyHistory(
          this.options.home,
          restartId,
          this.options.agentManager.exportEmergencyHistory(),
        ),
      )
      .catch((error) =>
        this.options.logger.warn({ err: error, restartId }, "Emergency history save failed"),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        save,
        new Promise<void>((done) => {
          timer = setTimeout(done, 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await replace({ ...intent, requestId: restartId });
    return { restartId };
  }

  failed(error: unknown): void {
    this.attempt = null;
    this.options.controller.reportEmergencyFailure(error);
  }
}
