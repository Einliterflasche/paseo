import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatMediaFileSize, type MediaPreviewProps } from "./types";

export function MediaPreview({
  kind,
  src,
  fileName,
  size,
  isActive,
  onDownload,
  onRetry,
}: MediaPreviewProps) {
  const { t } = useTranslation();
  const [hasError, setHasError] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // A retained/backgrounded panel keeps its element mounted; only stop playback.
  useEffect(() => {
    if (isActive) return;
    videoRef.current?.pause();
    audioRef.current?.pause();
  }, [isActive]);

  // The grant is single-file and connection-scoped: a src change means a fresh
  // token (retry, reconnect, or a different file), so any stale error clears.
  useEffect(() => {
    setHasError(false);
  }, [src]);

  const handleError = useCallback(() => setHasError(true), []);
  const handleRetry = useCallback(() => {
    setIsRetrying(true);
    void (async () => {
      try {
        // Re-acquire the grant before touching playback: retrying with a
        // known-stale token would just 404 again and leave the error stuck,
        // and a refetch that returns the same token wouldn't otherwise clear
        // this component's own error state.
        await onRetry();
        setHasError(false);
        setAttempt((value) => value + 1);
      } catch {
        // The RPC itself failed — keep the error visible.
      } finally {
        setIsRetrying(false);
      }
    })();
  }, [onRetry]);

  if (hasError) {
    return (
      <div style={CENTER_STYLE} data-testid="file-media-preview-error">
        <p style={MESSAGE_STYLE}>{t("panels.file.media.loadError")}</p>
        <p style={META_STYLE}>
          {fileName} · {formatMediaFileSize(size)}
        </p>
        <div style={ACTIONS_STYLE}>
          <Button variant="outline" size="sm" onPress={handleRetry} loading={isRetrying}>
            {t("common.actions.retry")}
          </Button>
          {onDownload ? (
            <Button variant="outline" size="sm" onPress={onDownload}>
              {t("workspace.fileActions.download")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <video
        key={attempt}
        ref={videoRef}
        src={src}
        controls
        autoPlay={false}
        preload="metadata"
        onError={handleError}
        style={VIDEO_STYLE}
        data-testid="file-video-preview"
      />
    );
  }

  return (
    <div style={AUDIO_WRAP_STYLE}>
      <audio
        key={attempt}
        ref={audioRef}
        src={src}
        controls
        autoPlay={false}
        preload="metadata"
        onError={handleError}
        style={AUDIO_STYLE}
        data-testid="file-audio-preview"
      />
    </div>
  );
}

const CENTER_STYLE = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  flexDirection: "column",
  justifyContent: "center",
  gap: "12px",
  padding: "16px",
} as const;
const MESSAGE_STYLE = { margin: 0 } as const;
const META_STYLE = { margin: 0, opacity: 0.7 } as const;
const ACTIONS_STYLE = { display: "flex", flexDirection: "row", gap: "8px" } as const;
const VIDEO_STYLE = { flex: 1, minHeight: 0, width: "100%", backgroundColor: "black" } as const;
const AUDIO_WRAP_STYLE = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  justifyContent: "center",
} as const;
const AUDIO_STYLE = { width: "100%", maxWidth: "480px" } as const;
