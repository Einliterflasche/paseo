import { z } from "zod";

const requestId = z.number().int().positive().safe();
const mode = z.enum(["iframe", "tab"]);
const cookieHeader = z.string().optional();
const base = { channelId: z.string() };

export const PreviewGatewayMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("probe"), challenge: z.string() }).strict(),
  z
    .object({
      ...base,
      type: z.literal("redeem"),
      requestId,
      input: z.object({ bootstrapId: z.string(), ticket: z.string(), mode }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("confirm"),
      requestId,
      input: z.object({ bootstrapId: z.string(), cookieHeader, mode }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("authorize"),
      requestId,
      input: z.object({ serviceId: z.string(), cookieHeader }).strict(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("completed"), requestId }).strict(),
  z.object({ ...base, type: z.literal("cancelled"), requestId }).strict(),
]);

export const PreviewBrokerMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("acknowledge"), challenge: z.string() }).strict(),
  z.object({ ...base, type: z.literal("invalidate"), requestId }).strict(),
  z
    .object({
      ...base,
      type: z.literal("denied"),
      requestId,
      code: z.enum([
        "unavailable",
        "invalid-bootstrap",
        "invalid-confirmation",
        "authorization-ended",
      ]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("redeemed"),
      requestId,
      credential: z
        .object({
          bootstrapId: z.string(),
          cookieName: z.string(),
          cookieValue: z.string(),
          serviceId: z.string(),
          mode,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("confirmed"),
      requestId,
      contribution: z.object({ serviceId: z.string(), attemptId: z.string(), mode }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("authorized"),
      requestId,
      activationId: z.string(),
      route: z
        .object({
          serviceId: z.string(),
          port: z.number().int().min(1).max(65535),
          mount: z.enum(["preserve", "strip"]),
        })
        .strict(),
    })
    .strict(),
]);

export type PreviewGatewayMessage = z.infer<typeof PreviewGatewayMessageSchema>;
export type PreviewBrokerMessage = z.infer<typeof PreviewBrokerMessageSchema>;

/** Dedicated ordered private transport. A queued send is not a cancellation ack. */
export interface PreviewChannel<Message> {
  readonly signal: AbortSignal;
  send(message: Message): void;
  subscribe(receive: (message: unknown) => void): () => void;
  close(): void;
}

export function previewCompletion() {
  let resolve = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
