import { randomUUID } from "node:crypto";
import { recoveryInput, type RecoveryInput } from "../restart/recovery-input.js";
import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";

import { getAgentStreamEventTurnId, type AgentStreamEvent } from "./agent-sdk-types.js";

export interface ForegroundTurnWaiter {
  turnId: string;
  callback: (event: AgentStreamEvent) => void;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export interface PendingForegroundRun {
  token: string;
  kind: "foreground";
  stagedEvents: AgentStreamEvent[];
  start:
    | { status: "pending" }
    | { status: "started"; turnId: string }
    | { status: "failed"; error: string };
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export interface AutonomousAgentRun {
  token: string;
  kind: "autonomous";
  turnId: string | null;
  started: true;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export type TrackedAgentRun = PendingForegroundRun | AutonomousAgentRun;

export interface ForegroundRunAgentState {
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
}

export type AgentRunOutcomeInput =
  | { type: "completed" | "user_canceled" | "suspended"; agentId: string }
  | { type: "failed" | "uncertain"; agentId: string; error: string };

export type AgentRunOutcome = AgentRunOutcomeInput & { runId: string; lastMessage: string | null };

export class AgentRunState {
  private readonly runs = new Map<string, TrackedAgentRun>();
  private readonly recovery = new Map<string, RecoveryInput[]>();
  private readonly logicalIds = new Map<string, string>();
  private readonly outcomes = new Map<string, AgentRunOutcome>();
  private readonly outcomeListeners = new Map<string, Set<(outcome: AgentRunOutcome) => void>>();

  /** Permanent discard happens only after execution and its terminal observers settle. */
  clearAgentState(agentId: string): void {
    if (this.runs.has(agentId)) throw new Error(`Cannot discard active run ${agentId}`);
    this.recovery.delete(agentId);
    this.logicalIds.delete(agentId);
    this.outcomes.delete(agentId);
    this.outcomeListeners.delete(agentId);
  }

  getOutcome(agentId: string): AgentRunOutcome | undefined {
    return this.outcomes.get(agentId);
  }
  clearOutcome(agentId: string): void {
    this.outcomes.delete(agentId);
  }

  getLogicalId(agentId: string): string | undefined {
    return this.logicalIds.get(agentId);
  }

  publishOutcome(input: AgentRunOutcomeInput, lastMessage: string | null): void {
    const runId = this.logicalIds.get(input.agentId);
    if (!runId) return;
    const outcome: AgentRunOutcome = { ...input, runId, lastMessage };
    this.outcomes.set(input.agentId, outcome);
    for (const listener of this.outcomeListeners.get(input.agentId) ?? []) listener(outcome);
  }

  subscribeOutcome(agentId: string, listener: (outcome: AgentRunOutcome) => void): () => void {
    let listeners = this.outcomeListeners.get(agentId);
    if (!listeners) this.outcomeListeners.set(agentId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.outcomeListeners.delete(agentId);
    };
  }

  waitForOutcome(agentId: string, runId: string): Promise<AgentRunOutcome> {
    const previous = this.outcomes.get(agentId);
    if (previous?.runId === runId) return Promise.resolve(previous);
    return new Promise((resolve) => {
      const unsubscribe = this.subscribeOutcome(agentId, (outcome) => {
        if (outcome.runId !== runId) return;
        unsubscribe();
        resolve(outcome);
      });
    });
  }

  rememberInput(
    agentId: string,
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
    intent: "run" | "steer",
  ): void {
    const input = recoveryInput(prompt, options, intent);
    const current = intent === "run" ? [] : (this.recovery.get(agentId) ?? []);
    if (!current.some((entry) => entry.id === input.id)) current.push(input);
    this.recovery.set(agentId, current);
    if (intent === "run") this.logicalIds.set(agentId, input.id);
  }

  recoveryInputs(agentId: string): RecoveryInput[] {
    return structuredClone(this.recovery.get(agentId) ?? []);
  }

  restoreInputs(agentId: string, inputs: RecoveryInput[], runId?: string): void {
    this.recovery.set(agentId, structuredClone(inputs));
    this.logicalIds.set(agentId, runId ?? inputs[0]?.id ?? randomUUID());
  }

  forgetInputs(agentId: string): void {
    this.recovery.delete(agentId);
  }

  createPendingRun(agentId: string): PendingForegroundRun {
    this.outcomes.delete(agentId);
    const pendingRun = createPendingForegroundRun();
    this.runs.set(agentId, pendingRun);
    this.logicalIds.set(agentId, pendingRun.token);
    return pendingRun;
  }

  getPendingRun(agentId: string): PendingForegroundRun | null {
    const run = this.runs.get(agentId);
    return run?.kind === "foreground" ? run : null;
  }

  hasPendingRun(agentId: string): boolean {
    return this.getPendingRun(agentId) !== null;
  }

  getRun(agentId: string): TrackedAgentRun | null {
    return this.runs.get(agentId) ?? null;
  }

  hasRun(agentId: string): boolean {
    return this.runs.has(agentId);
  }

  getTurnId(agentId: string): string | null {
    const run = this.runs.get(agentId);
    if (!run) return null;
    if (run.kind === "autonomous") return run.turnId;
    return run.start.status === "started" ? run.start.turnId : null;
  }

  trackAutonomousRun(agentId: string, turnId: string | null): TrackedAgentRun {
    const current = this.runs.get(agentId);
    if (current) {
      return current;
    }

    this.outcomes.delete(agentId);
    const run: AutonomousAgentRun = {
      ...createTrackedRunState(),
      kind: "autonomous",
      turnId,
      started: true,
    };
    this.runs.set(agentId, run);
    this.logicalIds.set(agentId, run.token);
    return run;
  }

  settleTerminalRun(agentId: string, turnId: string | undefined): void {
    const run = this.runs.get(agentId);
    if (!run) {
      return;
    }
    if (
      run.kind === "foreground" &&
      (run.start.status !== "started" || run.start.turnId !== turnId)
    ) {
      return;
    }
    if (
      run.kind === "autonomous" &&
      run.turnId !== null &&
      turnId !== undefined &&
      run.turnId !== turnId
    ) {
      return;
    }

    this.clearRun(agentId, run);
  }

  settleForegroundRun(agentId: string, token: string): void {
    const run = this.runs.get(agentId);
    if (run?.kind !== "foreground" || run.token !== token) {
      return;
    }

    this.clearRun(agentId, run);
  }

  clearAgentRun(agentId: string): void {
    const run = this.runs.get(agentId);
    if (run) {
      this.clearRun(agentId, run);
    }
  }

  createTurnStream(turnId: string): ForegroundTurnStream {
    return new ForegroundTurnStream(turnId);
  }

  addWaiter(agent: ForegroundRunAgentState, waiter: ForegroundTurnWaiter): void {
    agent.foregroundTurnWaiters.add(waiter);
  }

  deleteWaiter(agent: ForegroundRunAgentState, waiter: ForegroundTurnWaiter): void {
    agent.foregroundTurnWaiters.delete(waiter);
    this.settleWaiter(waiter);
  }

  settleWaiter(waiter: ForegroundTurnWaiter): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    waiter.resolveSettled();
  }

  getMatchingWaiters(
    agent: ForegroundRunAgentState,
    turnId: string | undefined,
  ): ForegroundTurnWaiter[] {
    if (turnId == null) {
      return [];
    }

    return Array.from(agent.foregroundTurnWaiters).filter(
      (waiter) => waiter.turnId === turnId && !waiter.settled,
    );
  }

  notifyWaiters(
    waiters: Iterable<ForegroundTurnWaiter>,
    event: AgentStreamEvent,
    options: { terminal: boolean },
  ): void {
    for (const waiter of waiters) {
      waiter.callback(event);
      if (options.terminal) {
        this.settleWaiter(waiter);
      }
    }
  }

  notifyAgentWaiters(
    agent: ForegroundRunAgentState,
    event: AgentStreamEvent,
    options?: { terminal?: boolean },
  ): void {
    const waiters = this.getMatchingWaiters(agent, getAgentStreamEventTurnId(event));
    this.notifyWaiters(waiters, event, { terminal: options?.terminal ?? false });
  }

  cancelWaiters(
    agent: ForegroundRunAgentState,
    createEvent: (turnId: string) => AgentStreamEvent,
  ): void {
    for (const waiter of agent.foregroundTurnWaiters) {
      waiter.callback(createEvent(waiter.turnId));
      this.settleWaiter(waiter);
    }
    agent.foregroundTurnWaiters.clear();
  }

  rememberFinalizedTurn(agent: ForegroundRunAgentState, turnId: string): void {
    agent.finalizedForegroundTurnIds.add(turnId);
    if (agent.finalizedForegroundTurnIds.size <= 50) {
      return;
    }

    const oldest = agent.finalizedForegroundTurnIds.values().next().value;
    if (oldest) {
      agent.finalizedForegroundTurnIds.delete(oldest);
    }
  }

  hasFinalizedTurn(agent: ForegroundRunAgentState, turnId: string): boolean {
    return agent.finalizedForegroundTurnIds.has(turnId);
  }

  private clearRun(agentId: string, run: TrackedAgentRun): void {
    this.runs.delete(agentId);
    settleTrackedRun(run);
  }
}

export class ForegroundTurnStream {
  private readonly queue: AgentStreamEvent[] = [];
  private queueResolve: (() => void) | null = null;

  readonly waiter: ForegroundTurnWaiter;

  constructor(turnId: string) {
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolvePromise) => {
      resolveSettled = resolvePromise;
    });

    this.waiter = {
      turnId,
      settled: false,
      settledPromise,
      resolveSettled,
      callback: (event) => {
        this.queue.push(event);
        this.wake();
      },
    };
  }

