import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useReplicaQuery } from "@/data/query";
import type { ServiceCatalogEntry } from "./catalog";
import { managedActionKey, managedErrorKey, type ManagedActionState } from "./managed-actions";
import { serviceGalleryStyles as styles } from "./gallery-styles";
import { BrowserPreviewActions } from "./browser-preview-actions";

export function ManagedPreviewControls({
  serverId,
  entry,
  disabled,
  onConfigure,
}: {
  serverId: string;
  entry: ServiceCatalogEntry;
  disabled: boolean;
  onConfigure(entry: ServiceCatalogEntry): void;
}) {
  const { t } = useTranslation();
  const outcome = useReplicaQuery<ManagedActionState>({
    queryKey: managedActionKey(serverId, entry),
    pushEvent: "services.managed.action",
  });
  const configure = useCallback(() => onConfigure(entry), [onConfigure, entry]);
  const enabled = entry.previewEnrollment?.enabled === true;
  const serviceId = entry.previewEnrollment?.serviceId ?? entry.previewServiceId;
  return (
    <>
      {enabled ? <Text style={styles.caption}>{t("services.registration.enabled")}</Text> : null}
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="ghost"
          onPress={configure}
          disabled={disabled || outcome.data?.status === "pending"}
          loading={outcome.data?.status === "pending"}
          accessibilityLabel={`${t(enabled ? "services.managed.settings" : "services.registration.connect")}: ${entry.scriptName}`}
          testID={`service-preview-configure-${entry.scriptName}`}
        >
          {t(enabled ? "services.managed.settings" : "services.registration.connect")}
        </Button>
      </View>
      {serviceId ? (
        <BrowserPreviewActions
          serverId={serverId}
          serviceId={serviceId}
          name={entry.scriptName}
          available={Boolean(entry.previewServiceId)}
          disabled={disabled}
        />
      ) : null}
      {outcome.data?.status === "error" ? (
        <Alert variant="error" description={t(managedErrorKey(outcome.data.code))} />
      ) : null}
    </>
  );
}
