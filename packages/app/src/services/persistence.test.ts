import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectAllTabs,
  collectAllPanes,
  createWorkspaceLayoutStore,
  normalizeLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget, WorkspaceTab } from "@/workspace-tabs/model";

import { MemoryServicesStorage } from "./test-support";

function layout(targets: WorkspaceTabTarget[]) {
  const tabs = targets.map((target, index) => ({
    target,
    tabId: `tab-${index}`,
    createdAt: index + 1,
  }));
  return normalizeLayout({
    root: {
      kind: "pane",
      pane: {
        id: "main",
        tabs,
        tabIds: tabs.map((tab) => tab.tabId),
        focusedTabId: tabs.at(-1)?.tabId ?? null,
      },
    },
    focusedPaneId: "main",
  });
}

describe("Services downgrade compatibility", () => {
  it("preserves split panes, explorer, surviving focus and parents through persistence", async () => {
    const pane = (id: string, tabs: WorkspaceTab[]) => ({
      kind: "pane" as const,
      pane: {
        id,
        tabs,
        tabIds: tabs.map((tab) => tab.tabId),
        focusedTabId: tabs.at(-1)?.tabId ?? null,
      },
    });
    const complex = normalizeLayout({
      root: {
        kind: "group",
        group: {
          id: "shell",
          direction: "horizontal",
          sizes: [0.8, 0.2],
          children: [
            {
              kind: "group",
              group: {
                id: "split",
                direction: "vertical",
                sizes: [0.6, 0.4],
                children: [
                  pane("main", [
                    { tabId: "agent", target: { kind: "agent", agentId: "agent" }, createdAt: 1 },
                    { tabId: "main-services", target: { kind: "services" }, createdAt: 2 },
                    {
                      tabId: "atlas-preview",
                      target: { kind: "service_preview", serviceId: "atlas" },
                      createdAt: 8,
                    },
                  ]),
                  pane("right", [
                    {
                      tabId: "terminal",
                      target: { kind: "terminal", terminalId: "terminal" },
                      createdAt: 3,
                    },
                    { tabId: "file", target: { kind: "file", path: "notes.md" }, createdAt: 4 },
                    {
                      tabId: "beacon-preview",
                      target: { kind: "service_preview", serviceId: "beacon" },
                      createdAt: 9,
                    },
                  ]),
                ],
              },
            },
            pane("explorer", [
              { tabId: "files", target: { kind: "files" }, createdAt: 5 },
              { tabId: "changes", target: { kind: "changes_tree" }, createdAt: 6 },
              { tabId: "explorer-services", target: { kind: "services" }, createdAt: 7 },
            ]),
          ],
        },
      },
      focusedPaneId: "main",
      parentTabIdByTabId: {
        terminal: "agent",
        file: "main-services",
        "main-services": "agent",
        "atlas-preview": "agent",
        "beacon-preview": "atlas-preview",
      },
    });
    const storage = new MemoryServicesStorage();
    const store = createWorkspaceLayoutStore(undefined, storage);
    await store.persist.rehydrate();
    store.setState({
      layoutByWorkspace: {
        "host:one": complex,
        "host:two": layout([{ kind: "file", path: "README.md" }]),
      },
      explorerSidebarPaneIdByWorkspace: { "host:one": "explorer" },
      splitSizesByWorkspace: { "host:one": { split: [0.6, 0.4] } },
      explorerSidebarWidthByWorkspace: { "host:one": 320 },
    });
    store.getState().showExplorerSidebar("host:two");
    const name = store.persist.getOptions().name;
    if (!name) throw new Error("Persistence name missing");
    const raw = await storage.getItem(name);
    if (!raw) throw new Error("Persistence data missing");
    expect(raw).not.toContain("services");
    expect(raw).not.toContain("service_preview");
    expect(raw).not.toContain("atlas-preview");
    expect(raw).not.toContain("beacon-preview");
    const restored = createWorkspaceLayoutStore(undefined, storage);
    await restored.persist.rehydrate();
    const saved = restored.getState().layoutByWorkspace["host:one"];
    expect(
      collectAllPanes(saved.root).map((value) => ({ id: value.id, focus: value.focusedTabId })),
    ).toEqual([
      { id: "main", focus: "agent" },
      { id: "right", focus: "file" },
      { id: "explorer", focus: "changes" },
    ]);
    expect(saved.focusedPaneId).toBe("main");
    expect(saved.parentTabIdByTabId).toEqual({ terminal: "agent" });
    expect(restored.getState().splitSizesByWorkspace["host:one"]).toEqual({ split: [0.6, 0.4] });
    expect(restored.getState().explorerSidebarWidthByWorkspace["host:one"]).toBe(320);
    expect(restored.getState().layoutByWorkspace["host:two"]).toBeDefined();
    expect(storage.removals).toEqual([]);
    const evidenceDirectory = process.env.SERVICES_LAYOUT_EVIDENCE_DIR;
    if (evidenceDirectory) {
      // Persist the restored default Explorer tabs as a normal subsequent edit
      // would, so old/new readers compare stable tab creation timestamps too.
      restored.setState({ layoutByWorkspace: restored.getState().layoutByWorkspace });
      const candidate = await storage.getItem(name);
      if (!candidate) throw new Error("Restored persistence data missing");
      await writeFile(path.join(evidenceDirectory, "candidate.json"), candidate);
      await writeFile(
        path.join(evidenceDirectory, "expected.json"),
        JSON.stringify(restored.persist.getOptions().partialize?.(restored.getState())),
      );
      await writeFile(path.join(evidenceDirectory, "storage-key.txt"), name);
    }
  });

  it("persists existing tabs and other workspaces through the unchanged strict storage schema", async () => {
    const storage = new MemoryServicesStorage();
    const store = createWorkspaceLayoutStore(undefined, storage);
    await store.persist.rehydrate();
    store.setState({
      layoutByWorkspace: {
        "host:one": layout([
          { kind: "agent", agentId: "agent" },
          { kind: "terminal", terminalId: "terminal" },
          { kind: "services" },
        ]),
        "host:two": layout([{ kind: "file", path: "README.md" }]),
      },
    });
    const options = store.persist.getOptions();
    const serialized = options.partialize?.(store.getState());
    expect(serialized).toBeDefined();
    expect(JSON.stringify(serialized)).not.toContain('"services"');
    // This is the existing validator; its tab union deliberately stays unchanged.
    if (!options.name) throw new Error("Persistence name missing");
    const accepted = await options.storage?.getItem(options.name);
    expect(storage.removals).toEqual([]);
    expect(accepted?.state).toMatchObject({
      layoutByWorkspace: {
        "host:one": expect.anything(),
        "host:two": expect.anything(),
      },
    });
    const restored = createWorkspaceLayoutStore(undefined, storage);
    await restored.persist.rehydrate();
    expect(
      collectAllTabs(restored.getState().layoutByWorkspace["host:one"].root).map(
        (tab) => tab.target,
      ),
    ).toEqual([
      { kind: "agent", agentId: "agent" },
      { kind: "terminal", terminalId: "terminal" },
      { kind: "files" },
      { kind: "changes_tree" },
    ]);
    expect(
      collectAllTabs(restored.getState().layoutByWorkspace["host:two"].root).map(
        (tab) => tab.target,
      ),
    ).toEqual([{ kind: "file", path: "README.md" }, { kind: "files" }, { kind: "changes_tree" }]);
  });
});
