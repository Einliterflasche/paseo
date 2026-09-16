import { z } from "zod";
import { open } from "node:fs/promises";
import { AgentAttachmentSchema } from "../messages.js";
import type { AgentPromptInput, AgentRunOptions } from "../agent/agent-sdk-types.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";

export const RecoveryInputSchema = z.object({
  id: z.string(),
  intent: z.enum(["run", "steer"]),
  prompt: z.union([
    z.string(),
    z.array(
      z.union([
        AgentAttachmentSchema,
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
      ]),
    ),
  ]),
  options: z
    .object({
      clientMessageId: z.string().optional(),
      maxThinkingTokens: z.number().optional(),
      outputSchema: z
        .unknown()
        .refine((value) => z.json().safeParse(value).success, "Expected JSON output schema")
        .optional(),
    })
    .optional(),
});
export type RecoveryInput = z.infer<typeof RecoveryInputSchema>;

export function recoveryInput(
  prompt: AgentPromptInput,
  options: AgentRunOptions | undefined,
  intent: RecoveryInput["intent"],
): RecoveryInput {
  // Capture existing provider inputs without adding a new live-admission contract.
  // The checkpoint schema validates serializability before replacement is allowed.
  return { id: options?.clientMessageId ?? crypto.randomUUID(), intent, prompt, options };
}

/** Completed uploads are retained under Paseo's home; verify those references before commit. */
export async function verifyRecoveryInputFiles(inputs: readonly RecoveryInput[]): Promise<void> {
  for (const input of inputs) {
    if (typeof input.prompt === "string") continue;
    for (const block of input.prompt) {
      if (block.type !== "uploaded_file") continue;
      const file = await open(block.path, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== block.size) {
          throw new Error(`Recovery attachment is incomplete: ${block.path}`);
        }
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }
}

/** One hidden envelope, retaining all accepted inputs and binary content in order. */
export function continuationPrompt(inputs: readonly RecoveryInput[]): AgentPromptInput {
  const text = [
    "The Paseo daemon restarted and interrupted this task. Continue the unfinished work in this same session.",
    "The following requests were already accepted, in order. They are recovery context, not new user submissions.",
    "Check existing results before repeating an interrupted operation. Respect every request, including steering instructions.",
    ...inputs.map((input) =>
      JSON.stringify({
        id: input.id,
        intent: input.intent,
        prompt:
          typeof input.prompt === "string"
            ? input.prompt
            : input.prompt.filter((block) => block.type !== "image"),
      }),
    ),
  ].join("\n");
  const images = inputs.flatMap((input) =>
    typeof input.prompt === "string" ? [] : input.prompt.filter((block) => block.type === "image"),
  );
  const envelope = formatSystemNotificationPrompt(text);
  return images.length ? [{ type: "text", text: envelope }, ...images] : envelope;
}
