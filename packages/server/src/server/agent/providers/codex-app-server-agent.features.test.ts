import { tmpdir } from "node:os";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { AgentManager } from "../agent-manager.js";
import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { CODEX_DAYBREAK_MODEL_IDS } from "./codex-feature-definitions.js";
import {
  createFakeCodexAppServer,
  waitForNextEvent,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const CODEX_PROVIDER = "codex";

interface CollaborationModeRecord {
  name: string;
  mode?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  developer_instructions?: string | null;
}

const TEST_SPEED_MODELS = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
].map((id) => ({
  id,
  isDefault: id === "gpt-5.4",
  defaultReasoningEffort: "medium",
  serviceTiers: [{ id: "priority", name: "Fast", description: "Faster processing" }],
}));

function speedFeature(value: string) {
  return {
    type: "select",
    id: "service_tier",
    label: "Speed",
    description: "Choose processing speed. Faster tiers increase usage.",
    tooltip: "Select speed",
    icon: "zap",
    desktopTrigger: "icon",
    value,
    options: [
      { id: "default", label: "Normal", isDefault: true },
      { id: "priority", label: "Fast" },
    ],
  };
}

function daybreakFeature(options: { value?: boolean; unavailableFor?: string } = {}) {
  return {
    type: "toggle",
    id: "daybreak",
    label: "Daybreak",
    description: "Request Daybreak Blue cyber access for new turns",
    tooltip: "Toggle Daybreak",
    icon: "hat-glasses",
    value: options.value ?? false,
    ...(options.unavailableFor
      ? { disabledReason: `Daybreak is not available for ${options.unavailableFor}` }
      : {}),
  };
}

const TEST_COLLABORATION_MODES: CollaborationModeRecord[] = [
  {
    name: "Code",
    mode: "code",
    developer_instructions: "Built-in code mode",
  },
  {
    name: "Plan",
    mode: "plan",
    developer_instructions: "Built-in plan mode",
  },
];

type CodexFeaturesTestSession = AgentSession;

interface CapturedLogEntry {
  level?: number;
  msg?: string;
  [key: string]: unknown;
}

function createCapturedLogger(): { logger: pino.Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const logger = pino(
    { level: "debug" },
    {
      write(line: string) {
        entries.push(JSON.parse(line) as CapturedLogEntry);
      },
    },
  );
  return { logger, entries };
}

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: CODEX_PROVIDER,
    cwd: "/tmp/codex-fast-mode-test",
    modeId: "auto",
    model: "gpt-5.4",
    ...overrides,
  };
}

function createSessionHarness(
  configOverrides: Partial<AgentSessionConfig> = {},
  options: { logger?: pino.Logger; models?: unknown[] } = {},
): {
  session: CodexFeaturesTestSession;
  appServer: FakeCodexAppServer;
} {
  const config = createConfig(configOverrides);
  const appServer = createFakeCodexAppServer({
    "collaborationMode/list": () => ({ data: TEST_COLLABORATION_MODES }),
    "model/list": () => ({ data: options.models ?? TEST_SPEED_MODELS }),
  });
  const session = new CodexAppServerAgentSession(
    { ...config, provider: CODEX_PROVIDER },
    null,
    options.logger ?? createTestLogger(),
    async () => appServer.child,
  ) as CodexFeaturesTestSession;
  return { session, appServer };
}

async function createConnectedSession(
  configOverrides: Partial<AgentSessionConfig> = {},
  options: { logger?: pino.Logger; models?: unknown[] } = {},
): Promise<{
  session: CodexFeaturesTestSession;
  appServer: FakeCodexAppServer;
}> {
  const harness = createSessionHarness(configOverrides, options);
  await harness.session.connect();
  harness.appServer.assertNoErrors();
  return harness;
}

