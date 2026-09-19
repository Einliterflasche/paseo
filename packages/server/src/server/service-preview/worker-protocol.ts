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

export type PreviewWorkerStart = z.infer<typeof PreviewWorkerStartSchema>;
