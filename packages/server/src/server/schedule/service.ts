import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import {
  formatSystemNotificationPrompt,
  startAgentRun,
  type AgentRunController,
} from "../agent/agent-prompt.js";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
import { AgentRestartSuspendedError, RestartInProgressError } from "../restart/restart-errors.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { ScheduleStore } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleRun,
  ScheduleTarget,
  StoredSchedule,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "@getpaseo/protocol/schedule/types";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const SCHEDULE_TICK_INTERVAL_MS = 1000;

// A run failed because its target no longer exists: the agent was deleted or
// archived, or a new-agent cwd was removed. These are permanent, so the schedule
// is completed instead of retried until it burns down to its expiry.
export class ScheduleTargetGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetGoneError";
  }
}

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildScheduleFireBody(schedule: StoredSchedule, runId: string): string {
  const heading = schedule.name
    ? `Schedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).`
    : `Schedule fired (id=${schedule.id}, run=${runId}).`;
  return `${heading}\n${schedule.prompt}`;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Schedule prompt is required");
  }
  return trimmed;
}

function applyNewAgentConfig(
  target: Extract<ScheduleTarget, { type: "new-agent" }>,
  patch: UpdateScheduleNewAgentConfig,
): Extract<ScheduleTarget, { type: "new-agent" }> {
  const config = { ...target.config };
  if (patch.provider !== undefined) {
    const trimmed = patch.provider.trim();
    if (!trimmed) {
      throw new Error("provider cannot be empty");
    }
    config.provider = trimmed;
  }
  if (patch.cwd !== undefined) {
    const trimmed = patch.cwd.trim();
    if (!trimmed) {
      throw new Error("cwd cannot be empty");
    }
    config.cwd = trimmed;
  }
  if (patch.model !== undefined) {
    const trimmed = patch.model?.trim();
    if (trimmed) {
      config.model = trimmed;
    } else {
      delete config.model;
    }
  }
  if (patch.modeId !== undefined) {
    const trimmed = patch.modeId?.trim();
    if (trimmed) {
      config.modeId = trimmed;
    } else {
      delete config.modeId;
    }
  }
  if (patch.thinkingOptionId !== undefined) {
    const trimmed = patch.thinkingOptionId?.trim();
    if (trimmed) {
      config.thinkingOptionId = trimmed;
    } else {
      delete config.thinkingOptionId;
    }
  }
  if (patch.archiveOnFinish !== undefined) {
    config.archiveOnFinish = patch.archiveOnFinish;
  }
  if (patch.isolation !== undefined) {
    config.isolation = patch.isolation;
  }
  return { ...target, config };
}

function normalizeMaxRuns(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxRuns must be a positive integer");
  }
  return value;
}

function countCompletedRuns(schedule: StoredSchedule): number {
  return schedule.runs.filter((run) => run.status !== "running").length;
}

function shouldArchiveScheduleRunWorkspace(input: {
  agentId: string | null;
  archiveOnFinish?: boolean;
}): boolean {
  return input.agentId === null || (input.archiveOnFinish ?? true);
}

function shouldCompleteSchedule(schedule: StoredSchedule, now: Date): boolean {
  if (schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  if (schedule.maxRuns == null) {
    return false;
  }
  return countCompletedRuns(schedule) >= schedule.maxRuns;
}

function requireSchedule(schedule: StoredSchedule | null, id: string): StoredSchedule {
  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }
  return schedule;
}

function completeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "completed",
    nextRunAt: null,
    pausedAt: null,
    updatedAt: now.toISOString(),
  };
}

function mergeScheduleCadenceTimezone(
  current: StoredSchedule["cadence"],
  next: StoredSchedule["cadence"],
): StoredSchedule["cadence"] {
  if (
    current.type === "cron" &&
    next.type === "cron" &&
    next.timezone === undefined &&
    current.timezone !== undefined
  ) {
    return {
      ...next,
      timezone: current.timezone,
    };
  }
  return next;
}

function buildRunOutput(params: {
  output: string | null;
  timelineText: string;
  finalText: string;
}): string | null {
  if (params.output && params.output.trim().length > 0) {
    return params.output;
  }
  if (params.finalText.trim().length > 0) {
    return params.finalText.trim();
  }
  if (params.timelineText.trim().length > 0) {
    return params.timelineText.trim();
  }
  return null;
}

type ScheduleAgentManager = Pick<
  AgentRunController,
  | "getAgent"
  | "reloadAgentSession"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> &
  Pick<
    AgentManager,
    | "createAgent"
    | "getRegisteredProviderIds"
    | "hydrateTimelineFromProvider"
    | "resumeAgentFromPersistence"
    | "runAgent"
    | "runRequestAdmission"
    | "waitForAgentRunStart"
    | "startObservedRun"
    | "getRunIdentity"
    | "getRunOutcome"
    | "subscribeRunOutcome"
    | "getLastAssistantMessage"
    | "waitForAgentEvent"
    | "waitForAgentClose"
  >;

interface ScheduleWorkspaceCreateInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

/** One schedule run still owned by this process when a controlled restart began. */
export interface ScheduleRestartRunRecord {
  scheduleId: string;
  runId: string;
  agentId: string;
  workspaceId: string | null;
  manual: boolean;
  logicalRunId?: string;
}

interface PendingScheduleArchive {
  scheduleId: string;
  runId: string;
  workspaceId: string;
}
export interface ScheduleRestartSnapshot {
  runs: ScheduleRestartRunRecord[];
  archives?: PendingScheduleArchive[];
}

export const ScheduleRestartRunRecordSchema = z.object({
  scheduleId: z.string(),
  runId: z.string(),
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  manual: z.boolean(),
  logicalRunId: z.string().optional(),
});

/** Validate a checkpointed schedule snapshot before claiming/executing it. */
export const ScheduleRestartSnapshotSchema = z.object({
  runs: z.array(ScheduleRestartRunRecordSchema),
  archives: z
    .array(z.object({ scheduleId: z.string(), runId: z.string(), workspaceId: z.string() }))
    .optional(),
});

