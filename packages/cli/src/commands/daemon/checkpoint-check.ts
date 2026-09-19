import { READABLE_CHECKPOINT_FORMATS, validateReadyCheckpoint } from "@getpaseo/server";
import type { Command } from "commander";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { resolveLocalDaemonState } from "./local-daemon.js";

interface CheckpointCheckResult {
  readableFormats: readonly number[];
  generationId?: string;
  format?: number;
}

const schema: OutputSchema<CheckpointCheckResult> = {
  idField: "generationId",
  columns: [
    { header: "READABLE FORMATS", field: "readableFormats" },
    { header: "GENERATION", field: "generationId" },
    { header: "FORMAT", field: "format" },
  ],
};

export async function runCheckpointCheckCommand(
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<CheckpointCheckResult>> {
  if (options.formats === true) {
    return { type: "single", schema, data: { readableFormats: READABLE_CHECKPOINT_FORMATS } };
  }
  if (typeof options.generation !== "string" || !options.generation) {
    throw { code: "CHECKPOINT_GENERATION_REQUIRED", message: "Supply --generation or --formats." };
  }
  const { home } = resolveLocalDaemonState({
    home: typeof options.home === "string" ? options.home : undefined,
  });
  const result = await validateReadyCheckpoint(home, options.generation);
  return {
    type: "single",
    schema,
    data: { readableFormats: READABLE_CHECKPOINT_FORMATS, ...result },
  };
}
