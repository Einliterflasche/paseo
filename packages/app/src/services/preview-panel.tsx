import { Globe } from "lucide-react-native";
import { useCallback, useEffect } from "react";
import { View, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { definePanel } from "@/panels/panel-registry";
import { ServicePreviewAnchor, useServicePreview } from "./preview-host";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useSessionStore } from "@/stores/session-store";
import type { PreviewOpenState } from "./preview-coordinator";

const PreviewIcon = withUnistyles(Globe);

function previewErrorKey(state: PreviewOpenState): string {
  if (state.status === "error" && state.code === "connection-ended") return "services.previewEnded";
  if (state.status === "error" && state.code === "close") return "services.previewCloseError";
  return "services.previewError";
}

function ServicePreviewPanel() {
  const { t } = useTranslation();
  const { coordinator, state } = useServicePreview();
  const opening = state.status === "preparing" || state.status === "loading";
  const busy = opening || state.status === "cancelling";
  useEffect(() => {
    if (coordinator && state.status === "idle") void coordinator.open();
  }, [coordinator, state.status]);
  const recover = useCallback(() => {
    void coordinator?.open({ recover: true });
  }, [coordinator]);
  return (
    <View style={styles.panel}>
      {coordinator ? (
        <View style={styles.toolbar}>
          {state.status === "error" && state.recovery ? (
            <Button size="sm" variant="ghost" onPress={recover}>
              {t("services.recoverPreview")}
            </Button>
          ) : null}
          {busy ? <Text style={styles.message}>{t("common.loading")}</Text> : null}
        </View>
      ) : null}
      {state.status === "error" ? (
        <Alert
          variant="warning"
          description={t(previewErrorKey(state))}
          testID="service-preview-error"
        />
      ) : null}
      <ServicePreviewAnchor>
        <View style={styles.container} testID="service-preview-unavailable">
          <Text style={styles.message}>
            {t(coordinator ? "services.previewReady" : "services.previewUnavailable")}
          </Text>
        </View>
      </ServicePreviewAnchor>
    </View>
  );
}

export const servicePreviewPanelRegistration = definePanel("service_preview", {
  component: ServicePreviewPanel,
  useDescriptor(target, context) {
    const { t } = useTranslation();
    const label = useSessionStore(
      (state) =>
        state.sessions[context.serverId]?.serverInfo?.servicePreviews?.services.find(
          (service) => service.serviceId === target.serviceId,
        )?.name ?? t("services.previewUnavailable"),
    );
    return {
      label,
      subtitle: t("services.title"),
      tooltip: label,
      titleState: "ready",
      icon: PreviewIcon,
      statusBucket: null,
    };
  },
});

const styles = StyleSheet.create((theme) => ({
  panel: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
