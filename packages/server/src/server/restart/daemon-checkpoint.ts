import { z } from "zod";
import { AgentCheckpointSchema } from "./agent-checkpoint.js";
import { FinishNotificationWatchRecordsSchema } from "../agent/agent-prompt.js";
import { ScheduleRestartSnapshotSchema } from "../schedule/service.js";

export const DaemonCheckpointSchema = z.object({
  version: z.literal(1),
  agents: AgentCheckpointSchema,
  notifications: FinishNotificationWatchRecordsSchema,
  schedules: ScheduleRestartSnapshotSchema,
});
