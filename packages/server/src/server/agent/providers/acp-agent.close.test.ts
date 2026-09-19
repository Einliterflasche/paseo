import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ACPAgentClient, ACPAgentSession } from "./acp-agent.js";
import type { AgentProbeContext, AgentStreamEvent } from "../agent-sdk-types.js";
import { COPILOT_AGENT_FEATURE_OPTION } from "./copilot-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { runProviderRefreshWithDeadline } from "../provider-refresh-deadline.js";

const peer = fileURLToPath(new URL("./acp/test-utils/closing-runtime.cjs", import.meta.url));

describe("ACP actual SDK output drain", () => {
  test.each(["unanswered", "completed", "failed", "already-dead"] as const)(
    "closes %s prompt without retaining an orphaned RPC receipt",
    async (mode) => {
      const session = new ACPAgentSession(
        { provider: "test-acp", cwd: process.cwd() },
        {
          provider: "test-acp",
          logger: createTestLogger(),
          defaultCommand: [process.execPath, peer],
          defaultModes: [],
          capabilities: {
            supportsStreaming: true,
            supportsSessionPersistence: true,
            supportsDynamicModes: false,
            supportsMcpServers: false,
            supportsReasoningStream: false,
            supportsToolInvocations: false,
          },
        },
      );
      const events: AgentStreamEvent[] = [];
      let ready!: () => void;
      const output = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let ended!: () => void;
      const nativeExit = new Promise<void>((resolve) => {
        ended = resolve;
      });
      const unsubscribe = session.subscribe((event) => {
        events.push(event);
        if (event.type === "turn_failed") ended();
        if (
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text === (mode === "already-dead" ? "final output" : "ready")
        )
          ready();
      });
      try {
        await session.initializeNewSession();
        const { turnId } = await session.startTurn(mode);
        await output;
        if (mode === "already-dead") await nativeExit;
        // An interrupt waiting for a native prompt reply must also settle once
        // physical termination and the final SDK output drain are certified.
        const interruption = mode === "unanswered" ? session.interrupt() : Promise.resolve();
        await Promise.all([session.close(), interruption]);
        const text = events.flatMap((event) =>
          event.type === "timeline" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        );
        expect(text).toEqual(["ready", "final output"]);
        const terminal = events.filter(
          (event) =>
            event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_canceled",
        );
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          type: {
            completed: "turn_completed",
            failed: "turn_failed",
            "already-dead": "turn_failed",
            unanswered: "turn_canceled",
          }[mode],
          turnId,
        });
        if (mode === "failed") expect(terminal[0]).toMatchObject({ error: "native failure" });
        await session.close();
      } finally {
        unsubscribe();
        await session.close();
      }
    },
  );
});

test.each(["session", "features", "catalog", "diagnostic", "recent"] as const)(
  "a stopped %s probe closes its owned process while initialize is unanswered",
  async (operation) => {
    const controller = new AbortController();
    const resources = new Set<{ close(): Promise<void> }>();
    let acquisitions = 0;
    let registered!: () => void;
    const registration = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const context: AgentProbeContext = {
      signal: controller.signal,
      own(resource) {
        resources.add(resource);
        acquisitions++;
        // Generic diagnostics finish their version command before the ACP probe.
        if (acquisitions === (operation === "diagnostic" ? 2 : 1)) registered();
        return () => {
          resources.delete(resource);
        };
      },
    };
    const client = new ACPAgentClient({
      provider: "test-acp",
      logger: createTestLogger(),
      defaultCommand: [process.execPath, peer, "hold-initialize"],
      configFeatureOptions: [COPILOT_AGENT_FEATURE_OPTION],
    });
    const config = { provider: "test-acp", cwd: process.cwd() };
    const operations = {
      session: () => client.createSession(config, undefined, { probe: context }),
      features: () => client.listFeatures(config, context),
      catalog: () =>
        runProviderRefreshWithDeadline({
          label: "ACP probe",
          timeoutMs: 10_000,
          probe: context,
          operation: (refresh) => client.fetchCatalog({ scope: "global", force: true }, refresh),
        }),
      diagnostic: () =>
        new GenericACPAgentClient({
          logger: createTestLogger(),
          command: [process.execPath, peer, "hold-initialize"],
        }).getDiagnostic(context),
      recent: () => client.listImportableSessions(undefined, context),
    };
    const probe = operations[operation]();
    const stopped = expect(probe).rejects.toThrow("probe stopped");
    await registration;
    expect(resources.size).toBe(1);
    controller.abort(new Error("probe stopped"));
    await Promise.all([...resources].map((resource) => resource.close()));
    await stopped;
    expect(resources.size).toBe(0);
  },
);
