import { expect, test } from "vitest";
import { requiresRestartAdmission } from "./request-admission.js";

test("management-protected reads remain available while mutations join the barrier", () => {
  for (const type of [
    "schedule/inspect",
    "schedule/list",
    "schedule/logs",
    "plugin.logs.get.request",
  ] as const)
    expect(requiresRestartAdmission(type)).toBe(false);
  for (const type of [
    "schedule/create",
    "schedule/delete",
    "schedule/update",
    "plugin.enable.request",
    "send_agent_message_request",
    "service.preview.prepare.request",
    "service.external.register.request",
    "service.managed.enable.request",
  ] as const)
    expect(requiresRestartAdmission(type)).toBe(true);
  expect(requiresRestartAdmission("schedule/run-once")).toBe(false);
  for (const type of [
    "service.preview.close.request",
    "service.external.disconnect.request",
    "service.managed.disable.request",
  ] as const)
    expect(requiresRestartAdmission(type)).toBe(false);
});