  async *events(
    isTerminalEvent: (event: AgentStreamEvent) => boolean,
  ): AsyncGenerator<AgentStreamEvent> {
    let done = false;
    while (!done) {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        yield event;
        if (isTerminalEvent(event)) {
          done = true;
          break;
        }
      }

      if (!done && this.queue.length === 0) {
        if (this.waiter.settled) {
          break;
        }
        await new Promise<void>((resolvePromise) => {
          this.queueResolve = resolvePromise;
        });
      }
    }
  }

  private wake(): void {
    if (!this.queueResolve) {
      return;
    }

    this.queueResolve();
    this.queueResolve = null;
  }
}

function createPendingForegroundRun(): PendingForegroundRun {
  return {
    ...createTrackedRunState(),
    kind: "foreground",
    start: { status: "pending" },
    stagedEvents: [],
  };
}

function createTrackedRunState(): {
  token: string;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
} {
  let resolveSettled!: () => void;
  const settledPromise = new Promise<void>((resolvePromise) => {
    resolveSettled = resolvePromise;
  });
  return {
    token: randomUUID(),
    settled: false,
    settledPromise,
    resolveSettled,
  };
}

function settleTrackedRun(run: TrackedAgentRun): void {
  if (run.settled) {
    return;
  }

  run.settled = true;
  run.resolveSettled();
}
