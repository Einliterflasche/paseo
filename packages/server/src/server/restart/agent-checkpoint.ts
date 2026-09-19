import { z } from "zod";
import { AgentTimelineSnapshotSchema } from "../agent/agent-timeline-store.js";
import { ProviderSubagentStoreSnapshotSchema } from "../agent/provider-subagents/store.js";
import { parseStoredAgentRecord } from "../agent/agent-storage.js";
import { RecoveryInputSchema } from "./recovery-input.js";

export const AgentCheckpointSchema = z.object({
  timelines: z.record(z.string(), AgentTimelineSnapshotSchema),
  children: ProviderSubagentStoreSnapshotSchema,
  agents: z.array(
    z.object({
      record: z.unknown().transform(parseStoredAgentRecord),
      continue: z.boolean(),
      // Logical identity survives replacement of the native execution attempt.
      runId: z.string().optional(),
      inputs: z.array(RecoveryInputSchema),
    }),
  ),
});
export type AgentCheckpoint = z.infer<typeof AgentCheckpointSchema>;
