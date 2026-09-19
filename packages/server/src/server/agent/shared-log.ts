import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { readText, reviseText, type SharedText } from "./shared-text.js";

type SubagentCall = Extract<AgentTimelineItem, { type: "tool_call" }>;
type SubagentDetail = Extract<SubagentCall["detail"], { type: "sub_agent" }>;

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
  private readonly versions = new WeakMap<SubagentDetail, SharedText>();

  retain(item: AgentTimelineItem): AgentTimelineItem {
    if (item.type !== "tool_call" || item.detail.type !== "sub_agent") return item;
    const previous = this.latest.get(item.callId);
    const text = item.detail.log;
    const version = reviseText(previous?.version ?? null, previous?.text ?? "", text);
    this.latest.set(item.callId, { text, version });
    return this.attach(item, version);
  }

  attach(item: AgentTimelineItem, version: SharedText): AgentTimelineItem {
    if (item.type !== "tool_call" || item.detail.type !== "sub_agent") {
      throw new Error("A shared log must belong to a subagent tool call");
    }
    const detail = { ...item.detail, log: "" };
    Object.defineProperty(detail, "log", { enumerable: true, get: logGetter(version) });
    this.versions.set(detail, version);
    return { ...item, detail };
  }

  version(item: AgentTimelineItem): SharedText | undefined {
    if (item.type !== "tool_call" || item.detail.type !== "sub_agent") return undefined;
    return this.versions.get(item.detail);
  }

  /** Restore only the latest comparison text per call, never all historical versions. */
  seedLatest(items: Iterable<AgentTimelineItem>): void {
    const latest = new Map<string, AgentTimelineItem>();
    for (const item of items) {
      if (item.type === "tool_call" && item.detail.type === "sub_agent") {
        latest.set(item.callId, item);
      }
    }
    for (const [id, item] of latest) {
      const version = this.version(item);
      if (version !== undefined) this.latest.set(id, { text: readText(version), version });
    }
  }
}
