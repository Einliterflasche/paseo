import type { FetchAgentTimelineResponseMessage } from "@getpaseo/protocol/messages";

export type TimelineRequestErrorCode = NonNullable<
  FetchAgentTimelineResponseMessage["payload"]["errorCode"]
>;

/** Preserves the daemon's retry contract without classifying human-readable messages. */
export class TimelineRequestError extends Error {
  override readonly name = "TimelineRequestError";

  constructor(
    message: string,
    readonly code: TimelineRequestErrorCode | undefined,
    readonly epoch?: string,
  ) {
    super(message);
  }
}
