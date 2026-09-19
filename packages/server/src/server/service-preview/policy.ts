import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const managedService = z
  .object({
    workspaceId: z.string().min(1),
    scriptName: z.string().min(1),
    name: z.string().trim().min(1),
    mount: z.enum(["preserve", "strip"]),
  })
  .strict();

function exactHttpsOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.origin === value;
  } catch {
    return false;
  }
}

const enabledPolicy = z
  .object({
    version: z.literal(1),
    enabled: z.literal(true),
    controlOrigin: z.string().refine(exactHttpsOrigin),
    managedServices: z.array(managedService),
  })
  .strict()
  .superRefine((policy, context) => {
    const identities = new Set<string>();
    for (const service of policy.managedServices) {
      const identity = JSON.stringify([service.workspaceId, service.scriptName]);
      if (identities.has(identity)) {
        context.addIssue({ code: "custom", message: "Duplicate managed preview enrollment" });
      }
      identities.add(identity);
    }
  });

export const PreviewFeaturePolicySchema = z.union([
  z.object({ version: z.literal(1), enabled: z.literal(false) }).strict(),
  enabledPolicy,
]);

export type PreviewFeaturePolicy = z.infer<typeof PreviewFeaturePolicySchema>;
export type PreviewManagedServicePolicy = z.infer<typeof managedService>;

export class PreviewPolicyError extends Error {
  constructor(
    readonly code: "invalid-policy" | "storage-error",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "PreviewPolicyError";
  }
}

/** Stable routing identity; changing a port or display name does not rename a tab. */
export function managedPreviewServiceId({
  workspaceId,
  scriptName,
}: Pick<PreviewManagedServicePolicy, "workspaceId" | "scriptName">): string {
  const identity = JSON.stringify([workspaceId, scriptName]);
  return `managed-${createHash("sha256").update(identity).digest("hex")}`;
}

/** Separate from core config so older daemons never validate or rewrite it. */
export async function readPreviewFeaturePolicy(paseoHome: string): Promise<PreviewFeaturePolicy> {
  let content: string;
  try {
    content = await readFile(path.join(paseoHome, "services", "policy-v1.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, enabled: false };
    throw new PreviewPolicyError("storage-error", { cause: error });
  }
  try {
    return PreviewFeaturePolicySchema.parse(JSON.parse(content));
  } catch {
    // Unknown versions, invalid fields and malformed files remain untouched.
    // A caller may disable previews, but must not replace this with empty state.
    throw new PreviewPolicyError("invalid-policy");
  }
}
