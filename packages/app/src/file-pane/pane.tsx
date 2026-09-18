import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ScrollView as RNScrollView, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore, type ExplorerFile } from "@/stores/session-store";
import { filePreviewRenderKind } from "@/components/file-pane-render-mode";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { getFileNameFromPath } from "@/attachments/utils";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { isFileQueryEnabled } from "@/components/file-pane-enabled";
import { isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import { useFileDownload } from "@/hooks/use-file-download";
import { useFileAccess, resolveFilePreviewUrl } from "@/files/access";
import { getMediaKind } from "@/files/presentation";
import { useLiveFile } from "./live-file/hook";
import { useFilePreview } from "./preview-lifecycle/hook";
import {
  resolveFilePreviewLifecycle,
  type FilePreviewLifecycleSnapshot,
} from "./preview-lifecycle/model";
import { FilePanelBar } from "./bar";
import { FileHtmlPreview } from "./html-preview";
import { FileMarkdownPreview } from "./markdown-preview";
import { MediaPreview } from "./media-preview";
import { PdfPreview } from "./pdf-preview";
import { FileEditorModel, getFileConflictCallout, type FileConflictCallout } from "./editor/model";
import { createFileObservationSource } from "./editor/observation-source";
import { FileEditorView } from "./editor/view";
import { FileSourceView } from "./source/view";
import type { FileConflictAlertState } from "./conflict-alert";
import type { LiveFileModel } from "./live-file/model";
import { confirmDialog } from "@/utils/confirm-dialog";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import type { Theme } from "@/styles/theme";
import { ZoomableImage } from "@/components/zoomable-viewport/image";

type FileAccessResult = NonNullable<ReturnType<typeof useFileAccess>["data"]>;
type AccessFile = NonNullable<FileAccessResult["file"]>;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface FilePreviewBodyProps {
  preview: ExplorerFile | null;
  mode?: "preview" | "source";
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  imagePreviewUri: string | null;
}

type TextExplorerFile = ExplorerFile & { kind: "text" };

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function classifyAccessedFile(file: AccessFile | null): {
  mediaKind: "video" | "audio" | null;
  isPdf: boolean;
} {
  if (!file) {
    return { mediaKind: null, isPdf: false };
  }
  return { mediaKind: getMediaKind(file.mimeType), isPdf: file.mimeType === "application/pdf" };
}

function resolveAccessErrorMessage(input: {
  isError: boolean;
  error: unknown;
  hasData: boolean;
  connectionError: string | null;
  fallback: string;
}): string | null {
  if (input.isError) {
    return input.error instanceof Error ? input.error.message : input.fallback;
  }
  // Metadata already loaded once (even if now stale) keeps rendering from
  // that data — a later offline blip must not blank out an open editor.
  if (!input.hasData && input.connectionError) {
    return input.connectionError;
  }
  return null;
}

function resolveMediaUrl(input: {
  mediaKind: "video" | "audio" | null;
  previewToken: string | null;
  serverId: string;
  fallback: string;
}): { url: string | null; error: string | null } {
  if (!input.mediaKind || !input.previewToken) {
    return { url: null, error: null };
  }
  // resolveFilePreviewUrl throws when the connection dropped since access
  // resolved; catch here so no render path ever throws.
  try {
    return { url: resolveFilePreviewUrl(input.serverId, input.previewToken), error: null };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : input.fallback };
  }
}

function isTextExplorerFile(file: ExplorerFile | null): file is TextExplorerFile {
  return file !== null && file.kind === "text";
}

function isLiveReadableKind(kind: AccessFile["kind"] | undefined): boolean {
  return kind === "text" || kind === "image";
}

