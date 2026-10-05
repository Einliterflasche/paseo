import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarWorkspacePathGroup {
  path: string | null;
  label: string;
  workspaces: SidebarWorkspacePlacement[];
}

function compactPathLabel(path: string, projectRoot: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const root = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (root && normalizedPath.startsWith(`${root}/`)) {
    return normalizedPath.slice(root.length + 1);
  }
  if (normalizedPath === root) {
    return normalizedPath.split("/").pop() || normalizedPath;
  }
  return normalizedPath.split("/").slice(-2).join("/");
}

export function groupSidebarWorkspacesByPath(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
): SidebarWorkspacePathGroup[] {
  const groups = new Map<string, SidebarWorkspacePathGroup>();
  for (const workspace of workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    const path = entry?.workspaceDirectory ?? workspace.workspaceDirectory ?? null;
    // A missing descriptor does not establish that two workspaces share a directory.
    const key = path === null ? `workspace:${workspace.workspaceKey}` : `path:${path}`;
    let group = groups.get(key);
    if (!group) {
      const label = compactPathLabel(
        path ?? "",
        entry?.projectRootPath ?? workspace.projectRootPath ?? "",
      );
      group = { path, label, workspaces: [] };
      groups.set(key, group);
    }
    group.workspaces.push(workspace);
  }
  const result = Array.from(groups.values());
  const labels = result.map((group) => group.label);
  for (const group of result) {
    if (!group.path || labels.filter((label) => label === group.label).length < 2) {
      continue;
    }
    // Keep enough of the suffix to distinguish paths with the same folder name.
    const parts = group.path.replace(/\\/g, "/").split("/");
    let depth = 2;
    while (
      depth < parts.length &&
      result.some(
        (other) =>
          other !== group &&
          other.path?.replace(/\\/g, "/").split("/").slice(-depth).join("/") ===
            parts.slice(-depth).join("/"),
      )
    ) {
      depth += 1;
    }
    group.label = depth === parts.length ? group.path : parts.slice(-depth).join("/");
  }
  return result;
}
