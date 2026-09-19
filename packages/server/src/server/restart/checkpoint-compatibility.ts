import { CheckpointStore } from "./checkpoint-store.js";
import { DaemonCheckpointSchema } from "./daemon-checkpoint.js";

export { READABLE_CHECKPOINT_FORMATS } from "./daemon-checkpoint.js";

/** Offline package preflight: never claims a generation or opens provider sessions. */
export async function validateReadyCheckpoint(
  home: string,
  generationId: string,
): Promise<{
  generationId: string;
  format: number;
}> {
  const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
  const inspected = await store.inspectReadyGeneration(generationId);
  return { generationId: inspected.generationId, format: inspected.snapshot.version };
}
