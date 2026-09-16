import type { SessionInboundMessage } from "../messages.js";
import { requiredPermissionForInbound } from "../authorization/operation-permissions.js";

// These read operations require management permissions for authorization; that
// does not make them state writers. Keep inspection available while paused.
const MANAGEMENT_READS = new Set<SessionInboundMessage["type"]>([
  "schedule/inspect",
  "schedule/list",
  "schedule/logs",
  "loop/inspect",
  "loop/list",
  "loop/logs",
  "plugin.catalog.get.request",
  "plugin.directory.inspect.request",
  "plugin.list.request",
  "plugin.logs.get.request",
  "plugin.source.status.request",
  "hub.management.daemon.get_status.request",
  "hub.execution.agent.validate.request",
]);

/** Session-level admission covers short mutations not already owned by the manager. */
export function requiresRestartAdmission(type: SessionInboundMessage["type"]): boolean {
  // Lifecycle operations own the barrier. run-once waits for a whole model turn;
  // ScheduleService tracks its admission separately from its completion.
  if (
    type === "restart_server_request" ||
    type === "shutdown_server_request" ||
    type === "schedule/run-once" ||
    MANAGEMENT_READS.has(type)
  )
    return false;
  const requirement = requiredPermissionForInbound(type);
  const permissions = typeof requirement === "string" ? [requirement] : (requirement ?? []);
  return permissions.length > 0 && !permissions.some((permission) => permission.endsWith(".read"));
}
