import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentCheckpointSchema } from "./agent-checkpoint.js";
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from "../private-files.js";

export const EmergencyHistorySchema = AgentCheckpointSchema.pick({
  timelines: true,
  children: true,
});

export function emergencyHistoryPath(home: string, restartId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(restartId)) throw new Error("Invalid emergency restart identity");
  return path.join(home, "restart-anyway", `${restartId}.json`);
}

/** Best effort only. This file never authorizes checkpoint replay or provider execution. */
export async function saveEmergencyHistory(
  home: string,
  restartId: string,
  history: ReturnType<typeof EmergencyHistorySchema.parse>,
): Promise<void> {
  const destination = emergencyHistoryPath(home, restartId);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  ensurePrivateDirectory(path.dirname(destination));
  const temporary = `${destination}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(history), { mode: PRIVATE_FILE_MODE, flag: "wx" });
  await fs.rename(temporary, destination);
}

export async function loadEmergencyHistory(home: string, restartId: string) {
  return EmergencyHistorySchema.parse(
    await fs.readFile(emergencyHistoryPath(home, restartId), "utf8").then(JSON.parse),
  );
}