function derivePreviewDisplayState(input: {
  previewLifecycle: FilePreviewLifecycleSnapshot;
  preview: ExplorerFile | null;
  hasLineTarget: boolean;
  path: string;
  previewMode: "preview" | "source";
  setPreviewMode: (mode: "preview" | "source") => void;
}): {
  lineCount: number | undefined;
  errorMessage: string | null;
  isLoading: boolean;
  activePreviewMode: "preview" | "source" | undefined;
  activeOnPreviewModeChange: ((mode: "preview" | "source") => void) | undefined;
} {
  const canTogglePreviewMode =
    isRenderablePreview(input.preview, input.path) && !input.hasLineTarget;
  const lineCount =
    input.preview?.kind === "text" ? (input.preview.content ?? "").split("\n").length : undefined;
  const errorMessage =
    input.previewLifecycle.status === "error" ? input.previewLifecycle.message : null;
  const isLoading =
    input.previewLifecycle.status === "initial" ||
    input.previewLifecycle.status === "read_pending" ||
    input.previewLifecycle.status === "preparing";
  return {
    lineCount,
    errorMessage,
    isLoading,
    activePreviewMode: canTogglePreviewMode ? input.previewMode : undefined,
    activeOnPreviewModeChange: canTogglePreviewMode ? input.setPreviewMode : undefined,
  };
}

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ReadonlySource({
  preview,
  filename,
  location,
  navigationRevision,
}: {
  preview: ExplorerFile;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const theme = UnistylesRuntime.getTheme();
  const { t } = useTranslation();
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [theme],
  );
  return (
    <FileSourceView
      content={preview.content ?? ""}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      size={preview.size}
      theme={visualTheme}
      tooLargeMessage={t("panels.file.tooLargeToDisplay")}
    />
  );
}

function TooLargeSource({ size }: { size?: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="file-source-too-large">
      <Text style={styles.emptyText}>{t("panels.file.tooLargeToDisplay")}</Text>
      {size ? <Text style={styles.binaryMetaText}>{formatFileSize({ size })}</Text> : null}
    </View>
  );
}

