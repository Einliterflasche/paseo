import type { StreamItem } from "@/types/stream";
import { isOrdinaryUserMessage } from "./spacing";

/**
 * The daemon stamps every live row of a turn with its ID. A notification without
 * one next to a stamped row was recorded while the agent was idle, for example a
 * feature toggle notice. It must not extend the turn before it or start the turn
 * after it, so neither turn takes its time or footer from the notice.
 */
function isNotificationAfterTurn(previous: StreamItem, next: StreamItem): boolean {
  return next.kind === "notification" && next.turnId === undefined && previous.turnId !== undefined;
}

function isNotificationBeforeTurn(previous: StreamItem, next: StreamItem): boolean {
  return (
    previous.kind === "notification" && previous.turnId === undefined && next.turnId !== undefined
  );
}

/**
 * Canonical turn IDs take precedence. Timelines without them retain the legacy
 * user-message boundary rule so old daemons and persisted rows need no rewrite.
 */
export function continuesTurn(previous: StreamItem | null, next: StreamItem | null): boolean {
  if (!previous || !next) return false;
  if (previous.turnId !== undefined && next.turnId !== undefined) {
    return previous.turnId === next.turnId;
  }
  return (
    !isOrdinaryUserMessage(next) &&
    !isNotificationAfterTurn(previous, next) &&
    !isNotificationBeforeTurn(previous, next)
  );
}

/**
 * A visible response can span multiple canonical turns when their prompts are
 * internal events retained as disclosures in the Paseo timeline.
 */
export function continuesResponse(previous: StreamItem | null, next: StreamItem | null): boolean {
  if (!previous || !next || isNotificationAfterTurn(previous, next)) return false;
  return continuesTurn(previous, next) || !isOrdinaryUserMessage(next);
}

export function isTurnBoundary(previous: StreamItem | null, next: StreamItem | null): boolean {
  return previous !== null && next !== null && !continuesTurn(previous, next);
}

export function isResponseBoundary(previous: StreamItem | null, next: StreamItem | null): boolean {
  return previous !== null && next !== null && !continuesResponse(previous, next);
}

/** Whether `item` begins a new chronological turn after `previous`. */
export function startsNewTurn(item: StreamItem, previous: StreamItem | null): boolean {
  return previous === null || isTurnBoundary(previous, item);
}

export function belongsToTurn(item: StreamItem, turnId: string | null): boolean {
  return turnId !== null && item.turnId === turnId;
}
