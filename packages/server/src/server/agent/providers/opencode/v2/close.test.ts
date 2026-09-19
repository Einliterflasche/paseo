import { describe, expect, test } from "vitest";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";

describe("OpenCode v2 certified close", () => {
  test("retains an exited helper lease when reconnect cleanup fails", async () => {
    const first = new V2Harness();
    const second = new V2Harness(1);
    let exit!: (error: Error) => void;
    const exited = new Promise<Error>((resolve) => {
      exit = resolve;
    });
    let releases = 0;
    first.connection.release = async () => {
      if (++releases === 1) throw new Error("retired helper inspection failed");
    };
    let acquisitions = 0;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: {
        acquire: async () =>
          ++acquisitions === 1 ? { ...first.connection, exited } : second.connection,
        shutdown: async () => undefined,
      },
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      exit(new Error("helper exited"));
      await Promise.resolve();
      await expect(session.listCommands()).rejects.toThrow("retired helper inspection failed");
      await session.close();
      expect(releases).toBe(2);
      expect(second.releases).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("retains a failed lease and late output until a retry certifies closure", async () => {
    const harness = new V2Harness();
    let attempts = 0;
    harness.connection.release = async () => {
      if (++attempts === 1) throw new Error("tree inspection failed");
      harness.releases += 1;
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const text: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message")
        text.push(event.item.text);
    });
    try {
      await expect(session.close()).rejects.toThrow("tree inspection failed");
      await expect(session.startTurn("too late")).rejects.toThrow("closed");
      harness.push({
        id: "started",
        created: 2,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "last", ordinal: 0 },
      });
      harness.push({
        id: "late",
        created: 3,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "last",
          ordinal: 0,
          delta: "last accepted output",
        },
      });
      await expect.poll(() => text).toEqual(["last accepted output"]);
      await session.close();
      expect(attempts).toBe(2);
      expect(harness.releases).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("does not release a shared helper when its native session fails to stop", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let interrupts = 0;
    harness.interrupt = async () => {
      if (++interrupts === 1) throw new Error("native interruption failed");
      harness.finishExecution("interrupted");
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("active native work");
      await expect.poll(() => harness.active).toBe(true);
      await expect(session.close()).rejects.toThrow("native interruption failed");
      expect(harness.releases).toBe(0);
      expect(harness.active).toBe(true);
      await session.close();
      expect(harness.active).toBe(false);
      expect(harness.releases).toBe(1);
    } finally {
      await session.close();
    }
  });
});
