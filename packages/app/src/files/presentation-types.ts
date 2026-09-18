export function getMediaKind(mimeType: string): "video" | "audio" | null {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return null;
}

export interface ReservedFileTab {
  open(url: string): void | Promise<void>;
  close(): void;
}