describe("Codex app-server provider features", () => {
  test("GPT-6.1 Sol offers catalog speed tiers and sends Ultrafast", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "gpt-6.1-sol" },
      {
        models: [
          {
            id: "gpt-6.1-sol",
            serviceTiers: [
              { id: "priority", name: "Fast", description: "Faster processing" },
              { id: "ultrafast", name: "Ultrafast", description: "Lowest latency" },
            ],
          },
        ],
      },
    );
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          type: "select",
          value: "default",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "priority", label: "Fast" },
            { id: "ultrafast", label: "Ultrafast" },
          ],
        }),
      );
      await session.setFeature?.("service_tier", "ultrafast");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "ultrafast",
      });
    } finally {
      await session.close();
    }
  });

  test("new models and service tiers work without a Paseo catalog update", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "future-codex-model" },
      {
        models: [
          {
            id: "future-codex-model",
            serviceTiers: [
              { id: "future-tier", name: "Future speed", description: "A newly advertised tier" },
            ],
          },
        ],
      },
    );
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "future-tier", label: "Future speed" },
          ],
        }),
      );
      await session.setFeature?.("service_tier", "future-tier");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        model: "future-codex-model",
        serviceTier: "future-tier",
      });
    } finally {
      await session.close();
    }
  });

  test.each(["priority", "ultrafast"])(
    "restores %s and Normal explicitly overrides an existing thread tier",
    async (tier) => {
      const { session, appServer } = await createConnectedSession(
        { model: "future-model", featureValues: { service_tier: tier } },
        {
          models: [
            {
              id: "future-model",
              serviceTiers: [
                { id: "priority", name: "Fast", description: "Fast processing" },
                { id: "ultrafast", name: "Ultrafast", description: "Ultra processing" },
              ],
            },
          ],
        },
      );
      try {
        expect(session.features).toContainEqual(
          expect.objectContaining({ id: "service_tier", value: tier }),
        );
        await session.getRuntimeInfo();
        await session.setFeature?.("service_tier", "default");
        await session.startTurn("hello");
        await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
          serviceTier: "default",
        });
      } finally {
        await session.close();
      }
    },
  );

  test("rejects unadvertised tiers and non-string values", async () => {
    const { session } = await createConnectedSession();
    try {
      for (const value of ["ultrafast", "bogus", true, null]) {
        await expect(session.setFeature?.("service_tier", value)).rejects.toThrow(
          "is not available",
        );
      }
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
    } finally {
      await session.close();
    }
  });

  test("switching to a model without the selected tier resets speed", async () => {
    const { session, appServer } = await createConnectedSession(
      { model: "ultra-model", featureValues: { service_tier: "ultrafast" } },
      {
        models: [
          {
            id: "ultra-model",
            serviceTiers: [{ id: "ultrafast", name: "Ultrafast", description: "Ultra processing" }],
          },
          ...TEST_SPEED_MODELS,
        ],
      },
    );
    try {
      await session.setModel("gpt-6.1-sol");
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "service_tier", value: "default" }),
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({ serviceTier: "default" });
    } finally {
      await session.close();
    }
  });

  test("maps legacy Fast commands to the catalog's request id", async () => {
    const { session, appServer } = await createConnectedSession();
    try {
      await session.setFeature?.("fast_mode", true);
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "priority",
      });
    } finally {
      await session.close();
    }
  });

  test.each([
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
  ])("exposes and sends Fast for %s", async (model) => {
    const { session, appServer } = await createConnectedSession({ model });
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          value: "default",
        }),
      );
      await session.setFeature?.("service_tier", "priority");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        model,
        serviceTier: "priority",
      });
    } finally {
      await session.close();
    }
  });

  test.each([
    "gpt-5.3-codex-spark",
    "gpt-5.3-codex",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5-pro",
    "gpt-5",
    "gpt-4.1",
    "o3",
    "o4-mini",
    "gpt-6-unknown",
  ])("does not expose or restore Fast for %s", async (model) => {
    const { session, appServer } = await createConnectedSession({
      model,
      featureValues: { fast_mode: true },
    });
    try {
      expect(session.features.map((feature) => feature.id)).toEqual(["plan_mode", "daybreak"]);
      await expect(session.setFeature?.("fast_mode", true)).rejects.toThrow(
        `Codex fast mode is not available for model '${model}'`,
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "default",
      });
    } finally {
      await session.close();
    }
  });

  test("restores Fast on Astra and preserves it when switching supported models", async () => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-6-astra",
      featureValues: { fast_mode: true },
    });
    try {
      expect(session.features).toContainEqual(
        expect.objectContaining({
          id: "service_tier",
          value: "priority",
        }),
      );
      await session.setModel("gpt-5.6-sol");
      await session.setModel("gpt-6-astra");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        model: "gpt-6-astra",
        serviceTier: "priority",
      });
    } finally {
      await session.close();
    }
  });

  test("features returns speed selector, plan toggle and Daybreak when supported", async () => {
    const { session } = await createConnectedSession();

    expect(session.features).toEqual([
      speedFeature("default"),
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: false,
      },
      daybreakFeature({ unavailableFor: "gpt-5.4" }),
    ]);

    await session.setFeature?.("service_tier", "priority");
    await session.setFeature?.("plan_mode", true);

    expect(session.features).toEqual([
      speedFeature("priority"),
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: true,
      },
      daybreakFeature({ unavailableFor: "gpt-5.4" }),
    ]);
  });

  test("features omit speed when model does not support fast mode", async () => {
    const { session } = await createConnectedSession({ model: "gpt-3.5-turbo" });

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: false,
      },
      daybreakFeature({ unavailableFor: "gpt-3.5-turbo" }),
    ]);
  });

  test("constructor ignores restored fast mode when model does not support it", async () => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-3.5-turbo",
      featureValues: { fast_mode: true },
    });

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: false,
      },
      daybreakFeature({ unavailableFor: "gpt-3.5-turbo" }),
    ]);

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
    });
  });

  test("selecting Fast sends the catalog service tier", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("service_tier", "priority");
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
    });
  });

  test("legacy Fast off explicitly selects Normal", async () => {
    const { session, appServer } = await createConnectedSession({
      featureValues: { fast_mode: true },
    });

    await session.setFeature?.("fast_mode", false);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
    });
  });

  test("setFeature('fast_mode', true) rejects models that do not support fast mode", async () => {
    const { session } = await createConnectedSession({ model: "gpt-3.5-turbo" });

    await expect(session.setFeature?.("fast_mode", true)).rejects.toThrow(
      "Codex fast mode is not available for model 'gpt-3.5-turbo'",
    );
  });

  test("setFeature invalidates runtime info", async () => {
    const { session } = await createConnectedSession();

    await expect(session.getRuntimeInfo()).resolves.not.toMatchObject({
      extra: { collaborationMode: "Plan" },
    });

    await session.setFeature?.("plan_mode", true);

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      extra: { collaborationMode: "Plan" },
    });
  });

  test("setFeature throws for unknown feature ids", async () => {
    const { session } = createSessionHarness();

    await expect(session.setFeature?.("unknown_feature", true)).rejects.toThrow(
      "Unknown Codex feature: unknown_feature",
    );
  });

  test("constructor restores feature flags from config.featureValues", async () => {
    const { session, appServer } = await createConnectedSession({
      featureValues: { fast_mode: true, plan_mode: true },
    });

    expect(session.features).toEqual([
      speedFeature("priority"),
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: true,
      },
      daybreakFeature({ unavailableFor: "gpt-5.4" }),
    ]);

    await session.startTurn("hello");
    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
      collaborationMode: expect.objectContaining({
        mode: "plan",
      }),
    });
  });

  test("startTurn includes serviceTier when fast mode is enabled", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("service_tier", "priority");
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "priority",
    });
  });

  test("startTurn logs a sanitized turn/start summary for fast mode observability", async () => {
    const capture = createCapturedLogger();
    const prompt = "secret prompt text should not be logged";
    const { session } = await createConnectedSession(
      { featureValues: { fast_mode: true } },
      { logger: capture.logger },
    );

    await session.startTurn(prompt);

    const entry = capture.entries.find(
      (candidate) => candidate.msg === "Starting Codex app-server turn",
    );
    expect(entry).toMatchObject({
      level: 30,
      msg: "Starting Codex app-server turn",
      model: "gpt-5.4",
      modeId: "auto",
      serviceTier: "priority",
      cwd: "/tmp/codex-fast-mode-test",
    });
    expect(JSON.stringify(entry)).not.toContain(prompt);
  });

  test("setModel clears fast mode when switching to an unsupported model", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("service_tier", "priority");
    await session.setModel("gpt-3.5-turbo");

    expect(session.features).toEqual([
      {
        type: "toggle",
        id: "plan_mode",
        label: "Plan",
        description: "Switch Codex into planning-only collaboration mode",
        tooltip: "Toggle plan mode",
        icon: "list-todo",
        value: false,
      },
      daybreakFeature({ unavailableFor: "gpt-3.5-turbo" }),
    ]);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      serviceTier: "default",
    });
  });

  test("startTurn switches collaboration mode when plan mode is enabled", async () => {
    const { session, appServer } = await createConnectedSession();

    await session.setFeature?.("plan_mode", true);
    await session.startTurn("hello");

    await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
      collaborationMode: expect.objectContaining({
        mode: "plan",
      }),
    });
  });
});

