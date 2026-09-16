import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & {
  reloadAgentSession(agentId: string): Promise<unknown>;
};

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const steerOptions = options.clearPendingPermissions
    ? { ...options.runOptions, clearPendingPermissions: true }
    : options.runOptions;
  const result = await agentManager.steerOrReplaceActiveTurn(agentId, prompt, steerOptions);
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  if (result.status === "replaced") {
    return { disposition: "turn_started", iterator: result.iterator };
  }
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    return { disposition: "out_of_band" };
  }
  try {
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  } catch (error) {
    if (!isStaleProviderSessionError(error)) throw error;
    logger.info({ agentId, err: error }, "Provider session went stale; reopening from persistence");
    // The live session belongs to a retired plugin runtime. Reload swaps in a
    // fresh session on the current runtime while preserving history and labels.
    await agentManager.reloadAgentSession(agentId);
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);
  if (steered?.disposition === "steered") {
    return steered;
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: true }
    : await startOrReplaceRun(agentManager, agentId, prompt, options);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options);
        await drainAgentRunIterator(retry.iterator);
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { disposition: "turn_started" };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      return { disposition: "turn_started" };
    }
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, clientMessageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: true,
    activeTurnBehavior: params.activeTurnBehavior,
    clearPendingPermissions: params.clearPendingPermissions,
    runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

export type FinishNotificationReason = "finished" | "errored" | "needs permission" | "was closed";

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

/** One undelivered obligation. Stable `id` so a retried/restored delivery is never duplicated. */
export interface FinishNotificationPendingRecord {
  id: string;
  reason: FinishNotificationReason;
  permissionRequest?: AgentPermissionRequest;
  /**
   * Captured once when the obligation was created, not recomputed on
   * retry/restore — the child's last assistant message can change or become
   * unavailable after it unloads, and a restart retry must report what
   * actually happened, not whatever is current when it happens to fire.
   */
  lastAssistantMessage: string | null;
}

/**
 * Capturable/restorable state for one `setupFinishNotification` watch —
 * everything the closure used to keep only in memory. See
 * `snapshotFinishNotificationWatches`/`restoreFinishNotificationWatch`.
 */
export interface FinishNotificationWatchRecord {
  watchId: string;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership: boolean;
  hasSeenRunning: boolean;
  notifiedPermissionRequestIds: string[];
  /** Delivery-ordered; oldest entry is the one currently being attempted. */
  pending: FinishNotificationPendingRecord[];
}

