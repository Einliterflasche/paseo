import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { requestFileAccess, resolveFilePreviewUrl } from "@/files/access";
import { browserCanViewPdf, reserveFileTab } from "@/files/presentation";

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function PdfPreview({
  serverId,
  cwd,
  path,
  fileName,
  size,
  onDownload,
}: {
  serverId: string;
  cwd: string;
  path: string;
  fileName: string;
  size: number;
  onDownload?: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const handleOpen = useCallback(() => {
    // Reserve the tab synchronously, inside the click's user gesture, before any await.
    const tab = reserveFileTab();
    if (!tab) {
      setError(t("panels.file.pdf.tabBlocked"));
      return;
    }
    setError(null);
    setOpening(true);
    void (async () => {
      try {
        const access = await requestFileAccess(serverId, cwd, path, true);
        if (!access.previewToken) {
          throw new Error(t("panels.file.pdf.openFailed"));
        }
        await tab.open(resolveFilePreviewUrl(serverId, access.previewToken));
      } catch (err) {
        tab.close();
        setError(err instanceof Error ? err.message : t("panels.file.pdf.openFailed"));
      } finally {
        setOpening(false);
      }
    })();
  }, [cwd, path, serverId, t]);

  return (
    <View style={styles.container} testID="file-pdf-preview">
      <Text style={styles.fileName}>{fileName}</Text>
      <Text style={styles.meta}>{formatFileSize(size)}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {browserCanViewPdf() ? (
          <Button variant="outline" size="sm" onPress={handleOpen} loading={opening}>
            {t("panels.file.pdf.openInBrowser")}
          </Button>
        ) : null}
        {onDownload ? (
          <Button variant="outline" size="sm" onPress={onDownload}>
            {t("workspace.fileActions.download")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
}));
