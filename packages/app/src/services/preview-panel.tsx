import { Globe } from "lucide-react-native";
import { useCallback } from "react";
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
  const { coordinator: browserTab, state: browserTabState } = useServicePreview("tab");
  const browserTabBusy =
    browserTabState.status === "preparing" || browserTabState.status === "cancelling";
  const opening = state.status === "preparing" || state.status === "loading";
  const busy = opening || state.status === "cancelling";
  const open = useCallback(() => {
    if (coordinator) void coordinator.open({ reload: coordinator.getSnapshot().status === "open" });
  }, [coordinator]);
  const recover = useCallback(() => {
    void coordinator?.open({ recover: true });
  }, [coordinator]);
  const cancel = useCallback(() => coordinator?.cancel(), [coordinator]);
  const openBrowserTab = useCallback(() => {
    if (browserTab?.getSnapshot().status === "ready") browserTab.launch();
    else void browserTab?.open();
  }, [browserTab]);
  const cancelBrowserTab = useCallback(() => browserTab?.cancel(), [browserTab]);
  const recoverBrowserTab = useCallback(() => {
    void browserTab?.open({ recover: true });
  }, [browserTab]);
  return (
    <View style={styles.panel}>
      {coordinator ? (
        <View style={styles.toolbar}>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            loading={busy}
            onPress={open}
            testID="service-preview-open"
          >
            {t(state.status === "open" ? "services.reloadPreview" : "services.openPreview")}
          </Button>
          {opening ? (
            <Button size="sm" variant="ghost" onPress={cancel}>
              {t("common.actions.cancel")}
            </Button>
          ) : null}
          {state.status === "error" && state.recovery ? (
            <Button size="sm" variant="ghost" onPress={recover}>
              {t("services.recoverPreview")}
            </Button>
          ) : null}
          {busy ? <Text style={styles.message}>{t("common.loading")}</Text> : null}
          {browserTab ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={browserTabBusy}
              loading={browserTabBusy}
              onPress={openBrowserTab}
              testID="service-preview-browser-tab"
            >
              {t(
                browserTabState.status === "ready"
                  ? "services.openBrowserTabReady"
                  : "services.openBrowserTab",
              )}
            </Button>
          ) : null}
          {["ready", "preparing", "open"].includes(browserTabState.status) ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={cancelBrowserTab}
              testID="service-preview-browser-tab-cancel"
            >
              {t(
                browserTabState.status === "open"
                  ? "services.closeBrowserPreview"
                  : "common.actions.cancel",
              )}
            </Button>
          ) : null}
          {browserTabState.status === "error" && browserTabState.recovery ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={recoverBrowserTab}
              testID="service-preview-browser-tab-recover"
            >
              {t("services.recoverPreview")}
            </Button>
          ) : null}
        </View>
      ) : null}
      {state.status === "error" ? (
        <Alert
          variant="warning"
          description={t(previewErrorKey(state))}
          testID="service-preview-error"
        />
      ) : null}
      {browserTabState.status === "error" ? (
        <Alert
          variant="warning"
          description={t(previewErrorKey(browserTabState))}
          testID="service-preview-browser-tab-error"
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