export const FinishNotificationPendingRecordSchema = z.object({
  id: z.string(),
  reason: z.enum(["finished", "errored", "needs permission", "was closed"]),
  lastAssistantMessage: z.string().nullable(),
  permissionRequest: z
    .object({
      id: z.string(),
      provider: z.string(),
      name: z.string(),
      kind: z.enum(["tool", "plan", "question", "mode", "other"]),
      title: z.string().optional(),
      description: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      detail: z.unknown().optional(),
      suggestions: z.array(z.unknown()).optional(),
      actions: z.array(z.unknown()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional() as z.ZodType<AgentPermissionRequest | undefined>,
});

export const FinishNotificationWatchRecordSchema = z.object({
  watchId: z.string(),
  childAgentId: z.string(),
  callerAgentId: z.string(),
  requireParentOwnership: z.boolean(),
  hasSeenRunning: z.boolean(),
  notifiedPermissionRequestIds: z.array(z.string()),
  pending: z.array(FinishNotificationPendingRecordSchema),
});

/** Validate a checkpointed batch of watches before claiming/restoring them. */
export const FinishNotificationWatchRecordsSchema = z.array(FinishNotificationWatchRecordSchema);

interface ActiveFinishNotificationWatch {
  capture(): FinishNotificationWatchRecord;
  /** Reattempt whatever is still in `pending`, in delivery order. */
  flush(): void;
  /** Resolves once every currently in-flight delivery attempt has settled. */
  drain(): Promise<void>;
}

// Scoped per AgentManager instance (not a bare module map) so independent
// daemons/tests never see each other's watches.
const watchesByManager = new WeakMap<AgentManager, Map<string, ActiveFinishNotificationWatch>>();

function getWatchRegistry(agentManager: AgentManager): Map<string, ActiveFinishNotificationWatch> {
  let registry = watchesByManager.get(agentManager);
  if (!registry) {
    registry = new Map();
    watchesByManager.set(agentManager, registry);
  }
  return registry;
}

/**
 * Every finish-notification watch currently armed on this manager, for
 * checkpointing before a controlled restart. A watch stays capturable until
 * its last pending delivery is confirmed — including after its subscription
 * has stopped — so a completion obligation is never silently dropped
 * mid-restart.
 */
export function snapshotFinishNotificationWatches(
  agentManager: AgentManager,
): FinishNotificationWatchRecord[] {
  const registry = watchesByManager.get(agentManager);
  return registry ? [...registry.values()].map((watch) => watch.capture()) : [];
}

/**
 * Reattempt every still-pending notification on this manager. Call once the
 * daemon has resumed normal admission after a restart — restored watches
 * hold their pending delivery rather than sending it while the manager is
 * still frozen.
 */
export function retryPendingFinishNotifications(agentManager: AgentManager): void {
  const registry = watchesByManager.get(agentManager);
  for (const watch of registry?.values() ?? []) {
    watch.flush();
  }
}

/**
 * Wait for every watch's in-flight delivery to settle. Call this before
 * `snapshotFinishNotificationWatches` as part of restart preparation: a
 * delivery already accepted by the caller agent must not still be sitting in
 * `pending` when the checkpoint is taken, or restore would send it again.
 */
export async function drainFinishNotificationWatches(agentManager: AgentManager): Promise<void> {
  const registry = watchesByManager.get(agentManager);
  if (!registry) return;
  await Promise.all([...registry.values()].map((watch) => watch.drain()));
}

export interface RestoreFinishNotificationWatchParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

/**
 * Rebuild a watch from a captured record after restart: reattaches its
 * subscription with the original observed-run/permission state and resumes
 * any delivery that had not been confirmed before the checkpoint was taken.
 * Never re-derives `pending` from current agent state — a restart suspension
 * must not manufacture or lose a completion notification.
 */
export function restoreFinishNotificationWatch(
  params: RestoreFinishNotificationWatchParams,
  record: FinishNotificationWatchRecord,
): void {
  setupFinishNotificationWatch(
    {
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      childAgentId: record.childAgentId,
      callerAgentId: record.callerAgentId,
      requireParentOwnership: record.requireParentOwnership,
      logger: params.logger,
    },
    record,
  );
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  setupFinishNotificationWatch(params, null);
}

function setupFinishNotificationWatch(
  params: SetupFinishNotificationParams,
  initialState: FinishNotificationWatchRecord | null,
): void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    logger,
  } = params;
  const watchId = initialState?.watchId ?? randomUUID();
  let hasSeenRunning = initialState?.hasSeenRunning ?? false;
  let stopped = false;
  const notifiedPermissionRequestIds = new Set<string>(initialState?.notifiedPermissionRequestIds);
  let unsubscribe: (() => void) | null = null;
  const pending: FinishNotificationPendingRecord[] =
    initialState?.pending.map((entry) => Object.assign({}, entry)) ?? [];
  // In-flight lastAssistantMessage captures, keyed by pending entry id. Only
  // populated for entries created in this process; a restored entry already
  // carries its captured value and has nothing to await here.
  const pendingCaptures = new Map<string, Promise<void>>();
  let flushChain = Promise.resolve();
  const registry = getWatchRegistry(agentManager);

  function maybeRetire(): void {
    if (stopped && pending.length === 0) {
      registry.delete(watchId);
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    maybeRetire();
  }

  function removePending(id: string): void {
    const index = pending.findIndex((entry) => entry.id === id);
    if (index !== -1) pending.splice(index, 1);
  }

  async function deliver(entry: FinishNotificationPendingRecord): Promise<void> {
    const capture = pendingCaptures.get(entry.id);
    if (capture) {
      await capture;
      pendingCaptures.delete(entry.id);
    }
    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      removePending(entry.id);
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      removePending(entry.id);
      return;
    }
    const title = record?.title ?? childAgentId;
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason: entry.reason,
      lastAssistantMessage: entry.lastAssistantMessage,
      permissionRequest: entry.permissionRequest,
    });

    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: callerAgentId,
      prompt: formatSystemNotificationPrompt(body),
      // The pending record's own id, so a retried/restored delivery threads
      // through the same receipt/dedup identity as the original attempt.
      messageId: entry.id,
      activeTurnBehavior: "steer",
      unarchive: false,
      logger,
    });
    removePending(entry.id);
  }

  // Delivery keeps a failed entry in `pending` instead of dropping it — a
  // capture between attempts must still see it, and a later restore retries
  // it under its original stable id rather than firing a fresh notification.
  function flushPending(): void {
    flushChain = flushChain.then(async () => {
      // Explicit gate, independent of AdmissionGate: a callback invoked from
      // inside manager.resumeRestartCheckpoint (e.g. a live event on an
      // agent that already finished restoring) inherits restore authority
      // via AsyncLocalStorage, so an admission call it makes would be
      // accepted even while OTHER agents are still restoring. Hold every
      // entry — do not consume or partially attempt them — until the phase
      // is fully "running" again; retryPendingFinishNotifications() is what
      // flushes after that.
      if (agentManager.isRestartSuspended()) {
        // Delivery is held, but the lastAssistantMessage capture for every
        // currently-pending entry still must settle before this resolves —
        // drainFinishNotificationWatches() is what a restart snapshot waits
        // on, and a capture still in flight at that point would freeze the
        // entry's message as null forever (deliver() never recomputes it).
        await Promise.all(pendingCaptures.values());
        return;
      }
      // Snapshot before iterating: deliver() can splice `pending` mid-loop
      // (removePending), which would skip entries in a live for-of.
      for (const entry of Array.from(pending)) {
        try {
          await deliver(entry);
        } catch (error) {
          logger.error(
            { err: error, childAgentId, callerAgentId, reason: entry.reason },
            "Failed to notify caller agent",
          );
        }
      }
      maybeRetire();
      return;
    });
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    const entry: FinishNotificationPendingRecord = {
      id: randomUUID(),
      reason,
      permissionRequest: options.permissionRequest,
      // Captured once, now, from the live child — not inside deliver(),
      // which can run again on retry/restore after the child has unloaded
      // or moved on.
      lastAssistantMessage: null,
    };
    // Push before stop(): stop() can retire the watch from the registry when
    // nothing is pending, and this entry must count as pending before that
    // check runs, or a terminal notification (the common case) would retire
    // itself out of the checkpoint before it was ever queued.
    pending.push(entry);
    const capture = agentManager
      .getLastAssistantMessage(childAgentId)
      .then((message) => {
        entry.lastAssistantMessage = message;
        return;
      })
      .catch((error) => {
        logger.warn(
          { err: error, childAgentId, callerAgentId, reason },
          "Failed to capture last assistant message for finish notification",
        );
      });
    pendingCaptures.set(entry.id, capture);
    if (options.terminal ?? true) stop();
    flushPending();
  }

  registry.set(watchId, {
    capture: () => ({
      watchId,
      childAgentId,
      callerAgentId,
      requireParentOwnership,
      hasSeenRunning,
      notifiedPermissionRequestIds: [...notifiedPermissionRequestIds],
      pending: pending.map((entry) => Object.assign({}, entry)),
    }),
    flush: flushPending,
    drain: () => flushChain,
  });

  // A restored watch's leftover pending delivery is NOT flushed here: the
  // manager is still frozen mid-restart when watches are reattached. The
  // restart driver calls retryPendingFinishNotifications() once admission
  // reopens, via this same registered `flush`.

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }

      if (event.type === "agent_state") {
        for (const requestId of notifiedPermissionRequestIds) {
          if (!event.agent.pendingPermissions.has(requestId)) {
            notifiedPermissionRequestIds.delete(requestId);
          }
        }
        if (event.agent.lifecycle === "running") {
          if (event.agent.pendingPermissions.size === 0) {
            hasSeenRunning = true;
          }
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifySafely("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          notifySafely("finished");
          return;
        }
        if (event.agent.lifecycle === "closed") {
          notifySafely("was closed");
          return;
        }
        return;
      }

      if (event.type === "timeline_replacement") {
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    stop();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notifySafely("errored");
  }
}
