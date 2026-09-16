export class RestartInProgressError extends Error {
  readonly code = "restart_in_progress";
  constructor() {
    super("The daemon is preparing or recovering a restart; retry this request when it is ready.");
    this.name = "RestartInProgressError";
  }
}

/** Internal completion outcome, never a user cancellation or a failed task. */
export class AgentRestartSuspendedError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} is suspended for restart`);
    this.name = "AgentRestartSuspendedError";
  }
}
