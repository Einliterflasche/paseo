import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveStreamTurnTiming } from "./turn-time";
import type { StreamItem } from "@/types/stream";

function user(id: string, timestamp: Date): StreamItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp,
  };
}

function assistant(id: string, timestamp: Date): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp,
  };
}

function notice(id: string, timestamp: Date): StreamItem {
  return {
    kind: "notification",
    sourceType: "notification",
    id,
    timestamp,
    level: "info",
    message: id,
  };
}

describe("deriveStreamTurnTiming", () => {
  it("starts elapsed time from the submitted prompt", () => {
    const submittedAt = new Date("2026-05-15T00:00:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: submittedAt,
      tail: [],
      head: [user("submitted", submittedAt)],
    });

    assert.equal(timing.runningStartedAt, submittedAt);
  });

  it("uses the last user message as the running turn start", () => {
    const firstUserAt = new Date("2026-05-15T00:00:00.000Z");
    const secondUserAt = new Date("2026-05-15T00:01:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: secondUserAt,
      tail: [
        user("u1", firstUserAt),
        assistant("a1", new Date("2026-05-15T00:00:05.000Z")),
        user("u2", secondUserAt),
      ],
      head: [assistant("a2", new Date("2026-05-15T00:01:04.000Z"))],
    });

    assert.equal(timing.runningStartedAt, secondUserAt);
    assert.equal(timing.byAssistantId.has("a2"), false);
  });

  it("derives completed turn timing from user and assistant item timestamps", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const assistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", assistantAt),
        user("u2", new Date("2026-05-15T00:01:00.000Z")),
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("a1"), {
      completedAt: assistantAt,
      durationMs: 7000,
    });
  });

  it("maps multiple assistant chunks in one turn to the same timing", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const firstAssistantAt = new Date("2026-05-15T00:00:03.000Z");
    const lastAssistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", firstAssistantAt),
        assistant("a2", lastAssistantAt),
      ],
      head: [],
    });

    const expected = {
      completedAt: lastAssistantAt,
      durationMs: 7000,
    };
    assert.deepEqual(timing.byAssistantId.get("a1"), expected);
    assert.deepEqual(timing.byAssistantId.get("a2"), expected);
  });

  it("ends a turn before a notification recorded while the agent was idle", () => {
    // Shape recorded by the Codex Daybreak E2E: toggle notices carry no turn ID.
    const firstReplyAt = new Date("2026-11-02T18:25:57.606Z");
    const secondReplyAt = new Date("2026-11-02T18:26:11.682Z");
    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        notice("daybreak-on", new Date("2026-11-02T18:25:39.770Z")),
        { ...user("u1", new Date("2026-11-02T18:25:54.144Z")), turnId: "turn-0" },
        { ...assistant("a1", firstReplyAt), turnId: "turn-0" },
        notice("daybreak-off", new Date("2026-11-02T18:26:07.117Z")),
        { ...user("u2", new Date("2026-11-02T18:26:09.968Z")), turnId: "turn-1" },
        { ...assistant("a2", secondReplyAt), turnId: "turn-1" },
        notice("daybreak-on-again", new Date("2026-11-02T18:26:28.520Z")),
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("a1"), {
      completedAt: firstReplyAt,
      durationMs: 3462,
    });
    assert.deepEqual(timing.byAssistantId.get("a2"), {
      completedAt: secondReplyAt,
      durationMs: 1714,
    });
  });

  it("starts the turn after an idle notification at its agent report", () => {
    const at = (second: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, second));
    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        { ...user("u1", at(1)), turnId: "turn-1" },
        { ...assistant("a1", at(3)), turnId: "turn-1" },
        notice("idle notice", at(10)),
        {
          kind: "user_message",
          id: "report",
          text: "report",
          timestamp: at(20),
          sender: { kind: "agent", agentId: "child" },
          turnId: "turn-2",
        },
        { ...assistant("a2", at(25)), turnId: "turn-2" },
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("a1"), { completedAt: at(3), durationMs: 2000 });
    assert.deepEqual(timing.byAssistantId.get("a2"), { completedAt: at(25), durationMs: 5000 });
  });

  it("keeps a notification recorded during the turn in that turn", () => {
    const errorAt = new Date("2026-05-15T00:00:09.000Z");
    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        { ...user("u1", new Date("2026-05-15T00:00:00.000Z")), turnId: "turn-1" },
        { ...notice("retry", new Date("2026-05-15T00:00:02.000Z")), turnId: "turn-1" },
        { ...assistant("a1", new Date("2026-05-15T00:00:05.000Z")), turnId: "turn-1" },
        { ...notice("failed", errorAt), turnId: "turn-1" },
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("a1"), {
      completedAt: errorAt,
      durationMs: 9000,
    });
  });

  it("preserves the completion timestamp when a canonical turn has no visible prompt", () => {
    const firstTurnAt = new Date("2026-05-15T00:00:00.000Z");
    const hiddenPromptTurnAt = new Date("2026-05-15T00:01:07.000Z");
    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        { ...user("u1", firstTurnAt), turnId: "turn-1" },
        {
          ...assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
          turnId: "turn-1",
        },
        {
          ...assistant("hidden-prompt-a1", new Date("2026-05-15T00:01:03.000Z")),
          turnId: "turn-2",
        },
        { ...assistant("hidden-prompt-a2", hiddenPromptTurnAt), turnId: "turn-2" },
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("hidden-prompt-a2"), {
      completedAt: hiddenPromptTurnAt,
      durationMs: null,
    });
  });
});
