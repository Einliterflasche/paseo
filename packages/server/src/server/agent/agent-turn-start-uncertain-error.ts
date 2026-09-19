/** The native handoff may have executed; only a terminal event or certified close settles it. */
export class AgentTurnStartUncertainError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Native turn start could not be confirmed", {
      cause,
    });
    this.name = "AgentTurnStartUncertainError";
  }
}
