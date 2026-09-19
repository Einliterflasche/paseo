import { writeFileSync } from "node:fs";

// Linux's maximum victim preference. This is a kill priority, not a memory cap.
const SERVICE_OOM_SCORE = 1000;

/** Only call inside the disposable service process, never in its parent. */
export function preferServiceOomKill(): void {
  if (process.platform === "linux") {
    writeFileSync("/proc/self/oom_score_adj", String(SERVICE_OOM_SCORE));
  }
}

interface ServiceCommand {
  command: string;
  args: string[] | string;
}

/** Set the priority before the service shell can run startup files or fork. */
export function serviceProcessCommand(input: ServiceCommand): ServiceCommand {
  if (process.platform !== "linux") return input;
  if (!Array.isArray(input.args)) throw new Error("Linux service arguments must be an array");
  return {
    command: "/bin/sh",
    args: [
      "-c",
      // $$ names this wrapper even if the shell implements printf externally.
      `printf '%s' ${SERVICE_OOM_SCORE} > /proc/$$/oom_score_adj && exec "$@"`,
      "paseo-service",
      input.command,
      ...input.args,
    ],
  };
}
