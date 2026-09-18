export interface MediaPreviewProps {
  kind: "video" | "audio";
  src: string;
  fileName: string;
  size: number;
  isActive: boolean;
  onDownload?: () => void;
  /**
   * Re-acquires the preview grant before retrying playback — a stale token
   * would 404 again immediately. Rejects if the RPC itself fails, so the
   * caller can keep the error visible instead of clearing it optimistically.
   */
  onRetry: () => Promise<void>;
}

export function formatMediaFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
