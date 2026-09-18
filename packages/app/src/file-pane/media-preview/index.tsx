import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatMediaFileSize, type MediaPreviewProps } from "./types";

// Native standalone media playback is outside scope; keep the download path visible.
export function MediaPreview({ fileName, size, onDownload }: MediaPreviewProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="file-media-preview-unavailable">
      <Text style={styles.fileName}>{fileName}</Text>
      <Text style={styles.meta}>{formatMediaFileSize(size)}</Text>
      {onDownload ? (
        <Button variant="outline" size="sm" onPress={onDownload}>
          {t("workspace.fileActions.download")}
        </Button>
      ) : null}
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
}));
