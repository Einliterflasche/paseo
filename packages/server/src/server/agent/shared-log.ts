import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { readText, reviseText, textJsonBytes, type SharedText } from "./shared-text.js";

type SubagentCall = Extract<AgentTimelineItem, { type: "tool_call" }>;
type SharedDetail = Extract<SubagentCall["detail"], { type: "sub_agent" | "plain_text" }>;

// Metadata follows the immutable detail, including projected items and run results.
// Weak keys do not become another owner of released timelines.
const versions = new WeakMap<SharedDetail, SharedText>();

interface LatestLog {
  text: string;
  version: SharedText;
}

// Keep the getter's closure separate from ingestion: it owns only the immutable
// version, never the original cumulative string or the per-timeline owner map.
function logGetter(version: SharedText): () => string {
  return () => readText(version);
}

export class SharedLogStore {
  private readonly latest = new Map<string, LatestLog>();

  retain(item: AgentTimelineItem): AgentTimelineItem {
    if (
      item.type !== "tool_call" ||
      (item.detail.type !== "sub_agent" && item.detail.type !== "plain_text")
    )
      return item;
    const key = JSON.stringify([item.callId, item.detail.type]);
    const previous = this.latest.get(key);
    const text = item.detail.type === "sub_agent" ? item.detail.log : item.detail.text;
    if (text === undefined) return item;
    const version = reviseText(previous?.version ?? null, previous?.text ?? "", text);
    this.latest.set(key, { text, version });
    return this.attach(item, version);
  }

  attach(item: AgentTimelineItem, version: SharedText): AgentTimelineItem {
    if (
      item.type !== "tool_call" ||
      (item.detail.type !== "sub_agent" && item.detail.type !== "plain_text")
    ) {
      throw new Error("Shared text must belong to a textual tool call");
    }
    const detail = detailWithoutText(item.detail);
    Object.defineProperty(detail, item.detail.type === "sub_agent" ? "log" : "text", {
      enumerable: true,
      get: logGetter(version),
    });
    versions.set(detail, version);
    Object.freeze(detail);
    return Object.freeze({ ...item, detail });
  }

  version(item: AgentTimelineItem): SharedText | undefined {
    if (
      item.type !== "tool_call" ||
      (item.detail.type !== "sub_agent" && item.detail.type !== "plain_text")
    )
      return undefined;
    return versions.get(item.detail);
  }

  /** Restore only the latest comparison text per call, never all historical versions. */
  seedLatest(items: Iterable<AgentTimelineItem>): void {
    const latest = new Map<string, AgentTimelineItem>();
    for (const item of items) {
      if (
        item.type === "tool_call" &&
        (item.detail.type === "sub_agent" || item.detail.type === "plain_text")
      ) {
        latest.set(JSON.stringify([item.callId, item.detail.type]), item);
      }
    }
    for (const [id, item] of latest) {
      const version = this.version(item);
      if (version !== undefined) this.latest.set(id, { text: readText(version), version });
    }
  }
}

function detailWithoutText(detail: SharedDetail): SharedDetail {
  const field = detail.type === "sub_agent" ? "log" : "text";
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(detail);
  delete descriptors[field];
  const copy: SharedDetail =
    detail.type === "sub_agent" ? { type: "sub_agent", log: "" } : { type: "plain_text", text: "" };
  Object.defineProperties(copy, descriptors);
  return copy;
}

/** Exact JSON bytes without reading a historical log getter; null exceeds the caller's budget. */
export function timelineItemJsonBytes(item: AgentTimelineItem, maximum = Infinity): number | null {
  if (
    item.type !== "tool_call" ||
    (item.detail.type !== "sub_agent" && item.detail.type !== "plain_text")
  ) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    return bytes > maximum ? null : bytes;
  }
  const version = versions.get(item.detail);
  if (version === undefined) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    return bytes > maximum ? null : bytes;
  }
  const blank = { ...item, detail: detailWithoutText(item.detail) };
  const envelope = Buffer.byteLength(JSON.stringify(blank));
  // The blank string's quotes are already included in the envelope.
  const content = textJsonBytes(version, maximum - envelope);
  return content === null ? null : envelope + content;
}
