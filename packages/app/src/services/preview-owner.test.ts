import { describe, expect, it } from "vitest";
import { createWorkspaceLayoutStore, findPaneContainingTab } from "@/stores/workspace-layout-store";
import { MemoryServicesStorage } from "./test-support";
import {
  createPreviewTabOwner,
  type PreviewTabLifetime,
  type PreviewTabIdentity,
} from "./preview-owner";

function fixture() {
  const layouts = createWorkspaceLayoutStore(undefined, new MemoryServicesStorage());
  const documents: {
    lifetime: PreviewTabLifetime;
    placements: (string | null)[];
    closed: number;
  }[] = [];
  const owner = createPreviewTabOwner<string>({
    layouts,
    create(lifetime) {
      const document = { lifetime, placements: [] as (string | null)[], closed: 0 };
      documents.push(document);
      return {
        place(placement) {
          document.placements.push(placement);
        },
        close() {
          document.closed += 1;
        },
      };
    },
  });
  function open(serviceId: string, workspaceKey = "host:workspace") {
    const tabId = layouts.getState().openTab({
      workspaceKey,
      target: { kind: "service_preview", serviceId },
      intent: "reveal",
    });
    if (!tabId) throw new Error("Missing preview tab");
    return { workspaceKey, tabId, serviceId };
  }
  function place(identity: PreviewTabIdentity, placement: string) {
    const generation = owner.getGeneration(identity);
    if (!generation) throw new Error("Missing resident generation");
    return owner.place({ identity, generation, placement });
  }
  return { layouts, documents, owner, open, place };
}

describe("resident service tab ownership", () => {
  it("fences old placements and callbacks after a tab closes and reopens", () => {
    const { layouts, documents, owner, open, place } = fixture();
    try {
      const identity = open("atlas");
      const oldGeneration = owner.getGeneration(identity)!;
      const updates: (AbortSignal | null)[] = [];
      const unsubscribe = owner.subscribe(() => updates.push(owner.getGeneration(identity)));
      const old = place(identity, "old-pane");
      layouts.getState().closeTab(identity.workspaceKey, identity.tabId);
      const reopened = open("atlas");
      expect(reopened).toEqual(identity);
      const newGeneration = owner.getGeneration(reopened);
      expect(newGeneration).not.toBe(oldGeneration);
      expect(updates).toEqual([null, newGeneration]);
      unsubscribe();
      expect(
        owner.place({ identity, generation: oldGeneration, placement: "stale-registration" }),
      ).toBeNull();
      const current = place(reopened, "new-pane");
      old?.update("late-measurement");
      old?.release();
      expect(documents.map((doc) => doc.placements)).toEqual([["old-pane"], ["new-pane"]]);
      expect(documents.map((doc) => doc.lifetime.signal.aborted)).toEqual([true, false]);
      current?.release();
      expect(documents[1].closed).toBe(0);
      expect(documents[1].placements).toEqual(["new-pane", null]);
    } finally {
      owner.close();
    }
    expect(documents.map((doc) => doc.closed)).toEqual([1, 1]);
  });

  it("keeps documents through pane moves, placement disposal and other workspaces", () => {
    const { layouts, documents, owner, open, place } = fixture();
    try {
      const first = open("atlas");
      const second = open("beacon");
      const placement = place(first, "main");
      expect(documents.map((doc) => doc.lifetime.identity.serviceId)).toEqual(["atlas", "beacon"]);
      const root = layouts.getState().layoutByWorkspace[first.workspaceKey].root;
      const main = findPaneContainingTab(root, first.tabId);
      if (!main) throw new Error("Missing pane");
      const rightId = layouts.getState().splitPane(first.workspaceKey, {
        tabId: first.tabId,
        targetPaneId: main.id,
        position: "right",
      });
      if (!rightId) throw new Error("Missing split");
      const moved = place(first, "right");
      placement?.release();
      layouts.getState().moveTabToPane(first.workspaceKey, first.tabId, main.id);
      moved?.release();
      open("atlas", "another-host:workspace");
      open(second.serviceId);
      expect(documents.map((doc) => doc.closed)).toEqual([0, 0, 0]);
      expect(documents[0].placements).toEqual(["main", "right", null]);
      expect(documents[0].lifetime.signal.aborted).toBe(false);
      layouts.getState().closeTab(first.workspaceKey, first.tabId);
      expect(documents.map((doc) => doc.closed)).toEqual([1, 0, 0]);
      expect(documents[0].lifetime.signal.aborted).toBe(true);
    } finally {
      owner.close();
    }
  });
});
