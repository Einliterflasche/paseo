import { z } from "zod";
import { AgentCheckpointSchema } from "./agent-checkpoint.js";
import { FinishNotificationWatchRecordsSchema } from "../agent/agent-prompt.js";
import { ScheduleRestartSnapshotSchema } from "../schedule/service.js";

export const DaemonCheckpointSchema = z
  .object({
    // Version 2 embeds shared text tables. Older daemons must reject it rather
    // than strip those tables and restore empty log placeholders.
    version: z.union([z.literal(1), z.literal(2)]),
    agents: AgentCheckpointSchema,
    notifications: FinishNotificationWatchRecordsSchema,
    schedules: ScheduleRestartSnapshotSchema,
  })
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.version !== 1) return;
    const timelines = [
      ...Object.values(checkpoint.agents.timelines),
      ...checkpoint.agents.children.map((child) => child.timeline),
    ];
    if (
      timelines.some(
        (timeline) =>
          timeline.textNodes !== undefined || timeline.rows.some((row) => row.logRef !== undefined),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Shared timeline text requires checkpoint version 2",
      });
    }
  });
