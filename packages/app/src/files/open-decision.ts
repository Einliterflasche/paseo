import { getMediaKind } from "./presentation-types";

export function decideFileOpening(
  file: { kind: "text" | "image" | "binary"; mimeType: string },
  capabilities: { canPlay: (mimeType: string) => boolean; canViewPdf: boolean },
): "pane" | "browser" | "download" {
  if (file.kind === "text" || file.kind === "image") return "pane";
  if (getMediaKind(file.mimeType) && capabilities.canPlay(file.mimeType)) return "pane";
  if (file.mimeType === "application/pdf" && capabilities.canViewPdf) return "browser";
  return "download";
}
