import { RestartInProgressError } from "../restart/restart-errors.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed", "not_dispatched"]),
  agentId: z.string(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly writeFailures = new Map<string, unknown>();
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending.values());
    if (this.writeFailures.size)
      throw new AggregateError(
        [...this.writeFailures.values()],
        "Message receipts could not be persisted",
      );
  }

  private async writeReceipt(file: string, receipt: z.infer<typeof ReceiptSchema>): Promise<void> {
    try {
      await writeJsonFileAtomic(file, receipt);
      this.writeFailures.delete(file);
    } catch (error) {
      this.writeFailures.set(file, error);
      throw error;
    }
  }

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing && existing.fingerprint !== fingerprint)
      throw new Error("agent_request_key_conflict");
    if (existing && existing.state !== "not_dispatched") {
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    await this.writeReceipt(file, { ...receipt, state: "pending" });
    try {
      await input.send();
    } catch (error) {
      if (error instanceof RestartInProgressError)
        await this.writeReceipt(file, { ...receipt, state: "not_dispatched" });
      throw error;
    }
    await this.writeReceipt(file, { ...receipt, state: "completed" });
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
