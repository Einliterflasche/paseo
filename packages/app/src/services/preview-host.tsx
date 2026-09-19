import type { ReactNode } from "react";
import type { createPreviewCoordinator, PreviewOpenState } from "./preview-coordinator";

export function ServicePreviewHost({ children }: { children: ReactNode }) {
  return children;
}

export function ServicePreviewAnchor({ children }: { children: ReactNode }) {
  return children;
}

export function useServicePreview(_mode: "iframe" | "tab" = "iframe"): {
  coordinator: ReturnType<typeof createPreviewCoordinator> | null;
  state: PreviewOpenState;
} {
  return { coordinator: null, state: { status: "idle" } };
}

export function useOpenServicePreview():
  | ((input: { serverId: string; workspaceId: string; serviceId: string }) => void)
  | null {
  return null;
}

export function useBrowserServicePreview(_context: { serverId: string; serviceId: string }): {
  coordinator: ReturnType<typeof createPreviewCoordinator> | null;
  state: PreviewOpenState;
} {
  return { coordinator: null, state: { status: "idle" } };
}
