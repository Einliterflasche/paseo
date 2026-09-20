import { z } from "zod";

export const WorkspaceServiceIdentitySchema = z.object({
  workspaceId: z.string().min(1),
  scriptName: z.string().min(1),
});

export const WorkspaceServiceRestartSnapshotSchema = z
  .array(WorkspaceServiceIdentitySchema)
  .superRefine((services, context) => {
    const seen = new Set<string>();
    for (const [index, service] of services.entries()) {
      const identity = `${service.workspaceId}\0${service.scriptName}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate workspace service identity",
          path: [index],
        });
      }
      seen.add(identity);
    }
  });

export type WorkspaceServiceIdentity = z.infer<typeof WorkspaceServiceIdentitySchema>;
export type WorkspaceServiceRestartSnapshot = z.infer<typeof WorkspaceServiceRestartSnapshotSchema>;
