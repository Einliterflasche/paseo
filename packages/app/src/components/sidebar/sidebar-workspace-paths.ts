import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarWorkspacePathGroup {
  path: string | null;
  label: string;
  workspaces: SidebarWorkspacePlacement[];
}

function homePathLabel(path: string, homeDirectory: string | undefined): string {
  // COMPAT(hostHomeDirectory): added in fork v0.10.0, remove after 2027-04-05.
  if (!homeDirectory) return path;
  const normalizedPath = path.replace(/\\/g, "/");
  const home = homeDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const windowsHome = /^[a-zA-Z]:\//.test(home);
  const comparablePath = windowsHome ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableHome = windowsHome ? home.toLowerCase() : home;
  if (comparablePath.replace(/\/+$/, "") === comparableHome) return "~";
  if (comparablePath.startsWith(`${comparableHome}/`)) {
    return `~/${normalizedPath.slice(home.length + 1)}`;
  }
  return path;
}

export function groupSidebarWorkspacesByPath(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  homeDirectoryByServerId?: ReadonlyMap<string, string | undefined>,
): SidebarWorkspacePathGroup[] {
  const groups = new Map<string, SidebarWorkspacePathGroup>();
  for (const workspace of workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    const path = entry?.workspaceDirectory ?? workspace.workspaceDirectory ?? null;
    // A missing descriptor does not establish that two workspaces share a directory.
    const key = path === null ? `workspace:${workspace.workspaceKey}` : `path:${path}`;
    let group = groups.get(key);
    if (!group) {
      const label = homePathLabel(path ?? "", homeDirectoryByServerId?.get(workspace.serverId));
      group = { path, label, workspaces: [] };
      groups.set(key, group);
    }
    group.workspaces.push(workspace);
  }
  return Array.from(groups.values());
}
