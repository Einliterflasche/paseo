import { z } from "zod";
import { AgentCheckpointSchema } from "./agent-checkpoint.js";
import { FinishNotificationWatchRecordsSchema } from "../agent/agent-prompt.js";
import { ScheduleRestartSnapshotSchema } from "../schedule/service.js";

export const READABLE_CHECKPOINT_FORMATS = [1, 2, 3] as const;

export const DaemonCheckpointSchema = z
  .object({
    // Version 3 preserves shared backing ranges; versions 1 and 2 keep their original codecs. Older daemons must reject it rather
    // than strip those tables and restore empty log placeholders.
    version: z.literal(READABLE_CHECKPOINT_FORMATS),
    agents: AgentCheckpointSchema,
    notifications: FinishNotificationWatchRecordsSchema,
    schedules: ScheduleRestartSnapshotSchema,
  })
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.version === 3) return;
    if (checkpoint.schedules.archives?.length)
      ctx.addIssue({
        code: "custom",
        message: "Pending archive obligations require checkpoint version 3",
      });
    const timelines = [
      ...Object.values(checkpoint.agents.timelines),
      ...checkpoint.agents.children.map((child) => child.timeline),
    ];
    if (
      timelines.some((timeline) =>
        checkpoint.version === 1
          ? timeline.textNodes !== undefined ||
            timeline.textBackings !== undefined ||
            timeline.rows.some((row) => row.logRef !== undefined)
          : timeline.textBackings !== undefined ||
            timeline.textNodes?.some((node) => Array.isArray(node) && node.length === 3),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Checkpoint text encoding does not match its declared version",
      });
    }
  });
