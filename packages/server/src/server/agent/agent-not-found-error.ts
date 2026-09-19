/** Command validation failed before acquiring or mutating an execution owner. */
export class AgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = "AgentNotFoundError";
  }
}
