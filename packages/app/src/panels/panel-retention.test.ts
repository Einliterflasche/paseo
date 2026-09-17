import { describe, expect, it } from "vitest";
import { deriveMountedTabLru } from "../screens/workspace/use-mounted-tab-set";
import { createPanelRetention } from "./panel-retention";

describe("panel retention leases", () => {
  it("survives more than three visited tabs but never prevents an explicit tab close", () => {
    const retention = createPanelRetention();
    const release = retention.retain("answer");
    const availableTabIds = new Set(["answer", "B", "C", "D", "E"]);
    let previousLru = ["answer"];
    for (const activeTabId of ["B", "C", "D", "E"]) {
      previousLru = deriveMountedTabLru({
        activeTabId,
        availableTabIds,
        cap: 3,
        previousLru,
        retainedTabIds: retention.getSnapshot(),
      });
      expect(previousLru).toContain("answer");
      expect(new Set(previousLru).size).toBe(previousLru.length);
      expect(previousLru.length).toBeLessThanOrEqual(3);
    }
    availableTabIds.delete("answer");
    expect(
      deriveMountedTabLru({
        activeTabId: "E",
        availableTabIds,
        cap: 3,
        previousLru,
        retainedTabIds: retention.getSnapshot(),
      }),
    ).not.toContain("answer");
    availableTabIds.add("answer");
    release();
    expect(
      deriveMountedTabLru({
        activeTabId: "B",
        availableTabIds,
        cap: 3,
        previousLru: ["E", "D", "C", "answer"],
        retainedTabIds: retention.getSnapshot(),
      }),
    ).not.toContain("answer");
  });

  it("retains concurrent work until every owner releases and tolerates repeated cleanup", () => {
    const retention = createPanelRetention();
    const first = retention.retain("answer");
    const second = retention.retain("answer");
    const other = retention.retain("review");
    first();
    first();
    expect([...retention.getSnapshot()]).toEqual(["answer", "review"]);
    second();
    expect([...retention.getSnapshot()]).toEqual(["review"]);
    other();
    expect([...retention.getSnapshot()]).toEqual([]);
  });

  it("publishes stable snapshots only when retained membership changes", () => {
    const retention = createPanelRetention();
    const snapshots: Set<string>[] = [];
    const unsubscribe = retention.subscribe(() => snapshots.push(retention.getSnapshot()));
    const first = retention.retain("tab");
    const pinned = retention.getSnapshot();
    const second = retention.retain("tab");
    expect(retention.getSnapshot()).toBe(pinned);
    first();
    expect(retention.getSnapshot()).toBe(pinned);
    second();
    expect(snapshots.map((snapshot) => [...snapshot])).toEqual([["tab"], []]);
    unsubscribe();
    retention.retain("next");
    expect(snapshots).toHaveLength(2);
  });
});
