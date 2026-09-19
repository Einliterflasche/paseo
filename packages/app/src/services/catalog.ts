import type { WorkspaceScriptPayload, ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export type CatalogWorkspace = Pick<
  WorkspaceDescriptor,
  "id" | "name" | "title" | "projectDisplayName" | "archivingAt" | "scripts"
>;

export interface ServiceCatalogEntry extends Pick<
  WorkspaceScriptPayload,
  "scriptName" | "port" | "lifecycle" | "health" | "exitCode" | "terminalId"
> {
  id: string;
  workspaceId: string;
  workspaceName: string;
  projectName: string;
  previewServiceId?: string;
  previewEnrollment?: NonNullable<
    NonNullable<ServerInfoStatusPayload["servicePreviews"]>["managedEnrollments"]
  >[number];
}

interface CatalogInput {
  serverId: string;
  workspaces: Iterable<CatalogWorkspace>;
  previews?: ServerInfoStatusPayload["servicePreviews"];
}

export function buildServiceCatalog({
  serverId,
  workspaces,
  previews,
}: CatalogInput): ServiceCatalogEntry[] {
  const services: ServiceCatalogEntry[] = [];
  for (const workspace of workspaces) {
    if (workspace.archivingAt) continue;
    for (const script of workspace.scripts) {
      if (script.type !== "service") continue;
      const preview = previews?.services.find(
        (service) =>
          service.available &&
          service.workspaceId === workspace.id &&
          service.scriptName === script.scriptName,
      );
      const previewEnrollment = previews?.managedEnrollments?.find(
        (entry) => entry.workspaceId === workspace.id && entry.scriptName === script.scriptName,
      );
      services.push({
        id: JSON.stringify([serverId, workspace.id, script.scriptName]),
        workspaceId: workspace.id,
        workspaceName: workspace.title || workspace.name,
        projectName: workspace.projectDisplayName,
        scriptName: script.scriptName,
        port: script.port,
        lifecycle: script.lifecycle,
        health: script.health,
        exitCode: script.exitCode,
        terminalId: script.terminalId,
        ...(preview ? { previewServiceId: preview.serviceId } : {}),
        ...(previewEnrollment ? { previewEnrollment } : {}),
      });
    }
  }
  return services;
}