describe("Codex Daybreak", () => {
  const ON = { type: "notification", level: "info", message: "Daybreak is on for new turns." };
  const OFF = { type: "notification", level: "info", message: "Daybreak is off." };

  function turnStarts(appServer: FakeCodexAppServer): unknown[] {
    return appServer
      .requests()
      .filter((request) => request.method === "turn/start")
      .map((request) => request.params);
  }

  function metadataUpdates(appServer: FakeCodexAppServer): unknown[] {
    return appServer
      .requests()
      .filter((request) => request.method === "thread/metadata/update")
      .map((request) => request.params);
  }

  async function finishTurn(session: AgentSession, appServer: FakeCodexAppServer): Promise<void> {
    const finished = waitForNextEvent(session, "turn_completed");
    appServer.completeTurn();
    await finished;
  }

  function userMessage(text: string) {
    return { type: "userMessage", id: text, content: [{ type: "text", text }] };
  }

  // Serves each thread's turns from thread/read, as Codex does for legacy threads.
  function readThreads(turnsByThread: Record<string, unknown[]>) {
    return (params: unknown) => {
      const { threadId } = params as { threadId: string };
      return { thread: { id: threadId, turns: turnsByThread[threadId] } };
    };
  }

  function collectNotices(session: AgentSession): unknown[] {
    const notices: unknown[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item);
      }
    });
    return notices;
  }

  const CUSTOM_PROVIDER = {
    customCodexConfig: {
      model_provider: "paseo:proxy",
      model_providers: { "paseo:proxy": { base_url: "https://proxy.example/v1" } },
    },
  };

  function resumeThread(input: {
    threadChoice: boolean | null;
    threadId?: string;
    model?: string;
    featureValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    handlers?: Record<string, (params: unknown) => unknown>;
    deps?: typeof CUSTOM_PROVIDER;
  }) {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({ data: TEST_SPEED_MODELS }),
      "thread/resume": () => ({ thread: { id: "thread-1", daybreakEnabled: input.threadChoice } }),
      ...input.handlers,
    });
    const session = new CodexAppServerAgentSession(
      createConfig({ model: input.model ?? "gpt-6-sol", featureValues: input.featureValues }),
      { sessionId: input.threadId ?? "thread-1", metadata: input.metadata },
      createTestLogger(),
      async () => appServer.child,
      input.deps,
    );
    return { session, appServer };
  }

  test.each(CODEX_DAYBREAK_MODEL_IDS)(
    "enables Daybreak on %s and sends Daybreak Blue",
    async (model) => {
      const { session, appServer } = await createConnectedSession({
        model,
        featureValues: { daybreak: true },
      });
      try {
        expect(session.features).toContainEqual(daybreakFeature({ value: true }));
        await session.startTurn("hello");
        await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
          model,
          cyberAccessProgram: "daybreakBlue",
        });
      } finally {
        await session.close();
      }
    },
  );

  test.each(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"])(
    "shows Daybreak disabled on %s and sends no program",
    async (model) => {
      const { session, appServer } = await createConnectedSession({
        model,
        featureValues: { daybreak: true },
      });
      try {
        expect(session.features).toContainEqual(
          daybreakFeature({ value: true, unavailableFor: model }),
        );
        await session.startTurn("hello");
        expect(await appServer.waitForTurnStart()).not.toHaveProperty("cyberAccessProgram");
      } finally {
        await session.close();
      }
    },
  );

  test("matches exact model ids and names the model by its catalog label", async () => {
    const { session } = await createConnectedSession(
      { model: "gpt-6-sol-mini" },
      { models: [{ id: "gpt-6-sol-mini", displayName: "gpt-6-sol mini" }] },
    );
    try {
      expect(session.features).toContainEqual(
        daybreakFeature({ unavailableFor: "GPT-6-sol mini" }),
      );
    } finally {
      await session.close();
    }
  });

  test("keeps the choice across incompatible models and applies it to the next turn", async () => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-6-sol",
      featureValues: { daybreak: true },
    });
    const notices = collectNotices(session);
    try {
      await session.setModel("gpt-6.1-sol");
      expect(session.features).toContainEqual(
        daybreakFeature({ value: true, unavailableFor: "gpt-6.1-sol" }),
      );
      await session.startTurn("incompatible model");
      await finishTurn(session, appServer);

      await session.setModel("gpt-6-sol");
      expect(session.features).toContainEqual(daybreakFeature({ value: true }));
      await session.startTurn("compatible model");

      const [incompatible, compatible] = turnStarts(appServer);
      expect(incompatible).not.toHaveProperty("cyberAccessProgram");
      expect(compatible).toMatchObject({ model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" });
      expect(notices).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("off by default leaves the thread and turn program to Codex", async () => {
    const { session, appServer } = await createConnectedSession({ model: "gpt-6-sol" });
    try {
      expect(session.features).toContainEqual(daybreakFeature());
      await session.startTurn("hello");
      expect(await appServer.waitForRequest("thread/start")).not.toHaveProperty("daybreakEnabled");
      expect(await appServer.waitForTurnStart()).not.toHaveProperty("cyberAccessProgram");
    } finally {
      await session.close();
    }
  });

  test.each([true, false])("new threads start with the saved choice %s", async (daybreak) => {
    const { session, appServer } = await createConnectedSession({
      model: "gpt-6-sol",
      featureValues: { daybreak },
    });
    try {
      await session.startTurn("hello");
      await expect(appServer.waitForRequest("thread/start")).resolves.toMatchObject({
        daybreakEnabled: daybreak,
      });
    } finally {
      await session.close();
    }
  });

  test("ephemeral threads omit the thread choice but turns still request Daybreak", async () => {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({ data: TEST_SPEED_MODELS }),
    });
    const session = new CodexAppServerAgentSession(
      createConfig({ model: "gpt-6-sol", featureValues: { daybreak: true } }),
      null,
      createTestLogger(),
      async () => appServer.child,
      {},
      true,
    );
    try {
      await session.startTurn("hello");
      const threadStart = await appServer.waitForRequest("thread/start");
      expect(threadStart).toMatchObject({ ephemeral: true });
      expect(threadStart).not.toHaveProperty("daybreakEnabled");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        cyberAccessProgram: "daybreakBlue",
      });
      await session.setFeature?.("daybreak", false);
      expect(metadataUpdates(appServer)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("toggling saves the choice on the thread and applies to the next turn", async () => {
    const { session, appServer } = await createConnectedSession({ model: "gpt-6-sol" });
    try {
      await session.startTurn("before");
      await finishTurn(session, appServer);

      await session.setFeature?.("daybreak", true);
      expect(metadataUpdates(appServer)).toEqual([{ threadId: "thread-1", daybreakEnabled: true }]);
      expect(session.features).toContainEqual(daybreakFeature({ value: true }));
      await session.startTurn("after");

      const [before, after] = turnStarts(appServer);
      expect(before).not.toHaveProperty("cyberAccessProgram");
      expect(after).toMatchObject({ cyberAccessProgram: "daybreakBlue" });
      appServer.assertNoErrors();
    } finally {
      await session.close();
    }
  });

  test("each change posts one chat notice; restores and same-value changes post none", async () => {
    const { session, appServer } = createSessionHarness({
      model: "gpt-6-sol",
      featureValues: { daybreak: true },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.connect();
      await session.setFeature?.("daybreak", true);
      await session.setFeature?.("daybreak", false);
      await session.setFeature?.("daybreak", false);
      await session.setFeature?.("daybreak", true);

      const timeline = events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
      expect(timeline).toEqual([OFF, ON]);
      appServer.assertNoErrors();
    } finally {
      await session.close();
    }
  });

  test("explicitly turning off an unset choice posts no notice", async () => {
    const { session } = await createConnectedSession({ model: "gpt-6-sol" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.setFeature?.("daybreak", false);
      expect(events).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("turning Daybreak on for an incompatible model warns that it is not available", async () => {
    const { session } = resumeThread({ threadChoice: null, model: "gpt-6.1-sol" });
    const notices = collectNotices(session);
    try {
      await session.connect();
      await session.setFeature?.("daybreak", true);
      await session.setFeature?.("daybreak", false);
      expect(notices).toEqual([
        {
          type: "notification",
          level: "warning",
          message: "Daybreak is on, but not available for gpt-6.1-sol.",
        },
        OFF,
      ]);
      expect(session.describePersistence()?.metadata?.daybreakNotices).toEqual([
        { enabled: true, timestamp: expect.any(String), unavailableFor: "gpt-6.1-sol" },
        { enabled: false, timestamp: expect.any(String) },
      ]);
    } finally {
      await session.close();
    }
  });

  test("a failed thread save keeps the choice for the next turn", async () => {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({ data: TEST_SPEED_MODELS }),
      "thread/metadata/update": () => Promise.reject(new Error("metadata store unavailable")),
    });
    const session = new CodexAppServerAgentSession(
      createConfig({ model: "gpt-6-sol" }),
      null,
      createTestLogger(),
      async () => appServer.child,
    );
    try {
      await session.startTurn("before");
      await finishTurn(session, appServer);
      await session.setFeature?.("daybreak", true);
      expect(metadataUpdates(appServer)).toEqual([{ threadId: "thread-1", daybreakEnabled: true }]);
      expect(session.features).toContainEqual(daybreakFeature({ value: true }));
      await session.startTurn("after");
      expect(turnStarts(appServer)[1]).toMatchObject({ cyberAccessProgram: "daybreakBlue" });
    } finally {
      await session.close();
    }
  });

  test("rejects values other than on or off", async () => {
    const { session } = await createConnectedSession({ model: "gpt-6-sol" });
    try {
      await expect(session.setFeature?.("daybreak", "true")).rejects.toThrow(
        "Codex Daybreak must be on or off",
      );
    } finally {
      await session.close();
    }
  });

  test("custom Codex providers do not offer Daybreak", async () => {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({ data: TEST_SPEED_MODELS }),
    });
    const session = new CodexAppServerAgentSession(
      createConfig({ model: "gpt-6-sol", featureValues: { daybreak: true } }),
      null,
      createTestLogger(),
      async () => appServer.child,
      CUSTOM_PROVIDER,
    );
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("daybreak");
      await expect(session.setFeature?.("daybreak", true)).rejects.toThrow(
        "Unknown Codex feature: daybreak",
      );
      await session.startTurn("hello");
      expect(await appServer.waitForRequest("thread/start")).not.toHaveProperty("daybreakEnabled");
      expect(await appServer.waitForTurnStart()).not.toHaveProperty("cyberAccessProgram");
      expect(metadataUpdates(appServer)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("custom Codex providers leave a resumed thread's choice alone", async () => {
    const { session, appServer } = resumeThread({
      threadChoice: true,
      featureValues: { daybreak: false },
      deps: CUSTOM_PROVIDER,
    });
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("daybreak");
      await session.startTurn("hello");
      expect(await appServer.waitForTurnStart()).not.toHaveProperty("cyberAccessProgram");
      expect(metadataUpdates(appServer)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("a resumed thread's choice applies when Paseo has none", async () => {
    const { session, appServer } = resumeThread({ threadChoice: true });
    const notices = collectNotices(session);
    try {
      await session.connect();
      expect(session.features).toContainEqual(daybreakFeature({ value: true }));
      expect(metadataUpdates(appServer)).toEqual([]);
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        cyberAccessProgram: "daybreakBlue",
      });
      expect(notices).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("Paseo's saved choice wins and is saved on the resumed thread", async () => {
    const { session, appServer } = resumeThread({
      threadChoice: true,
      featureValues: { daybreak: false },
    });
    try {
      await session.connect();
      expect(session.features).toContainEqual(daybreakFeature());
      expect(metadataUpdates(appServer)).toEqual([
        { threadId: "thread-1", daybreakEnabled: false },
      ]);
    } finally {
      await session.close();
    }
  });

  test("rewind saves the choice on the forked thread", async () => {
    const turns = [
      { id: "earlier-turn", items: [userMessage("earlier")] },
      { id: "removed-turn", items: [userMessage("rewind-here")] },
    ];
    const { session, appServer } = resumeThread({
      threadChoice: true,
      featureValues: { daybreak: true },
      handlers: {
        "thread/read": readThreads({ "thread-1": turns, "forked-thread": turns.slice(0, 1) }),
      },
    });
    try {
      await session.connect();
      await session.revertConversation?.({ messageId: "rewind-here" });
      expect(metadataUpdates(appServer)).toEqual([
        { threadId: "forked-thread", daybreakEnabled: true },
      ]);
    } finally {
      await session.close();
    }
  });

  test("chat notices persist with the thread and return in rebuilt history by time", async () => {
    const now = Date.now() / 1000;
    const first = resumeThread({ threadChoice: null });
    let metadata: Record<string, unknown> | undefined;
    try {
      await first.session.connect();
      await first.session.setFeature?.("daybreak", true);
      metadata = first.session.describePersistence()?.metadata;
    } finally {
      await first.session.close();
    }
    expect(metadata?.daybreakNotices).toEqual([{ enabled: true, timestamp: expect.any(String) }]);

    const second = resumeThread({
      threadChoice: true,
      featureValues: { daybreak: true },
      metadata,
      handlers: {
        "thread/read": readThreads({
          "thread-1": [
            { id: "earlier", startedAt: now - 3600, items: [userMessage("earlier")] },
            { id: "later", startedAt: now + 3600, items: [userMessage("later")] },
          ],
        }),
      },
    });
    try {
      await second.session.connect();
      const history: unknown[] = [];
      for await (const event of second.session.streamHistory()) {
        if (event.type === "timeline") history.push(event.item);
      }
      expect(history).toEqual([
        expect.objectContaining({ type: "user_message", text: "earlier" }),
        ON,
        expect.objectContaining({ type: "user_message", text: "later" }),
      ]);
    } finally {
      await second.session.close();
    }
  });

  test("the manager stores one notice per change and keeps it after a history rebuild", async () => {
    const turns = [
      { id: "first-turn", items: [userMessage("first")] },
      { id: "second-turn", items: [userMessage("second")] },
    ];
    // Rewinding to the first message leaves a forked thread without turns.
    const handlers = { "thread/read": readThreads({ "thread-1": turns, "forked-thread": [] }) };
    const { session } = resumeThread({ threadChoice: null, handlers });
    await session.connect();
    const manager = new AgentManager({
      clients: {
        codex: {
          provider: "codex",
          capabilities: session.capabilities,
          createSession: async () => session,
          resumeSession: async (handle) => {
            const resumed = resumeThread({
              threadChoice: null,
              threadId: handle.sessionId,
              metadata: handle.metadata,
              handlers,
            }).session;
            await resumed.connect();
            return resumed;
          },
          isAvailable: async () => true,
          fetchCatalog: async () => ({ models: [], modes: [] }),
        },
      },
      logger: createTestLogger(),
    });
    const agent = await manager.createAgent(
      { provider: "codex", cwd: tmpdir(), model: "gpt-6-sol" },
      undefined,
      { workspaceId: undefined },
    );
    const notices = () =>
      manager.getTimeline(agent.id).filter((item) => item.type === "notification");
    // Reload agent and rewind replace the chat with the Codex thread's history.
    async function reloadAgent(): Promise<void> {
      await manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
      await manager.hydrateTimelineFromProvider(agent.id);
    }
    try {
      await manager.setAgentFeature(agent.id, "daybreak", true);
      await manager.setAgentFeature(agent.id, "daybreak", true);
      expect(notices()).toEqual([ON]);
      expect(manager.getAgent(agent.id)?.persistence?.metadata?.daybreakNotices).toEqual([
        { enabled: true, timestamp: expect.any(String) },
      ]);

      await reloadAgent();
      expect(manager.getTimeline(agent.id)).toEqual([
        expect.objectContaining({ type: "user_message", text: "first" }),
        expect.objectContaining({ type: "user_message", text: "second" }),
        ON,
      ]);

      await manager.rewind(agent.id, "first", "conversation");
      expect(manager.getTimeline(agent.id)).toEqual([ON]);
      await reloadAgent();
      expect(manager.getTimeline(agent.id)).toEqual([ON]);
    } finally {
      await manager.closeAgent(agent.id);
    }
  });
});