function BinaryFilePreview({
  fileName,
  size,
  onDownload,
}: {
  fileName: string;
  size: number;
  onDownload?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="file-binary-preview">
      <Text style={styles.emptyText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
      <Text style={styles.binaryMetaText}>
        {fileName} · {formatFileSize({ size })}
      </Text>
      {onDownload ? (
        <Button variant="outline" size="sm" onPress={onDownload}>
          {t("workspace.fileActions.download")}
        </Button>
      ) : null}
    </View>
  );
}

function FilePreviewBody({
  preview,
  mode,
  isLoading,
  isMobile: _isMobile,
  location,
  navigationRevision,
  imagePreviewUri,
}: FilePreviewBodyProps) {
  const { t } = useTranslation();
  const filePath = location.path;
  // A line target means the caller wants to land on that line, so fall back to
  // the highlighted source view even for renderable files.
  const renderKind =
    preview?.kind === "text" && !location.lineStart && mode !== "source"
      ? filePreviewRenderKind(filePath)
      : null;

  const previewScrollRef = useRef<RNScrollView>(null);

  if (isLoading && !preview) {
    return (
      <View style={styles.centerState} testID="file-preview-loading">
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={styles.centerState} testID="file-preview-unsupported">
        <Text style={styles.emptyText}>{t("panels.file.noPreview")}</Text>
      </View>
    );
  }

  if (preview.kind === "text") {
    if (renderKind === "html") {
      // The HTML document owns its own scrolling, so no ScrollView wrapper here.
      return (
        <View style={styles.previewScrollContainer}>
          <FileHtmlPreview html={preview.content ?? ""} testID="file-html-preview" />
        </View>
      );
    }

    if (renderKind === "markdown") {
      return (
        <View style={styles.previewScrollContainer}>
          <RNScrollView
            ref={previewScrollRef}
            style={styles.previewContent}
            showsVerticalScrollIndicator
          >
            <FileMarkdownPreview source={preview.content ?? ""} />
          </RNScrollView>
        </View>
      );
    }

    return (
      <ReadonlySource
        preview={preview}
        filename={filePath}
        location={location}
        navigationRevision={navigationRevision}
      />
    );
  }

  if (preview.kind === "image") {
    if (!imagePreviewUri) {
      return (
        <View style={styles.centerState}>
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
        </View>
      );
    }

    return <ZoomableImage uri={imagePreviewUri} testID="image-file-preview" />;
  }

  return (
    <View style={styles.centerState}>
      <Text style={styles.emptyText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
      <Text style={styles.binaryMetaText}>{formatFileSize({ size: preview.size })}</Text>
    </View>
  );
}

export function FilePane({
  serverId,
  workspaceRoot,
  location,
  navigationRevision,
}: {
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const [previewMode, setPreviewMode] = useState<"preview" | "source">("preview");

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
  const supportsEditing = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceFileEditing === true,
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const normalizedFilePath = useMemo(() => trimNonEmpty(location.path), [location.path]);
  const readTarget = useMemo(
    () =>
      normalizedFilePath
        ? resolveFilePreviewReadTarget({
            path: normalizedFilePath,
            workspaceRoot: normalizedWorkspaceRoot,
          })
        : null,
    [normalizedFilePath, normalizedWorkspaceRoot],
  );

  // Re-read the file when this pane becomes visible again (#445). `isActive`
  // covers tab switches; active app visibility covers backgrounding and returning
  // from another window after an external edit. The gate lives in isFileQueryEnabled.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const enabled = isFileQueryEnabled({
    hasReadTarget: Boolean(client && readTarget),
    isTabActive: isActive,
    isAppVisible,
  });
  const targetCwd = readTarget?.cwd ?? null;
  const targetPath = readTarget?.path ?? null;

  // Obtain metadata before the live text read: a video/audio/PDF file gets its
  // own player/placeholder and must never flow through the text-preview budget.
  const access = useFileAccess({ serverId, cwd: targetCwd, path: targetPath, enabled });
  const accessFile = access.data?.file ?? null;
  const { mediaKind, isPdf } = classifyAccessedFile(accessFile);
  const accessErrorMessage = resolveAccessErrorMessage({
    isError: access.isError,
    error: access.error,
    hasData: access.data !== undefined,
    connectionError: access.connectionError,
    fallback: t("panels.file.failedToLoad"),
  });
  const previewToken = access.data?.previewToken ?? null;
  const mediaUrl = useMemo(
    () =>
      resolveMediaUrl({
        mediaKind,
        previewToken,
        serverId,
        fallback: t("panels.file.failedToLoadPreview"),
      }),
    [mediaKind, previewToken, serverId, t],
  );

  // Only text/image content goes through the live-read/text-preview pipeline.
  // Media, PDF, and ordinary binary files are rendered from access metadata
  // alone and never get whole-read into the text-preview budget.
  const liveFile = useLiveFile({
    client,
    cwd: targetCwd,
    path: targetPath,
    enabled: enabled && isLiveReadableKind(accessFile?.kind),
    liveUpdates: supportsEditing,
  });

  const targetKey = readTarget ? `${readTarget.cwd}:${readTarget.path}` : null;
  const previewLifecycle = useFilePreview({
    targetKey,
    liveFileSnapshot: liveFile.snapshot,
  });

  useEffect(() => setPreviewMode("preview"), [targetKey]);

  const { file: preview, imageAttachment } = resolveFilePreviewLifecycle(previewLifecycle);
  const imagePreviewUri = useAttachmentPreviewUrl(imageAttachment);
  const editable = isEditableTextFile({
    preview,
    supportsEditing,
  });
  const { lineCount, errorMessage, isLoading, activePreviewMode, activeOnPreviewModeChange } =
    derivePreviewDisplayState({
      previewLifecycle,
      preview,
      hasLineTarget: Boolean(location.lineStart),
      path: location.path,
      previewMode,
      setPreviewMode,
    });

  const filename = getFileNameFromPath(location.path) ?? location.path;
  const downloadFile = useFileDownload({
    serverId,
    workspaceRoot: targetCwd ?? normalizedWorkspaceRoot,
  });
  const downloadCurrentFile = useCallback(() => {
    if (!readTarget) return;
    downloadFile({ fileName: filename, path: readTarget.path });
  }, [downloadFile, filename, readTarget]);
  const onDownload = readTarget ? downloadCurrentFile : undefined;
  const retryMediaAccess = useCallback(async () => {
    const result = await access.refetch();
    if (result.error) {
      throw result.error;
    }
  }, [access]);

  return (
    <FilePanePresentation
      serverId={serverId}
      client={client}
      readTarget={readTarget}
      preview={preview}
      liveFile={liveFile.model}
      onRetryRead={liveFile.refresh}
      retryingRead={liveFile.isRetrying}
      retryLabel={t("common.actions.retry")}
      filename={filename}
      previewMode={activePreviewMode}
      onPreviewModeChange={activeOnPreviewModeChange}
      lineCount={lineCount}
      editable={editable}
      disconnectedMessage={t("workspace.terminal.hostDisconnected")}
      errorMessage={errorMessage}
      isLoading={isLoading}
      isMobile={isMobile}
      location={location}
      navigationRevision={navigationRevision}
      imagePreviewUri={imagePreviewUri}
      onDownload={onDownload}
      mediaKind={mediaKind}
      isPdf={isPdf}
      accessFile={accessFile}
      accessErrorMessage={accessErrorMessage}
      mediaUrl={mediaUrl.url}
      mediaUrlError={mediaUrl.error}
      onRetryAccess={access.refetch}
      onRetryMediaAccess={retryMediaAccess}
      isPanelActive={isActive}
    />
  );
}

function isRenderablePreview(preview: ExplorerFile | null, path: string): boolean {
  return preview?.kind === "text" && filePreviewRenderKind(path) !== null;
}

function isEditableTextFile(input: {
  preview: ExplorerFile | null;
  supportsEditing: boolean;
}): boolean {
  return Boolean(
    isWeb &&
    input.supportsEditing &&
    input.preview?.kind === "text" &&
    input.preview.size <= 1024 * 1024,
  );
}

type FilePaneView =
  | { kind: "disconnected" }
  | { kind: "accessError"; message: string }
  | {
      kind: "media";
      mediaKind: "video" | "audio";
      accessFile: AccessFile;
      url: string | null;
      urlError: string | null;
    }
  | { kind: "pdf"; accessFile: AccessFile; cwd: string; path: string }
  | { kind: "binary"; accessFile: AccessFile }
  | { kind: "editable"; client: DaemonClient; cwd: string; path: string; preview: TextExplorerFile }
  | { kind: "tooLarge" }
  | { kind: "error"; message: string }
  | { kind: "default" };

function resolveFilePaneView(input: {
  client: DaemonClient | null;
  readTarget: { cwd: string; path: string } | null;
  accessErrorMessage: string | null;
  accessFile: AccessFile | null;
  mediaKind: "video" | "audio" | null;
  isPdf: boolean;
  mediaUrl: string | null;
  mediaUrlError: string | null;
  editable: boolean;
  preview: ExplorerFile | null;
  errorMessage: string | null;
}): FilePaneView {
  const { client, readTarget } = input;
  if (!client && readTarget) {
    return { kind: "disconnected" };
  }
  if (!client || !readTarget) {
    return { kind: "default" };
  }
  // Once loaded, the editor owns its draft and file-conflict handling. A failed
  // metadata refresh (or changed file classification) must not unmount that owner.
  const { preview } = input;
  if (input.editable && isTextExplorerFile(preview)) {
    return {
      kind: "editable",
      client,
      cwd: readTarget.cwd,
      path: readTarget.path,
      preview,
    };
  }
  if (input.accessErrorMessage) {
    return { kind: "accessError", message: input.accessErrorMessage };
  }
  if (input.accessFile && input.mediaKind) {
    return {
      kind: "media",
      mediaKind: input.mediaKind,
      accessFile: input.accessFile,
      url: input.mediaUrl,
      urlError: input.mediaUrlError,
    };
  }
  if (input.accessFile && input.isPdf) {
    return {
      kind: "pdf",
      accessFile: input.accessFile,
      cwd: readTarget.cwd,
      path: readTarget.path,
    };
  }
  if (input.accessFile && input.accessFile.kind === "binary") {
    return { kind: "binary", accessFile: input.accessFile };
  }
  if (input.errorMessage === "File is too large to display") {
    return { kind: "tooLarge" };
  }
  if (input.errorMessage) {
    return { kind: "error", message: input.errorMessage };
  }
  return { kind: "default" };
}

function FilePanePresentation({
  serverId,
  client,
  readTarget,
  preview,
  liveFile,
  onRetryRead,
  retryingRead,
  retryLabel,
  filename,
  previewMode,
  onPreviewModeChange,
  lineCount,
  editable,
  disconnectedMessage,
  errorMessage,
  isLoading,
  isMobile,
  location,
  navigationRevision,
  imagePreviewUri,
  onDownload,
  mediaKind,
  isPdf,
  accessFile,
  accessErrorMessage,
  mediaUrl,
  mediaUrlError,
  onRetryAccess,
  onRetryMediaAccess,
  isPanelActive,
}: {
  serverId: string;
  client: DaemonClient | null;
  readTarget: { cwd: string; path: string } | null;
  preview: ExplorerFile | null;
  liveFile: LiveFileModel;
  onRetryRead: () => void;
  retryingRead: boolean;
  retryLabel: string;
  filename: string;
  previewMode?: "preview" | "source";
  onPreviewModeChange?: (mode: "preview" | "source") => void;
  lineCount?: number;
  editable: boolean;
  disconnectedMessage: string;
  errorMessage: string | null;
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  imagePreviewUri: string | null;
  onDownload?: () => void;
  mediaKind: "video" | "audio" | null;
  isPdf: boolean;
  accessFile: AccessFile | null;
  accessErrorMessage: string | null;
  mediaUrl: string | null;
  mediaUrlError: string | null;
  onRetryAccess: () => void;
  onRetryMediaAccess: () => Promise<void>;
  isPanelActive: boolean;
}) {
  const view = resolveFilePaneView({
    client,
    readTarget,
    accessErrorMessage,
    accessFile,
    mediaKind,
    isPdf,
    mediaUrl,
    mediaUrlError,
    editable,
    preview,
    errorMessage,
  });

  switch (view.kind) {
    case "disconnected":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <View style={styles.centerState}>
            <Text style={styles.errorText}>{disconnectedMessage}</Text>
          </View>
        </View>
      );

    case "accessError":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <FilePanelBar onDownload={onDownload} />
          <View style={styles.centerState}>
            <Text style={styles.errorText}>{view.message}</Text>
            <Button variant="outline" size="sm" onPress={onRetryAccess}>
              {retryLabel}
            </Button>
          </View>
        </View>
      );

    case "media":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <FilePanelBar size={view.accessFile.size} onDownload={onDownload} />
          {view.url ? (
            <MediaPreview
              kind={view.mediaKind}
              src={view.url}
              fileName={view.accessFile.fileName}
              size={view.accessFile.size}
              isActive={isPanelActive}
              onDownload={onDownload}
              onRetry={onRetryMediaAccess}
            />
          ) : (
            <View style={styles.centerState}>
              <Text style={styles.errorText}>{view.urlError ?? disconnectedMessage}</Text>
              <Button variant="outline" size="sm" onPress={onRetryAccess}>
                {retryLabel}
              </Button>
            </View>
          )}
        </View>
      );

    case "pdf":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <FilePanelBar size={view.accessFile.size} onDownload={onDownload} />
          <PdfPreview
            serverId={serverId}
            cwd={view.cwd}
            path={view.path}
            fileName={view.accessFile.fileName}
            size={view.accessFile.size}
            onDownload={onDownload}
          />
        </View>
      );

    case "binary":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <FilePanelBar size={view.accessFile.size} onDownload={onDownload} />
          <BinaryFilePreview
            fileName={view.accessFile.fileName}
            size={view.accessFile.size}
            onDownload={onDownload}
          />
        </View>
      );

    case "editable":
      return (
        <EditableFilePane
          key={`${serverId}:${view.cwd}:${view.path}`}
          client={view.client}
          cwd={view.cwd}
          path={view.path}
          preview={view.preview}
          liveFile={liveFile}
          onRetryRead={onRetryRead}
          retryingRead={retryingRead}
          filename={filename}
          mode={previewMode}
          onModeChange={onPreviewModeChange}
          isLoading={isLoading}
          isMobile={isMobile}
          location={location}
          navigationRevision={navigationRevision}
          onDownload={onDownload}
        />
      );

    case "tooLarge":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <FilePanelBar onDownload={onDownload} />
          <TooLargeSource />
        </View>
      );

    case "error":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          <FilePanelBar onDownload={onDownload} />
          <View style={styles.centerState}>
            <Text style={styles.errorText}>{view.message}</Text>
            <Button variant="outline" size="sm" onPress={onRetryRead} loading={retryingRead}>
              {retryLabel}
            </Button>
          </View>
        </View>
      );

    case "default":
      return (
        <View style={styles.container} testID="workspace-file-pane">
          {preview || onDownload ? (
            <FilePanelBar
              size={preview?.size}
              lineCount={lineCount}
              mode={previewMode}
              onModeChange={onPreviewModeChange}
              onDownload={onDownload}
            />
          ) : null}
          <FilePreviewBody
            preview={preview}
            mode={previewMode}
            isLoading={isLoading}
            isMobile={isMobile}
            location={location}
            navigationRevision={navigationRevision}
            imagePreviewUri={imagePreviewUri}
          />
        </View>
      );
  }
}

