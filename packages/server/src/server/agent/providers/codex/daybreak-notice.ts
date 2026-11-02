import { z } from "zod";
import type { ImportedTimelineEntry } from "../../agent-sdk-types.js";

const NoticeSchema = z.object({
  enabled: z.boolean(),
  timestamp: z.string().datetime(),
  // The selected model when Daybreak was turned on but is not available for it.
  unavailableFor: z.string().optional(),
});
type Notice = z.infer<typeof NoticeSchema>;

function toEntry(notice: Notice): ImportedTimelineEntry {
  return { timestamp: notice.timestamp, item: toItem(notice) };
}

function toItem(notice: Notice): ImportedTimelineEntry["item"] {
  if (!notice.enabled) {
    return { type: "notification", level: "info", message: "Daybreak is off." };
  }
  if (notice.unavailableFor === undefined) {
    return { type: "notification", level: "info", message: "Daybreak is on for new turns." };
  }
  return {
    type: "notification",
    level: "warning",
    message: `Daybreak is on, but not available for ${notice.unavailableFor}.`,
  };
}

// These rows belong to Paseo, not the Codex thread, so a history rebuild does not return them.
// Keep their timestamps in the persistence handle and merge them back by time.
export class CodexDaybreakNotices {
  private readonly notices: Notice[];

  constructor(saved: unknown) {
    const parsed = z.array(NoticeSchema).safeParse(saved);
    this.notices = parsed.success ? parsed.data : [];
  }

  /** `unavailableFor` names the selected model when Daybreak is not available for it. */
  record(enabled: boolean, unavailableFor: string | null): ImportedTimelineEntry {
    const notice: Notice = { enabled, timestamp: new Date().toISOString() };
    if (enabled && unavailableFor !== null) notice.unavailableFor = unavailableFor;
    this.notices.push(notice);
    return toEntry(notice);
  }

  serialize(): Notice[] {
    return [...this.notices];
  }

  // Each notice goes before the first newer row. Rows without a time never move a notice.
  merge(timeline: readonly ImportedTimelineEntry[]): ImportedTimelineEntry[] {
    const merged: ImportedTimelineEntry[] = [];
    let next = 0;
    for (const entry of timeline) {
      const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
      while (next < this.notices.length && Date.parse(this.notices[next].timestamp) <= at) {
        merged.push(toEntry(this.notices[next]));
        next += 1;
      }
      merged.push(entry);
    }
    for (const notice of this.notices.slice(next)) merged.push(toEntry(notice));
    return merged;
  }
}
