import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
  projectName = "Project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName,
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

function rankedProjectInput(
  groups: { name: string; statuses: SidebarWorkspaceEntry["statusBucket"][] }[],
) {
  const entries = groups.map((group, index) => {
    const viewKey = `project-${index}`;
    const workspaces = group.statuses.map((status, workspaceIndex) =>
      makeWorkspace(`${viewKey}-${workspaceIndex}`, status, [], viewKey),
    );
    return {
      project: makeProject(
        workspaces.map(({ placement }) => placement),
        viewKey,
        group.name,
      ),
      workspaces,
    };
  });
  return {
    ...projectionInput(),
    projects: entries.map(({ project }) => project),
    pinnedKeys: { pinnedWorkspaceKeys: [] as string[], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map(
      entries.flatMap(({ workspaces }) =>
        workspaces.map(({ entry }) => [entry.workspaceKey, entry] as const),
      ),
    ),
    projectNamesByViewKey: new Map(
      entries.map(({ project }) => [project.viewKey, project.projectName]),
    ),
  };
}

describe("buildSidebarProjection", () => {
  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("ranks ready-to-review projects before working and idle projects without mutating input", () => {
    const input = rankedProjectInput([
      { name: "Alpha idle", statuses: ["done"] },
      { name: "Beta working", statuses: ["running"] },
      { name: "Zulu review", statuses: ["attention"] },
    ]);
    const projection = buildSidebarProjection(input);

    expect(projection.pinnedGroups.unpinnedProjects.map((project) => project.projectName)).toEqual([
      "Zulu review",
      "Beta working",
      "Alpha idle",
    ]);
    expect(input.projects.map((project) => project.projectName)).toEqual([
      "Alpha idle",
      "Beta working",
      "Zulu review",
    ]);
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "project-2-0",
      "project-1-0",
      "project-0-0",
    ]);
  });

  it("gives a mixed green and blue project the ready-to-review priority", () => {
    const input = rankedProjectInput([
      { name: "Alpha working", statuses: ["running", "done"] },
      { name: "Zulu mixed", statuses: ["running", "attention", "done"] },
    ]);

    expect(
      buildSidebarProjection(input).pinnedGroups.unpinnedProjects.map(
        (project) => project.projectName,
      ),
    ).toEqual(["Zulu mixed", "Alpha working"]);
  });

  it("sorts project names alphabetically within each workspace priority", () => {
    const input = rankedProjectInput([
      { name: "Zulu idle", statuses: ["done"] },
      { name: "Zulu working", statuses: ["running"] },
      { name: "Zulu review", statuses: ["attention"] },
      { name: "Alpha idle", statuses: ["done"] },
      { name: "Alpha working", statuses: ["running"] },
      { name: "Alpha review", statuses: ["attention"] },
    ]);

    expect(
      buildSidebarProjection(input).pinnedGroups.unpinnedProjects.map(
        (project) => project.projectName,
      ),
    ).toEqual([
      "Alpha review",
      "Zulu review",
      "Alpha working",
      "Zulu working",
      "Alpha idle",
      "Zulu idle",
    ]);
  });

  it("counts a pinned green workspace and preserves the explicit pinned workspace order", () => {
    const input = rankedProjectInput([
      { name: "Alpha working", statuses: ["running", "running"] },
      { name: "Zulu review", statuses: ["attention", "done"] },
    ]);
    const greenKey = "srv:project-1-0";
    const blueKey = "srv:project-0-0";
    const projection = buildSidebarProjection({
      ...input,
      pinnedKeys: { pinnedWorkspaceKeys: [greenKey, blueKey], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [blueKey, greenKey],
    });

    expect(projection.pinnedGroups.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      blueKey,
      greenKey,
    ]);
    expect(projection.pinnedGroups.unpinnedProjects.map((project) => project.projectName)).toEqual([
      "Zulu review",
      "Alpha working",
    ]);
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "project-0-0",
      "project-1-0",
      "project-1-1",
      "project-0-1",
    ]);
  });

  it("uses the filtered project cohort without resurrecting a hidden green workspace", () => {
    const input = rankedProjectInput([
      { name: "Zulu filtered", statuses: ["attention", "running"] },
      { name: "Alpha working", statuses: ["running"] },
    ]);
    input.projects[0] = {
      ...input.projects[0]!,
      workspaces: input.projects[0]!.workspaces.slice(1),
    };
    const projection = buildSidebarProjection(input);

    expect(projection.pinnedGroups.unpinnedProjects.map((project) => project.projectName)).toEqual([
      "Alpha working",
      "Zulu filtered",
    ]);
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "project-1-0",
      "project-0-1",
    ]);
  });

  it("keeps the existing project input and status group order in status mode", () => {
    const input = rankedProjectInput([
      { name: "Alpha idle", statuses: ["done"] },
      { name: "Zulu review", statuses: ["attention"] },
      { name: "Beta working", statuses: ["running"] },
    ]);
    const projection = buildSidebarProjection({ ...input, groupMode: "status" });

    expect(projection.pinnedGroups.unpinnedProjects).toBe(input.projects);
    expect(projection.workspaceGroups.map((group) => group.key)).toEqual([
      "attention",
      "running",
      "done",
    ]);
  });
});