function EditableFilePane({
  client,
  cwd,
  path,
  preview,
  liveFile,
  onRetryRead,
  retryingRead,
  filename,
  mode,
  onModeChange,
  isLoading,
  isMobile,
  location,
  navigationRevision,
  onDownload,
}: {
  client: DaemonClient;
  cwd: string;
  path: string;
  preview: TextExplorerFile;
  liveFile: LiveFileModel;
  onRetryRead: () => void;
  retryingRead: boolean;
  filename: string;
  mode?: "preview" | "source";
  onModeChange?: (mode: "preview" | "source") => void;
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  onDownload?: () => void;
}) {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [vimMode, setVimMode] = useState<string | null>(settings.vimKeybindings ? "NORMAL" : null);
  const session = useMemo(
    () => ({
      write(input: { content: string; expectedModifiedAt: string; expectedRevision?: string }) {
        return client.writeFile({ cwd, path, ...input });
      },
    }),
    [client, cwd, path],
  );
  const [model] = useState(() => {
    return new FileEditorModel({
      file: {
        content: preview.content ?? "",
        hasBom: preview.hasBom,
        version: {
          status: "ready",
          cwd,
          path,
          size: preview.size,
          modifiedAt: preview.modifiedAt,
          revision: preview.revision,
        },
      },
      session,
    });
  });
  useEffect(() => {
    const source = createFileObservationSource(liveFile);
    model.connectFileObservations(source);
    return () => model.disconnectFileObservations();
  }, [liveFile, model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const suspendPendingSave = useCallback(() => model.suspendAutosave(), [model]);
  usePublishPanelInstanceAttributes({ modified: snapshot.modified, suspendPendingSave });
  const theme = UnistylesRuntime.getTheme();
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [
      theme.colors.border,
      theme.colors.foreground,
      theme.colors.foregroundMuted,
      theme.colors.surface0,
      theme.colors.syntax,
      theme.colors.terminal.cursor,
      theme.colors.terminal.selectionBackground,
      theme.colorScheme,
      theme.fontFamily.mono,
      theme.fontSize.code,
    ],
  );

  useEffect(() => () => model.dispose(), [model]);

  const handleReload = useCallback(() => {
    if (!snapshot.modified) {
      void model.reload();
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("panels.file.editor.reloadTitle"),
        message: t("panels.file.editor.reloadMessage"),
        confirmLabel: t("panels.file.editor.reload"),
        destructive: true,
      });
      if (confirmed) void model.reload();
    })();
  }, [model, snapshot.modified, t]);
  const handleOverwrite = useCallback(() => void model.overwrite(), [model]);
  const conflict = fileConflictAlertState({
    callout: getFileConflictCallout(snapshot),
    onOverwrite: handleOverwrite,
    onReload: handleReload,
    onRetry: onRetryRead,
    retrying: retryingRead,
  });
  const handleVimModeChange = useCallback((nextMode: string | null) => setVimMode(nextMode), []);
  const renderedPreview = useMemo<ExplorerFile>(
    () => ({
      ...preview,
      content: snapshot.content,
      size: snapshot.version.status === "ready" ? snapshot.version.size : preview.size,
      modifiedAt:
        snapshot.version.status === "ready" ? snapshot.version.modifiedAt : preview.modifiedAt,
    }),
    [preview, snapshot.content, snapshot.version],
  );
  const showSource = mode !== "preview";

  return (
    <View style={styles.container} testID="workspace-file-pane">
      <FilePanelBar
        size={
          snapshot.observedVersion.status === "ready" ? snapshot.observedVersion.size : preview.size
        }
        lineCount={snapshot.content.split("\n").length}
        editorStatus={snapshot.status}
        cursor={showSource ? cursor : undefined}
        vimMode={showSource ? vimMode : null}
        conflict={conflict}
        mode={mode}
        onModeChange={onModeChange}
        onDownload={onDownload}
      />
      {showSource ? (
        <FileEditorView
          model={model}
          filename={filename}
          location={location}
          navigationRevision={navigationRevision}
          vimEnabled={settings.vimKeybindings}
          theme={visualTheme}
          onCursorChange={setCursor}
          onVimModeChange={handleVimModeChange}
        />
      ) : (
        <FilePreviewBody
          preview={renderedPreview}
          mode={mode}
          isLoading={isLoading}
          isMobile={isMobile}
          location={location}
          navigationRevision={navigationRevision}
          imagePreviewUri={null}
        />
      )}
    </View>
  );
}

function fileConflictAlertState(input: {
  callout: FileConflictCallout | null;
  onOverwrite(): void;
  onReload(): void;
  onRetry(): void;
  retrying: boolean;
}): FileConflictAlertState | undefined {
  if (!input.callout) return undefined;
  if (input.callout.kind === "deleted") return { kind: "deleted" };
  if (input.callout.kind === "checkFailed") {
    return { kind: "checkFailed", retrying: input.retrying, onRetry: input.onRetry };
  }
  return {
    kind: "changed",
    canOverwrite: input.callout.canOverwrite,
    onReload: input.onReload,
    onOverwrite: input.onOverwrite,
  };
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  loadingText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  binaryMetaText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
  },
  previewContent: {
    flex: 1,
    minHeight: 0,
  },
  previewCodeScrollContent: {
    padding: theme.spacing[4],
  },
}));
