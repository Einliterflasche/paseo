import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToastApi } from "@/components/toast-host";
import { normalizeInlinePathTarget, type InlinePathTarget } from "@/assistant-file-links/parse";
import type { FileOpenPreparation } from "@/assistant-file-links/provider";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useDownloadStore } from "@/stores/download-store";
import { useStableEvent } from "@/hooks/use-stable-event";
import { captureFileConnection, requestFileAccess } from "./access";
import { fileGrantUrl } from "./http-target";
import { browserCanPlay, browserCanViewPdf, reserveFileTab } from "./presentation";
import { decideFileOpening } from "./open-decision";

// This callback is invoked by the link click, never by a pane lifecycle effect.
export function useOpenLinkedFile(input: {
  serverId: string;
  workspaceRoot?: string;
  openPane: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}) {
  const { t } = useTranslation();
  const current = useRef(input);
  current.current = input;
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const open: (
    target: InlinePathTarget,
    disposition: OpenFileDisposition,
    preparation?: FileOpenPreparation,
    knownPdf?: boolean,
  ) => void = useStableEvent(
    (
      target: InlinePathTarget,
      disposition: OpenFileDisposition,
      preparation?: FileOpenPreparation,
      knownPdf = false,
    ) => {
      const captured = current.current;
      if (!mounted.current) {
        preparation?.tab?.close();
        return;
      }
      if (!normalizeInlinePathTarget(target.path, captured.workspaceRoot)?.file) {
        preparation?.tab?.close();
        captured.openPane(target, disposition);
        return;
      }
      const key = JSON.stringify([captured.serverId, captured.workspaceRoot, target.path]);
      if (pending.current.has(key)) {
        preparation?.tab?.close();
        return;
      }
      pending.current.add(key);
      const canViewPdf = browserCanViewPdf();
      // Popup permission belongs to this gesture, not the later RPC completion.
      let tab = preparation?.tab ?? null;
      if (!preparation && canViewPdf && (knownPdf || /\.pdf$/i.test(target.path)))
        tab = reserveFileTab();
      const stillCurrent = () =>
        mounted.current &&
        current.current.serverId === captured.serverId &&
        current.current.workspaceRoot === captured.workspaceRoot;
      captured.toast?.show(t("fileOpening.pending"), { durationMs: null });

      void (async () => {
        let isPdf = knownPdf;
        try {
          const readTarget = resolveFilePreviewReadTarget({
            path: target.path,
            workspaceRoot: captured.workspaceRoot,
          });
          if (!readTarget) throw new Error(t("fileOpening.missingPath"));
          const connection = captureFileConnection(captured.serverId);
          const result = await requestFileAccess(
            captured.serverId,
            readTarget.cwd,
            readTarget.path,
            true,
          );
          connection.assertCurrent();
          if (!stillCurrent()) {
            tab?.close();
            return;
          }
          const file = result.file;
          isPdf = file.mimeType === "application/pdf";
          const action = decideFileOpening(file, { canPlay: browserCanPlay, canViewPdf });
          if (action === "pane") {
            tab?.close();
            captured.openPane(target, disposition);
          } else if (action === "browser") {
            if (!tab) throw new Error(t("fileOpening.popupBlocked"));
            if (!result.previewToken) throw new Error(t("fileOpening.missingGrant"));
            await tab.open(fileGrantUrl(connection.httpTarget(), "preview", result.previewToken));
          } else {
            tab?.close();
            const downloaded = await useDownloadStore.getState().startDownload({
              serverId: captured.serverId,
              scopeId: readTarget.cwd,
              cwd: readTarget.cwd,
              path: readTarget.path,
              fileName: file.fileName,
            });
            if (!downloaded) throw new Error(t("fileOpening.downloadFailed"));
          }
          captured.toast?.show(
            t(action === "download" ? "fileOpening.downloadRequested" : "fileOpening.opened"),
            { durationMs: 1500 },
          );
        } catch (error) {
          tab?.close();
          if (stillCurrent()) {
            const message = error instanceof Error ? error.message : t("fileOpening.failed");
            captured.toast?.show(
              <FileOpenError
                message={message}
                target={target}
                disposition={disposition}
                knownPdf={isPdf}
                open={open}
              />,
              { variant: "error", durationMs: null, testID: "file-open-error" },
            );
          }
        } finally {
          pending.current.delete(key);
        }
      })();
    },
  );
  const prepare = useStableEvent(
    (hint: InlinePathTarget): FileOpenPreparation => ({
      tab: /\.pdf$/i.test(hint.path) && browserCanViewPdf() ? reserveFileTab() : null,
    }),
  );
  return { open, prepare };
}

function FileOpenError({
  message,
  target,
  disposition,
  knownPdf,
  open,
}: {
  message: string;
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
  knownPdf: boolean;
  open: (
    target: InlinePathTarget,
    disposition: OpenFileDisposition,
    preparation?: FileOpenPreparation,
    knownPdf?: boolean,
  ) => void;
}) {
  const { t } = useTranslation();
  const retry = useCallback(
    () => open(target, disposition, undefined, knownPdf),
    [open, target, disposition, knownPdf],
  );
  return (
    <View style={styles.error}>
      <Text style={styles.message}>{message}</Text>
      <Pressable accessibilityRole="button" onPress={retry} testID="file-open-retry">
        <Text style={styles.retry}>{t("common.actions.retry")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: { gap: theme.spacing[2] },
  message: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  retry: { color: theme.colors.primary, fontSize: theme.fontSize.sm },
}));
