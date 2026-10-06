import { z } from "zod";
import path from "node:path";

export const PreviewWorkerSocketPathSchema = z
  .string()
  .refine((value) => path.posix.isAbsolute(value) && !value.includes("\0"));

export const PreviewWorkerStartSchema = z
  .object({
    type: z.literal("preview-start"),
    channelId: z.string(),
    socketPath: PreviewWorkerSocketPathSchema,
    controlOrigin: z.string(),
    controlCookieNames: z.array(z.string()),
  })
  .strict();

export const PreviewWorkerReadySchema = z
  .object({
    type: z.literal("preview-ready"),
    channelId: z.string(),
  })
  .strict();

const PreviewWorkerErrorCodeSchema = z.enum([
  "EACCES",
  "EADDRINUSE",
  "ECONNRESET",
  "EPIPE",
  "ENOENT",
  "EPERM",
  "ENOSPC",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "ETIMEDOUT",
  "UNKNOWN",
]);

/** Never forward error messages, paths, arguments, or arbitrary error fields. */
export function previewWorkerErrorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const parsed = PreviewWorkerErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "UNKNOWN";
}

export const PreviewWorkerFailureSchema = z
  .object({
    type: z.literal("preview-startup-failed"),
    channelId: z.string(),
    step: z.enum(["oom-preference", "gateway", "listen"]),
    code: PreviewWorkerErrorCodeSchema,
  })
  .strict();

export type PreviewWorkerStart = z.infer<typeof PreviewWorkerStartSchema>;