/**
 * What a schedule target's `start*` method returns once its SHORT admission
 * (assignment + turn start) is done. `completion` represents the rest of the run —
 * the model turn — already in flight but not yet awaited. runSchedule() awaits this
 * handle itself under trackAdmission(), then awaits `completion` separately, outside
 * it: pauseForRestart()'s drain only ever needs to wait for the handle, never for a
 * still-running model turn.
 */
export interface ScheduleExecutionHandle {
  completion: Promise<ScheduleExecutionResult>;
}

interface FinishRunParams {
  scheduleId: string;
  runId: string;
  status: "succeeded" | "failed";
  agentId: string | null;
  output: string | null;
  error: string | null;
  targetGone: boolean;
  manual: boolean;
}

export interface ScheduleServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: ScheduleAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  now?: () => Date;
  runner?: (schedule: StoredSchedule, runId: string) => Promise<ScheduleExecutionResult>;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly agentManager: ScheduleAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  private readonly createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
  ) => Promise<ScheduleExecutionHandle>;
  private readonly runningScheduleIds = new Set<string>();
  // Manual-run context for whatever is currently in runningScheduleIds. Not
  // persisted on ScheduleRun (the protocol type owns that schema); ephemeral,
  // rebuilt on every runSchedule() and only read back by snapshotForRestart().
  private readonly activeRunContext = new Map<string, { runId: string; manual: boolean }>();
  // runIds a restart checkpoint claimed: recoverInterruptedRuns() must not
  // fail them, and executeSchedule() must not start a replacement for them.
  private readonly restoredRunIds = new Set<string>();
  // Registered by restoreAfterRestart(), attached by resumeRestoredRuns()
  // once the manager has the owning agents registered.
  private pendingRestoredRuns: ScheduleRestartRunRecord[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // Owned pause state for a controlled restart — see pauseForRestart().
  private paused = false;
  // One entry per schedule whose SHORT admission (assignment + turn start, not
  // the model turn itself) is still in flight — see trackAdmission()/pauseForRestart().
  private readonly admissionSettlement = new Map<string, Promise<unknown>>();
  // finishRun()'s store write, tracked while it's in flight. A run's genuine
  // completion can land at any time, including right as a checkpoint starts;
  // snapshotForRestart() drains this set first so it never captures a run as
  // "running" purely because its terminal write hadn't settled yet — that
  // would point the checkpoint at an agent the manager's own snapshot no
  // longer considers resumable, causing a false failed reattachment for a
  // run that had actually already finished.
  private readonly pendingFinishWrites = new Set<Promise<void>>();
  private readonly admissionFailures = new Map<string, unknown>();
  // Failures from finishRun()'s store write, keyed by `${scheduleId}:${runId}` and kept
  // even after the rejected write itself has left pendingFinishWrites (a settled
  // promise, rejected or not, is still "drained"). A run whose terminal write never
  // reached the store is not the same as one that's still running: snapshotForRestart()
  // must not silently proceed as if the write had landed — the caller's own
  // understanding of the run's outcome would then be more current than, and
  // inconsistent with, whatever generation gets checkpointed. Cleared on a later
  // successful write for the same key.
  private readonly finishRunWriteFailures = new Map<string, unknown>();
  private readonly decidedSettlements = new Map<string, FinishRunParams>();
  private readonly pendingArchives = new Map<string, PendingScheduleArchive>();
  private readonly pendingSettlements = new Set<Promise<unknown>>();
  private archiveDrain: Promise<void> | null = null;
  private readonly runCompletions = new Map<string, Promise<void>>();
  private readonly restoredCompletions = new Set<string>();
  private readonly logicalRunIds = new Map<string, string>();
  private readonly terminalRunIds = new Set<string>();
  private readonly runOutcomeWatches = new Map<string, () => void>();

  constructor(options: ScheduleServiceOptions) {
    this.store = new ScheduleStore(join(options.paseoHome, "schedules"));
    this.logger = options.logger.child({ module: "schedule-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.createDirectoryWorkspace = options.createDirectoryWorkspace;
    this.createPaseoWorktreeWorkspace = options.createPaseoWorktreeWorkspace;
    this.archiveWorkspace = options.archiveWorkspace;
    this.now = options.now ?? (() => new Date());
    // The public test seam still returns a flat ScheduleExecutionResult — wrapped once,
    // centrally, into a handle whose admission is trivially "already decided": tests
    // using a custom runner are exercising completion/failure semantics, not admission
    // timing, and none of them need to observe or control that split.
    this.runner = options.runner
      ? (schedule, runId) => Promise.resolve({ completion: options.runner!(schedule, runId) })
      : (schedule, runId) => this.executeSchedule(schedule, runId);
  }

  async start(): Promise<void> {
    await this.agentManager.runRequestAdmission(async () => {
      await this.initializeRecoveryState();
      this.resumeAfterRestartFailure();
    });
  }

  /** Called by lifecycle installation after restored run identities are registered. */
  async initializeRecoveryState(): Promise<void> {
    await this.recoverInterruptedRuns();
    await this.sweepOrphanedSchedules();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private resumeTicking(): void {
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process schedule tick");
      });
    }, SCHEDULE_TICK_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  /** Stops the timer and drains service bookkeeping; the manager owns shared admission. */
  async pauseForRestart(): Promise<void> {
    this.paused = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    while (this.admissionSettlement.size > 0) {
      await Promise.allSettled(this.admissionSettlement.values());
    }
  }

  /**
   * Owns both ends of admission tracking around a single promise — the caller never signals
   * completion itself, so there is no separate call to forget. Must be invoked as the first
   * thing runSchedule() does after adding to runningScheduleIds, with no `await` in between,
   * so pauseForRestart() can never run in the gap between `paused` being checked (in
   * tick()/runOnce()) and this being recorded — JS won't preempt that synchronous span.
   *
   * `admission` should resolve once its SHORT admission step (assignment + turn start) is
   * done, not once the whole model turn finishes — see startSchedule()'s per-target methods,
   * which return a handle whose own `completion` promise is deliberately awaited outside
   * this tracker.
   */
  private trackAdmission<T>(scheduleId: string, admission: Promise<T>): Promise<T> {
    const tracked = admission.finally(() => {
      if (this.admissionSettlement.get(scheduleId) === tracked) {
        this.admissionSettlement.delete(scheduleId);
      }
    });
    this.admissionSettlement.set(scheduleId, tracked);
    return tracked;
  }

  /** Resume ticking after a restart preparation failed and the daemon stays up. */
  resumeAfterRestartFailure(): void {
    this.paused = false;
    this.resumeTicking();
    void this.drainPendingArchives();
  }

  /**
   * Capture the schedule runs this process still owns when a controlled
   * restart begins. Read from the store (the source of truth for run
   * fields) rather than a duplicated in-memory copy.
   *
   * Throws if a running run has no agent assigned yet (admitted but not far
   * enough along to have a native session to resume) — that leaves the
   * daemon paused with the old state intact rather than checkpointing a run
   * with nothing to reattach to.
   *
   * Drains any in-flight finishRun() writes first: a run can genuinely complete at any
   * time, including right as this is called, and finishRun()'s store write is async. Reading
   * the store before that write lands would capture the run as still "running" purely
   * because of write latency — pointing the checkpoint at an agent the manager's own
   * snapshot no longer considers resumable (it already saw the real completion), which
   * would make restore falsely fail reattachment for a run that had actually finished.
   *
   * A drained write can still have been a rejection: Promise.allSettled() treats a
   * rejected promise as "settled" too, which is correct for draining but not for
   * trusting what it wrote. If any drained finishRun() write actually failed, its
   * terminal state never reached the store — the checkpoint can't safely represent
   * this run's real outcome, so this throws instead of proceeding as if the store were
   * current.
   */
  async snapshotForRestart(): Promise<ScheduleRestartSnapshot> {
    await this.drainOwnedSettlements();
    const runs: ScheduleRestartRunRecord[] = [];
    for (const scheduleId of this.runningScheduleIds) {
      const schedule = await this.store.get(scheduleId);
      const runningRun = schedule?.runs.find((run) => run.status === "running");
      if (!schedule || !runningRun) {
        continue;
      }
      if (!runningRun.agentId) {
        throw new Error(
          `Schedule ${scheduleId} run ${runningRun.id} has no agent assigned yet; cannot checkpoint mid-admission`,
        );
      }
      runs.push({
        scheduleId,
        runId: runningRun.id,
        agentId: runningRun.agentId,
        workspaceId: runningRun.workspaceId ?? null,
        manual: this.activeRunContext.get(scheduleId)?.manual ?? false,
        logicalRunId:
          this.logicalRunIds.get(scheduleId) ??
          this.agentManager.getRunIdentity(runningRun.agentId),
      });
    }
    return {
      runs,
      ...(this.pendingArchives.size ? { archives: [...this.pendingArchives.values()] } : {}),
    };
  }

  private async drainOwnedSettlements(): Promise<void> {
    for (const [scheduleId, completion] of this.runCompletions) {
      const runId = this.activeRunContext.get(scheduleId)?.runId;
      // This service owns the observed settlement. A later turn on the same
      // agent cannot replace the evidence while terminal bookkeeping drains.
      if (runId && this.terminalRunIds.has(runId)) await completion;
    }
    if (this.admissionFailures.size > 0) {
      throw new AggregateError(
        [...this.admissionFailures.values()],
        "Schedule admission did not settle before restart",
      );
    }
    while (this.pendingFinishWrites.size || this.pendingSettlements.size) {
      await Promise.allSettled([...this.pendingFinishWrites, ...this.pendingSettlements]);
    }
    // Retry the owned decision, never infer a replacement outcome from the current agent.
    for (const decision of this.decidedSettlements.values()) await this.settleRun(decision);
    if (this.finishRunWriteFailures.size > 0 || this.decidedSettlements.size > 0) {
      const [key, error] = [...this.finishRunWriteFailures.entries()][0] ?? [
        this.decidedSettlements.keys().next().value,
        new Error("terminal bookkeeping remains pending"),
      ];
      throw new Error(
        `Schedule run ${key} failed to persist its terminal state and cannot be safely ` +
          `checkpointed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Register the schedule runs a restart checkpoint claimed. Call before
   * `start()` so `recoverInterruptedRuns()` excludes them instead of failing
   * them. Does not wait on anything yet — the owning agents are not
   * necessarily registered with the agent manager at this point.
   */
  restoreAfterRestart(snapshot: ScheduleRestartSnapshot): void {
    for (const archive of snapshot.archives ?? []) this.pendingArchives.set(archive.runId, archive);
    const added = snapshot.runs.filter(
      (run) => !this.pendingRestoredRuns.some((pending) => pending.runId === run.runId),
    );
    for (const run of added) {
      this.restoredRunIds.add(run.runId);
      this.runningScheduleIds.add(run.scheduleId);
      this.activeRunContext.set(run.scheduleId, { runId: run.runId, manual: run.manual });
      const logicalId = run.logicalRunId ?? this.agentManager.getRunIdentity(run.agentId);
      if (logicalId) this.logicalRunIds.set(run.scheduleId, logicalId);
    }
    this.pendingRestoredRuns.push(...added);
    this.resumeRestoredRuns();
  }

  /**
   * Attach to the runs `restoreAfterRestart` registered. Call once their
   * agents are registered with the agent manager (and their continuation
   * turns are about to start, per the manager's own restore ordering) —
   * never starts a replacement run or agent, only waits for the original
   * agent to reach a terminal state and completes the original run under
   * its original scheduleId/runId.
   */
  resumeRestoredRuns(): void {
    const runs = this.pendingRestoredRuns;
    this.pendingRestoredRuns = [];
    for (const run of runs) {
      if (this.restoredCompletions.has(run.runId)) continue;
      this.restoredCompletions.add(run.runId);
      const completion = this.reattachRestoredRun(run).catch((error) => {
        this.admissionFailures.set(run.scheduleId, error);
        this.logger.error(
          { err: error, scheduleId: run.scheduleId, runId: run.runId },
          "Failed to reattach restored schedule run",
        );
      });
      this.runCompletions.set(run.scheduleId, completion);
      void completion
        .finally(() => {
          this.restoredCompletions.delete(run.runId);
          if (this.runCompletions.get(run.scheduleId) === completion)
            this.runCompletions.delete(run.scheduleId);
        })
        .catch(() => undefined);
    }
  }

  private async reattachRestoredRun(run: ScheduleRestartRunRecord): Promise<void> {
    try {
      const logicalRunId = run.logicalRunId ?? this.agentManager.getRunIdentity(run.agentId);
      if (!logicalRunId)
        throw new Error(`Missing logical run identity for restored schedule ${run.runId}`);
      // A logical schedule survives any number of native session suspensions.
      const lastMessage = await new Promise<string | null>((resolve, reject) => {
        let unsubscribe: (() => void) | undefined;
        const observe = (
          outcome: NonNullable<ReturnType<ScheduleAgentManager["getRunOutcome"]>>,
        ) => {
          if (
            outcome.runId !== logicalRunId ||
            outcome.type === "suspended" ||
            outcome.type === "uncertain"
          )
            return;
          this.terminalRunIds.add(run.runId);
          unsubscribe?.();
          if (outcome.type === "completed") resolve(outcome.lastMessage);
          else
            reject(
              new Error(
                outcome.type === "failed"
                  ? outcome.error
                  : `Scheduled agent ${run.agentId} was canceled`,
              ),
            );
        };
        unsubscribe = this.agentManager.subscribeRunOutcome(run.agentId, observe);
        const current = this.agentManager.getRunOutcome(run.agentId);
        if (current) observe(current);
      });
      await this.settleRun({
        scheduleId: run.scheduleId,
        runId: run.runId,
        status: "succeeded",
        agentId: run.agentId,
        output: buildRunOutput({
          output: null,
          timelineText: "",
          finalText: lastMessage ?? "",
        }),
        error: null,
        targetGone: false,
        manual: run.manual,
      });
    } catch (error) {
      if (error instanceof AgentRestartSuspendedError) {
        return;
      }
      await this.settleRun({
        scheduleId: run.scheduleId,
        runId: run.runId,
        status: "failed",
        agentId: run.agentId,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        targetGone: false,
        manual: run.manual,
      });
    }
  }

  create(input: CreateScheduleInput): Promise<StoredSchedule> {
    return this.agentManager.runRequestAdmission(() => this.createInternal(input));
  }

  private async createInternal(input: CreateScheduleInput): Promise<StoredSchedule> {
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    return this.createScheduleRecord(input, {
      name: trimOptionalName(input.name),
      prompt,
      target: input.target,
    });
  }

  private async createScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Promise<StoredSchedule> {
    return this.store.create(this.buildScheduleRecord(input, fields));
  }

  private buildScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Omit<StoredSchedule, "id"> {
    const now = this.now();
    const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
    const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
    return {
      name: fields.name,
      prompt: fields.prompt,
      cadence: input.cadence,
      target: fields.target,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: input.expiresAt ?? null,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      runs: [],
    };
  }

  // Idempotent create for the MCP write path: repeating a create with the same
  // name and target (e.g. babysit-pr re-registering its heartbeat) refreshes the
  // existing non-completed schedule in place instead of minting a duplicate.
  createOrReplace(input: CreateScheduleInput): Promise<StoredSchedule> {
    return this.agentManager.runRequestAdmission(() => this.createOrReplaceInternal(input));
  }

  private async createOrReplaceInternal(input: CreateScheduleInput): Promise<StoredSchedule> {
    const name = trimOptionalName(input.name);
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    if (name === null) {
      return this.createScheduleRecord(input, { name, prompt, target: input.target });
    }

    const inputTarget = input.target;
    return this.store.upsertByNameAndTarget(name, inputTarget, {
      create: async () => {
        return this.buildScheduleRecord(input, { name, prompt, target: inputTarget });
      },
      update: async (current) => {
        const now = this.now();
        const cadence = mergeScheduleCadenceTimezone(current.cadence, input.cadence);
        const runOnCreate = input.runOnCreate ?? cadence.type === "every";
        const nextRunAt = runOnCreate ? now : computeNextRunAt(cadence, now);
        return {
          ...current,
          name,
          prompt,
          cadence,
          target: inputTarget,
          status: "active",
          pausedAt: null,
          nextRunAt: nextRunAt.toISOString(),
          expiresAt: input.expiresAt ?? null,
          maxRuns: normalizeMaxRuns(input.maxRuns),
          updatedAt: now.toISOString(),
        };
      },
    });
  }

  async list(): Promise<StoredSchedule[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredSchedule> {
    const schedule = await this.store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    return schedule;
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const schedule = await this.inspect(id);
    return [...schedule.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  pause(id: string): Promise<StoredSchedule> {
    return this.agentManager.runRequestAdmission(() => this.pauseInternal(id));
  }

  private async pauseInternal(id: string): Promise<StoredSchedule> {
    const paused = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "paused") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "paused" as const,
        nextRunAt: null,
        pausedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(paused, id);
  }

  resume(id: string): Promise<StoredSchedule> {
    return this.agentManager.runRequestAdmission(() => this.resumeInternal(id));
  }

  private async resumeInternal(id: string): Promise<StoredSchedule> {
    const resumed = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "active") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "active" as const,
        pausedAt: null,
        nextRunAt: computeNextRunAt(schedule.cadence, now).toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(resumed, id);
  }

  update(input: UpdateScheduleInput): Promise<StoredSchedule> {
    return this.agentManager.runRequestAdmission(() => this.updateInternal(input));
  }

  private async updateInternal(input: UpdateScheduleInput): Promise<StoredSchedule> {
    const next = await this.store.update(input.id, async (schedule) => {
      const now = this.now();
      let updated: StoredSchedule = schedule;

      if (input.prompt !== undefined) {
        updated = { ...updated, prompt: normalizePrompt(input.prompt) };
      }

      if (input.name !== undefined) {
        updated = { ...updated, name: trimOptionalName(input.name) };
      }

      if (input.cadence !== undefined) {
        const cadence = mergeScheduleCadenceTimezone(updated.cadence, input.cadence);
        validateScheduleCadence(cadence);
        const nextRunAt =
          updated.status === "active" ? computeNextRunAt(cadence, now).toISOString() : null;
        updated = { ...updated, cadence, nextRunAt };
      }

      if (input.newAgentConfig !== undefined) {
        if (updated.target.type !== "new-agent") {
          throw new Error("new-agent config updates are only valid for new-agent target schedules");
        }
        const patchedTarget = applyNewAgentConfig(updated.target, input.newAgentConfig);
        updated = {
          ...updated,
          target: patchedTarget,
        };
      }

      if (input.maxRuns !== undefined) {
        updated = { ...updated, maxRuns: normalizeMaxRuns(input.maxRuns) };
      }

      if (input.expiresAt !== undefined) {
        updated = { ...updated, expiresAt: input.expiresAt };
      }

      return { ...updated, updatedAt: now.toISOString() };
    });
    return requireSchedule(next, input.id);
  }

  delete(id: string): Promise<void> {
    return this.agentManager.runRequestAdmission(() => this.deleteInternal(id));
  }

  private async deleteInternal(id: string): Promise<void> {
    await this.store.delete(id);
  }

  completeForAgent(agentId: string): Promise<number> {
    return this.agentManager.runRequestAdmission(() => this.completeForAgentInternal(agentId));
  }

  private async completeForAgentInternal(agentId: string): Promise<number> {
    const now = this.now();
    const schedules = await this.store.list();
    const matches = schedules.filter(
      (schedule) =>
        schedule.target.type === "agent" &&
        schedule.target.agentId === agentId &&
        schedule.status !== "completed",
    );
    const results = await Promise.allSettled(
      matches.map((schedule) => this.completeScheduleForAgent(schedule.id, agentId, now)),
    );
    let completed = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        completed += 1;
      } else if (result.status === "rejected") {
        this.logger.warn(
          {
            err: result.reason,
            scheduleId: matches[index].id,
            agentId,
          },
          "Failed to complete schedule for archived agent; continuing",
        );
      }
    }
    return completed;
  }

  private async completeScheduleForAgent(
    scheduleId: string,
    agentId: string,
    now: Date,
  ): Promise<boolean> {
    let completed = false;
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.target.type !== "agent" ||
        schedule.target.agentId !== agentId ||
        schedule.status === "completed"
      ) {
        return schedule;
      }
      completed = true;
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
    return completed;
  }

  async runOnce(id: string): Promise<StoredSchedule> {
    if (this.paused) {
      throw new RestartInProgressError();
    }
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new Error(`Schedule ${id} is already completed`);
    }
    if (this.runningScheduleIds.has(id)) {
      throw new Error(`Schedule ${id} is already running`);
    }
    await this.runSchedule(schedule, this.now(), { manual: true });
    return this.inspect(id);
  }

  async tick(): Promise<void> {
    if (this.paused) {
      return;
    }
    const now = this.now();
    const schedules = await this.store.list();
    for (const schedule of schedules) {
      // Re-checked every iteration: pauseForRestart() can be requested while
      // this loop is already in progress (it doesn't cancel an in-progress
      // tick), and no schedule after that point may start fresh admission
      // into an already-frozen manager.
      if (this.paused) {
        return;
      }
      if (schedule.status !== "active" || !schedule.nextRunAt) {
        continue;
      }
      if (this.runningScheduleIds.has(schedule.id)) {
        continue;
      }
      if (shouldCompleteSchedule(schedule, now)) {
        await this.completeScheduleIfDue(schedule.id, now);
        continue;
      }
      if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      await this.runSchedule(schedule, now);
    }
  }

  private completeScheduleIfDue(scheduleId: string, now: Date): Promise<void> {
    return this.agentManager.runRequestAdmission(() =>
      this.completeScheduleIfDueAccepted(scheduleId, now),
    );
  }

  private async completeScheduleIfDueAccepted(scheduleId: string, now: Date): Promise<void> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        !shouldCompleteSchedule(schedule, now)
      ) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    await Promise.all(
      schedules.map((schedule) => this.recoverInterruptedSchedule(schedule.id, now)),
    );
  }

  private async recoverInterruptedSchedule(scheduleId: string, now: Date): Promise<void> {
    const interruptedWorkspaces: Array<{
      workspaceId: string;
      agentId: string | null;
      runId: string;
    }> = [];
    await this.store.update(scheduleId, (current) => {
      let updated = { ...current };
      let dirty = false;

      const runningIndex = updated.runs.findIndex(
        (run) => run.status === "running" && !this.restoredRunIds.has(run.id),
      );
      if (runningIndex !== -1) {
        const runs = [...updated.runs];
        const runningRun = runs[runningIndex];
        if (
          updated.target.type === "new-agent" &&
          runningRun.workspaceId &&
          shouldArchiveScheduleRunWorkspace({
            agentId: runningRun.agentId,
            archiveOnFinish: updated.target.config.archiveOnFinish,
          })
        ) {
          interruptedWorkspaces.push({
            workspaceId: runningRun.workspaceId,
            agentId: runningRun.agentId,
            runId: runningRun.id,
          });
        }
        runs[runningIndex] = {
          ...runningRun,
          status: "failed",
          endedAt: now.toISOString(),
          error: "Daemon restarted before the scheduled run completed",
        };
        updated = { ...updated, runs };
        dirty = true;
      }

      if (
        updated.status === "active" &&
        updated.nextRunAt &&
        new Date(updated.nextRunAt).getTime() <= now.getTime()
      ) {
        let nextRunAt = computeNextRunAt(updated.cadence, new Date(updated.nextRunAt));
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = { ...updated, nextRunAt: nextRunAt.toISOString() };
        dirty = true;
      }

      if (dirty) {
        return { ...updated, updatedAt: now.toISOString() };
      }
      return current;
    });
    const interruptedWorkspace = interruptedWorkspaces[0];
    if (!interruptedWorkspace) {
      return;
    }
    this.pendingArchives.set(interruptedWorkspace.runId, {
      scheduleId,
      runId: interruptedWorkspace.runId,
      workspaceId: interruptedWorkspace.workspaceId,
    });
  }

  // Orphaned agent-target schedules (agent deleted while the daemon was down, or
  // archived before completeForAgent existed) can never fire successfully. Complete
  // them on startup so they stop ticking and surface as ended in the UI.
  private async sweepOrphanedSchedules(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    await Promise.all(schedules.map((schedule) => this.sweepOrphanedSchedule(schedule.id, now)));
  }

  private async sweepOrphanedSchedule(scheduleId: string, now: Date): Promise<void> {
    await this.store.update(scheduleId, async (schedule) => {
      if (schedule.target.type !== "agent" || schedule.status === "completed") {
        return schedule;
      }
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (record && !record.archivedAt) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
  }

  private runSchedule(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
  ): Promise<void> {
    const completion = this.runScheduleOwned(schedule, now, options);
    this.runCompletions.set(schedule.id, completion);
    void completion
      .finally(() => {
        if (this.runCompletions.get(schedule.id) === completion)
          this.runCompletions.delete(schedule.id);
      })
      .catch(() => undefined);
    return completion;
  }

  private async runScheduleOwned(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
  ): Promise<void> {
    // Recheck after callers' awaited reads, before registering any new work.
    if (this.paused) {
      throw new RestartInProgressError();
    }
    const manual = options?.manual === true;
    const runId = randomUUID();
    let registered = false;
    const runningRun: ScheduleRun = {
      id: runId,
      scheduledFor: manual ? now.toISOString() : (schedule.nextRunAt ?? now.toISOString()),
      startedAt: now.toISOString(),
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    };

    try {
      // Track the first store write too: no await may separate the admission check
      // from registration, or pauseForRestart() could miss this run.
      const handle = await this.trackAdmission(
        schedule.id,
        this.agentManager.runRequestAdmission(async () => {
          if (this.paused) throw new RestartInProgressError();
          this.runningScheduleIds.add(schedule.id);
          this.activeRunContext.set(schedule.id, { runId, manual });
          this.logicalRunIds.set(schedule.id, runId);
          registered = true;
          const scheduleWithRun = await this.appendRunningRun(schedule.id, runningRun);
          return this.runner(scheduleWithRun, runId);
        }),
      );
      const result = await handle.completion;
      this.terminalRunIds.add(runId);
      // A failed save must not reach the execution-error handler and rewrite success
      // as failure. Retain ownership until the actual outcome is durable.
      await this.settleRun({
        scheduleId: schedule.id,
        runId,
        status: "succeeded",
        agentId: result.agentId,
        output: result.output,
        error: null,
        targetGone: false,
        manual,
      });
    } catch (error) {
      if (!registered) throw error;
      if (error instanceof AgentRestartSuspendedError) {
        this.runOutcomeWatches.get(runId)?.();
        this.runOutcomeWatches.delete(runId);
        // Restart interruption, not a real failure: leave the run "running"
        // in the store and this schedule in runningScheduleIds so
        // snapshotForRestart() captures it instead of finishRun() failing
        // and archiving it here.
        this.logger.info(
          { scheduleId: schedule.id, runId, agentId: error.agentId },
          "Schedule run suspended for restart",
        );
        return;
      }
      if (error instanceof RestartInProgressError) {
        this.admissionFailures.set(schedule.id, error);
        // The admission drain should prevent this. Keep the row and block checkpointing:
        // even an assigned agentId does not prove the manager accepted the work.
        this.logger.error(
          { scheduleId: schedule.id, runId },
          "Schedule admission was rejected after registration; checkpoint blocked",
        );
        return;
      }
      this.terminalRunIds.add(runId);
      // A genuine execution failure (not a persistence failure — see settleRun() above,
      // which never rethrows, so this catch only ever sees execution/admission errors).
      await this.settleRun({
        scheduleId: schedule.id,
        runId,
        status: "failed",
        agentId: null,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        targetGone: error instanceof ScheduleTargetGoneError,
        manual,
      });
    }
  }

  private async appendRunningRun(
    scheduleId: string,
    runningRun: ScheduleRun,
  ): Promise<StoredSchedule> {
    const updated = await this.store.update(scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: runningRun.startedAt,
      runs: [...schedule.runs, runningRun],
    }));
    return requireSchedule(updated, scheduleId);
  }

  /** Save the decided outcome without reclassifying a write failure as execution failure. */
  private settleRun(params: FinishRunParams): Promise<{ persisted: boolean }> {
    this.decidedSettlements.set(`${params.scheduleId}:${params.runId}`, params);
    const settlement = this.settleRunOwned(params);
    this.pendingSettlements.add(settlement);
    void settlement
      .finally(() => this.pendingSettlements.delete(settlement))
      .catch(() => undefined);
    return settlement;
  }

  private async settleRunOwned(params: FinishRunParams): Promise<{ persisted: boolean }> {
    try {
      await this.finishRun(params);
      const schedule = await this.store.get(params.scheduleId);
      const run = schedule?.runs.find((candidate) => candidate.id === params.runId);
      if (
        schedule?.target.type === "new-agent" &&
        run?.workspaceId &&
        shouldArchiveScheduleRunWorkspace({
          agentId: run.agentId,
          archiveOnFinish: schedule.target.config.archiveOnFinish,
        })
      ) {
        this.pendingArchives.set(params.runId, {
          scheduleId: params.scheduleId,
          runId: params.runId,
          workspaceId: run.workspaceId,
        });
      }
      this.runningScheduleIds.delete(params.scheduleId);
      this.activeRunContext.delete(params.scheduleId);
      this.logicalRunIds.delete(params.scheduleId);
      this.restoredRunIds.delete(params.runId);
      this.terminalRunIds.delete(params.runId);
      this.runOutcomeWatches.get(params.runId)?.();
      this.runOutcomeWatches.delete(params.runId);
      await this.drainPendingArchives();
      this.decidedSettlements.delete(`${params.scheduleId}:${params.runId}`);
      return { persisted: true };
    } catch (error) {
      this.logger.error(
        { err: error, scheduleId: params.scheduleId, runId: params.runId, status: params.status },
        "Failed to persist a schedule run's terminal state",
      );
      return { persisted: false };
    }
  }

  private drainPendingArchives(): Promise<void> {
    if (this.archiveDrain) return this.archiveDrain;
    if (this.paused) return Promise.resolve();
    this.archiveDrain = (async () => {
      for (const archive of this.pendingArchives.values()) {
        try {
          await this.agentManager.runRequestAdmission(() =>
            this.archiveWorkspace(archive.workspaceId),
          );
          this.pendingArchives.delete(archive.runId);
        } catch (error) {
          if (!(error instanceof RestartInProgressError))
            this.logger.warn({ err: error, ...archive }, "Schedule archive remains pending");
        }
      }
    })().finally(() => {
      this.archiveDrain = null;
    });
    return this.archiveDrain;
  }

  private async finishRun(params: FinishRunParams): Promise<void> {
    const key = `${params.scheduleId}:${params.runId}`;
    const write = this.writeFinishRun(params);
    this.pendingFinishWrites.add(write);
    try {
      await write;
      this.finishRunWriteFailures.delete(key);
    } catch (error) {
      this.finishRunWriteFailures.set(key, error);
      throw error;
    } finally {
      this.pendingFinishWrites.delete(write);
    }
  }

  private async writeFinishRun(params: FinishRunParams): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => {
      const existing = schedule.runs.find((run) => run.id === params.runId);
      if (!existing) throw new Error(`Schedule run ${params.runId} no longer exists`);
      // Terminal persistence is idempotent across a subsequent bookkeeping/read
      // failure. In particular, retry must not advance the cadence a second time.
      if (existing.status !== "running") return schedule;
      const now = this.now();
      const completedRuns = schedule.runs.map((run) =>
        run.id === params.runId
          ? {
              ...run,
              status: params.status,
              endedAt: now.toISOString(),
              agentId: params.agentId ?? run.agentId,
              output: params.output,
              error: params.error,
            }
          : run,
      );
      let updated: StoredSchedule = {
        ...schedule,
        runs: completedRuns,
        lastRunAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      if (params.targetGone) {
        // The target is permanently gone; retrying only burns the schedule down to
        // its expiry, so complete it now regardless of manual/scheduled origin.
        updated = completeSchedule(updated, now);
      } else if (updated.status === "completed") {
        // Completed concurrently (e.g. the target agent was archived mid-run);
        // record the run outcome but leave the schedule terminal — don't advance.
      } else if (params.manual) {
        // Manual one-shot runs do not advance the cadence or recompute completion.
      } else if (shouldCompleteSchedule(updated, now)) {
        updated = completeSchedule(updated, now);
      } else if (updated.status === "paused") {
        updated = {
          ...updated,
          nextRunAt: null,
        };
      } else {
        const after = new Date(schedule.nextRunAt ?? now.toISOString());
        let nextRunAt = computeNextRunAt(updated.cadence, after);
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = {
          ...updated,
          nextRunAt: nextRunAt.toISOString(),
        };
      }

      return updated;
    });
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  /**
   * Record the agent an in-flight run is attached to, for target kinds (existing-agent
   * schedules) that have no workspace to record alongside it. Written as soon as the
   * agent is known — synchronously at admission here, unlike new-agent schedules where
   * it only exists after agent creation — so snapshotForRestart() can always checkpoint
   * a run that has actually started, not just new-agent ones.
   */
  private async recordRunAgentId(params: {
    scheduleId: string;
    runId: string;
    agentId: string;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: this.now().toISOString(),
      runs: schedule.runs.map((run) =>
        run.id === params.runId && run.status === "running"
          ? { ...run, agentId: params.agentId }
          : run,
      ),
    }));
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async recordRunWorkspace(params: {
    scheduleId: string;
    runId: string;
    workspaceId: string;
    agentId: string | null;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: this.now().toISOString(),
      runs: schedule.runs.map((run) =>
        run.id === params.runId && run.status === "running"
          ? {
              ...run,
              workspaceId: params.workspaceId,
              agentId: params.agentId,
            }
          : run,
      ),
    }));
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private watchRunOutcome(agentId: string, runId: string): void {
    this.runOutcomeWatches.get(runId)?.();
    const observe = (outcome: NonNullable<ReturnType<ScheduleAgentManager["getRunOutcome"]>>) => {
      if (outcome.runId === runId && outcome.type !== "suspended" && outcome.type !== "uncertain")
        this.terminalRunIds.add(runId);
    };
    this.runOutcomeWatches.set(runId, this.agentManager.subscribeRunOutcome(agentId, observe));
    const current = this.agentManager.getRunOutcome(agentId);
    if (current) observe(current);
  }

  private async executeSchedule(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionHandle> {
    if (schedule.target.type === "agent") {
      return this.startAgentTargetSchedule(schedule.target, schedule, runId);
    }
    return this.startNewAgentTargetSchedule(schedule, runId);
  }

  private async startAgentTargetSchedule(
    target: Extract<ScheduleTarget, { type: "agent" }>,
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionHandle> {
    const wrappedPrompt = formatSystemNotificationPrompt(buildScheduleFireBody(schedule, runId));
    const record = await this.agentStorage.get(target.agentId);
    if (!record) {
      throw new ScheduleTargetGoneError(`Agent ${target.agentId} no longer exists`);
    }
    if (record.archivedAt) {
      throw new ScheduleTargetGoneError(`Agent ${target.agentId} is archived`);
    }

    const agent = await ensureAgentLoaded(target.agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });
    if (this.agentManager.hasInFlightRun(agent.id)) {
      throw new Error(`Agent ${agent.id} already has an active run`);
    }
    // Written before admission, not after completion: a restart mid-turn must find this
    // run's agentId already on the store row, or snapshotForRestart() has nothing to
    // checkpoint against and refuses the whole checkpoint.
    await this.recordRunAgentId({ scheduleId: schedule.id, runId, agentId: agent.id });
    this.watchRunOutcome(agent.id, runId);
    const observed = await this.agentManager.startObservedRun(agent.id, runId, () =>
      startAgentRun(this.agentManager, agent.id, wrappedPrompt, this.logger, {
        runOptions: { clientMessageId: runId },
      }),
    );
    const completion = (async (): Promise<ScheduleExecutionResult> => {
      const outcome = await observed.completion;
      if (outcome.type === "suspended" || outcome.type === "uncertain")
        throw new AgentRestartSuspendedError(agent.id);
      if (outcome.type === "user_canceled")
        throw new Error(`Scheduled agent ${agent.id} was canceled`);
      if (outcome.type === "failed") throw new Error(outcome.error);
      const lastMessage = outcome.lastMessage;
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: null,
          timelineText: "",
          finalText: lastMessage ?? "",
        }),
      };
    })();
    return { completion };
  }

  private async startNewAgentTargetSchedule(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionHandle> {
    const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
    if (!config) {
      throw new Error(`Schedule ${schedule.id} target changed during execution`);
    }
    await this.assertNewAgentCwdDirectory(config.cwd);
    let workspace: PersistedWorkspaceRecord | null = null;
    let agentId: string | null = null;
    workspace = await this.createScheduleRunWorkspace(config, schedule.prompt);
    await this.recordRunWorkspace({
      scheduleId: schedule.id,
      runId,
      workspaceId: workspace.workspaceId,
      agentId: null,
    });
    const runConfig = { ...config, cwd: workspace.cwd };
    const created = await this.createAgent({
      kind: "mcp",
      provider: formatScheduleProviderModel(runConfig),
      config: buildScheduleAgentConfig(runConfig),
      cwd: workspace.cwd,
      workspaceId: workspace.workspaceId,
      title: resolveScheduleAgentTitle(config, schedule.prompt),
      labels: {
        "paseo.schedule-id": schedule.id,
        "paseo.schedule-run": runId,
      },
      mode: config.modeId,
      thinking: config.thinkingOptionId,
      features: config.featureValues,
      unattended: true,
      promptFailure: "return-error",
      background: true,
      notifyOnFinish: false,
    });
    const agent = created.snapshot;
    agentId = agent.id;
    await this.recordRunWorkspace({
      scheduleId: schedule.id,
      runId,
      workspaceId: workspace.workspaceId,
      agentId,
    });
    // Admission is done here: the agent exists and is about to dispatch. The rest
    // (dispatch + the whole model turn) is `completion`, deliberately not awaited by
    // this method — see runNewAgentTargetCompletion(). The archive-on-finish handling
    // below intentionally covers only failures reaching this point (workspace/agent
    // creation itself); runNewAgentTargetCompletion() owns it for everything after.
    this.watchRunOutcome(agent.id, runId);
    const completion = this.runNewAgentTargetCompletion({
      schedule,
      runId,
      config,
      workspace,
      agentId,
      created,
      agent,
    });
    // Both assignment and actual turn handoff belong to the same short admission.
    await Promise.race([this.agentManager.waitForAgentRunStart(agent.id), completion]);
    return { completion };
  }

  private async runNewAgentTargetCompletion(input: {
    schedule: StoredSchedule;
    runId: string;
    config: Extract<ScheduleTarget, { type: "new-agent" }>["config"];
    workspace: PersistedWorkspaceRecord;
    agentId: string;
    created: Awaited<ReturnType<BoundCreateAgentCommand>>;
    agent: Awaited<ReturnType<BoundCreateAgentCommand>>["snapshot"];
  }): Promise<ScheduleExecutionResult> {
    const { schedule, runId, created, agent } = input;
    if (created.initialPromptError) throw created.initialPromptError;
    const result = await this.agentManager.runAgent(agent.id, schedule.prompt, {
      clientMessageId: runId,
    });
    if (result.canceled) throw new Error(`Scheduled agent ${agent.id} was canceled`);
    return {
      agentId: agent.id,
      output: buildRunOutput({
        output: null,
        timelineText: curateAgentActivity(result.timeline),
        finalText: result.finalText,
      }),
    };
  }

  private async createScheduleRunWorkspace(
    config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
    prompt: string,
  ): Promise<PersistedWorkspaceRecord> {
    const firstAgentContext = { prompt };
    switch (config.isolation ?? "local") {
      case "local":
        return this.createDirectoryWorkspace({ cwd: config.cwd, firstAgentContext });
      case "worktree":
        return (await this.createPaseoWorktreeWorkspace({ cwd: config.cwd, firstAgentContext }))
          .workspace;
    }
  }

  private async assertNewAgentCwdDirectory(cwd: string): Promise<void> {
    try {
      const stats = await stat(cwd);
      if (!stats.isDirectory()) {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} no longer exists`);
      }
      throw error;
    }
  }
}

function buildScheduleAgentConfig(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): AgentSessionConfig {
  return {
    provider: config.provider,
    cwd: config.cwd,
    modeId: config.modeId,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId,
    title: config.title,
    providerOptions: config.providerOptions,
    featureValues: config.featureValues,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers as AgentSessionConfig["mcpServers"],
  };
}

function resolveScheduleAgentTitle(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
  prompt: string,
): string {
  return (
    resolveCreateAgentTitles({
      configTitle: config.title,
      initialPrompt: prompt,
    }).provisionalTitle ?? ""
  );
}

function formatScheduleProviderModel(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): string {
  return formatProviderModel(config.provider, config.model);
}
