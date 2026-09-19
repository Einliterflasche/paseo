import { expect, test } from "vitest";
import { AgentRunState } from "./agent-run-state.js";

test("a logical run outcome keeps its own text when another run starts immediately", async () => {
  const state = new AgentRunState();
  const completion = state.waitForOutcome("agent", "first-input");
  state.createPendingRun("agent");
  state.rememberInput("agent", "first", { clientMessageId: "first-input" }, "run");
  state.publishOutcome({ type: "completed", agentId: "agent" }, "first answer");
  state.createPendingRun("agent");
  state.rememberInput("agent", "second", { clientMessageId: "second-input" }, "run");
  state.publishOutcome({ type: "completed", agentId: "agent" }, "second answer");
  expect(await completion).toEqual({
    type: "completed",
    agentId: "agent",
    runId: "first-input",
    lastMessage: "first answer",
  });
  expect(state.getOutcome("agent")?.runId).toBe("second-input");
});

test("restoration preserves logical identity while native attempts and steering inputs change", () => {
  const state = new AgentRunState();
  state.createPendingRun("agent");
  state.rememberInput("agent", "original", { clientMessageId: "original-input" }, "run");
  state.rememberInput("agent", "correction", { clientMessageId: "steering-input" }, "steer");
  const inputs = state.recoveryInputs("agent");
  const restored = new AgentRunState();
  restored.createPendingRun("agent");
  restored.restoreInputs("agent", inputs, state.getLogicalId("agent"));
  restored.publishOutcome({ type: "completed", agentId: "agent" }, "after restart");
  expect(restored.getOutcome("agent")).toEqual({
    type: "completed",
    agentId: "agent",
    runId: "original-input",
    lastMessage: "after restart",
  });
  expect(restored.recoveryInputs("agent")).toEqual(inputs);
});

test("permanent discard releases run metadata and listeners after delivering the terminal value", async () => {
  const state = new AgentRunState();
  state.createPendingRun("agent");
  state.rememberInput("agent", "original", { clientMessageId: "input" }, "run");
  const completion = state.waitForOutcome("agent", "input");
  let notifications = 0;
  state.subscribeOutcome("agent", () => {
    notifications++;
  });
  expect(() => state.clearAgentState("agent")).toThrow("Cannot discard active run");
  state.clearAgentRun("agent");
  state.publishOutcome({ type: "user_canceled", agentId: "agent" }, "preserved answer");
  state.clearAgentState("agent");
  expect(state.getOutcome("agent")).toBeUndefined();
  expect(state.getLogicalId("agent")).toBeUndefined();
  expect(state.recoveryInputs("agent")).toEqual([]);
  expect(await completion).toMatchObject({ runId: "input", lastMessage: "preserved answer" });
  state.createPendingRun("agent");
  state.publishOutcome({ type: "completed", agentId: "agent" }, "new answer");
  expect(notifications).toBe(1);
});
