import { useCallback } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useBrowserServicePreview } from "./preview-host";
import { serviceGalleryStyles as styles } from "./gallery-styles";

/** The root owner keeps browser authority alive when catalog cards remount. */
export function BrowserPreviewActions({
  serverId,
  serviceId,
  name,
  available,
  disabled,
}: {
  serverId: string;
  serviceId: string;
  name: string;
  available: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { coordinator, state } = useBrowserServicePreview({
    serverId: serverId,
    serviceId: serviceId,
  });
  const waiting = state.status === "preparing" || state.status === "cancelling";
  const ready = state.status === "ready";
  const launch = useCallback(() => {
    if (disabled || !available) return;
    if (coordinator?.getSnapshot().status === "ready") coordinator.launch();
    else void coordinator?.open();
  }, [disabled, available, coordinator]);
  const cancel = useCallback(() => coordinator?.cancel(), [coordinator]);
  const recover = useCallback(() => {
    if (!disabled) void coordinator?.open({ recover: true });
  }, [disabled, coordinator]);
  return (
    <>
      <View style={styles.actions}>
        {available && coordinator ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || waiting}
            loading={waiting}
            onPress={launch}
            accessibilityLabel={`${t(ready ? "services.openBrowserTabReady" : "services.openBrowserTab")}: ${name}`}
          >
            {t(ready ? "services.openBrowserTabReady" : "services.openBrowserTab")}
          </Button>
        ) : null}
        {state.status === "preparing" || ready || state.status === "open" ? (
          <Button size="sm" variant="ghost" onPress={cancel}>
            {t(state.status === "open" ? "services.closeBrowserPreview" : "common.actions.cancel")}
          </Button>
        ) : null}
        {state.status === "error" && state.recovery ? (
          <Button size="sm" variant="ghost" onPress={recover} disabled={disabled}>
            {t("services.recoverPreview")}
          </Button>
        ) : null}
      </View>
      {state.status === "error" ? (
        <Alert
          variant="warning"
          description={t(
            state.code === "close" ? "services.previewCloseError" : "services.previewError",
          )}
        />
      ) : null}
    </>
  );
}
