import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AgentClient, AgentSession, AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "./fake-agent-client.js";

/** Deterministic provider boundary; the daemon, sockets, and checkpoint files remain real. */
export function createCheckpointAgentClient(logFile?: string): AgentClient {
  const base = createTestAgentClient("codex", { supportsMcpServers: true });
  const attach = (session: AgentSession, resumed: boolean): AgentSession => {
    const listeners = new Set<(event: AgentStreamEvent) => void>();
    let active: string | undefined;
    let closed = false;
    const emit = (event: AgentStreamEvent) => {
      for (const listener of listeners) listener(event);
    };
    session.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    session.startTurn = async (prompt, options) => {
      if (closed) throw new Error("Cannot start a closed provider");
      const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      const turnId = randomUUID();
      active = turnId;
      if (logFile)
        await appendFile(
          logFile,
          JSON.stringify({
            sessionId: session.id,
            resumed,
            text,
            messageId: options?.clientMessageId,
          }) + "\n",
        );
      emit({ type: "turn_started", provider: "codex", turnId });
      emit({
        type: "timeline",
        provider: "codex",
        turnId,
        item: {
          type: "user_message",
          text,
          ...(options?.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
        },
      });
      emit({
        type: "timeline",
        provider: "codex",
        turnId,
        item: { type: "assistant_message", text: resumed ? "continued-output" : "partial-output" },
      });
      if (resumed || text === "finish") {
        emit({ type: "turn_completed", provider: "codex", turnId });
        active = undefined;
      }
      return { turnId };
    };
    session.interrupt = async () => {
      if (active)
        emit({
          type: "turn_canceled",
          provider: "codex",
          turnId: active,
          reason: "user interrupt",
        });
      active = undefined;
    };
    session.steerActiveTurn = async (prompt, options) => {
      if (!active || options.expectedTurnId !== active) return { status: "unavailable" };
      emit({
        type: "timeline",
        provider: "codex",
        turnId: active,
        item: {
          type: "user_message",
          text: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
          clientMessageId: options.clientMessageId,
        },
      });
      return { status: "accepted" };
    };
    session.close = async () => {
      if (closed) return;
      closed = true;
      if (active) {
        // Deliberately emits during close, after the normal streaming callback returned.
        await Promise.resolve();
        emit({
          type: "timeline",
          provider: "codex",
          turnId: active,
          item: { type: "assistant_message", text: "late-close-output" },
        });
        emit({
          type: "turn_canceled",
          provider: "codex",
          turnId: active,
          reason: "provider closed",
        });
      }
      active = undefined;
    };
    session.streamHistory = async function* () {
      if (resumed)
        throw new Error("Checkpoint history must never be overwritten by native hydration");
      yield* [];
    };
    return session;
  };
  return {
    ...base,
    provider: base.provider,
    capabilities: base.capabilities,
    createSession: async (...args) => attach(await base.createSession(...args), false),
    resumeSession: async (...args) => attach(await base.resumeSession(...args), true),
    fetchCatalog: (...args) => base.fetchCatalog(...args),
    isAvailable: () => base.isAvailable(),
  };
}
