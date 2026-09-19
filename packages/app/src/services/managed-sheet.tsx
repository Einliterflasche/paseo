import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useReplicaQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { ServiceCatalogEntry } from "./catalog";
import {
  managedActionKey,
  managedErrorKey,
  runManagedAction,
  type ManagedActionState,
} from "./managed-actions";

interface OpenManagedPreviewProps {
  serverId: string;
  entry: ServiceCatalogEntry;
  eligible: boolean;
  onClose(): void;
}

export function ManagedPreviewSheet({
  entry,
  currentEntry,
  eligible,
  ...props
}: {
  serverId: string;
  entry: ServiceCatalogEntry | null;
  currentEntry: ServiceCatalogEntry | undefined;
  eligible: boolean;
  onClose(): void;
}) {
  if (!entry) return null;
  return (
    <OpenManagedPreviewSheet
      {...props}
      key={entry.id}
      entry={currentEntry ?? entry}
      eligible={eligible && currentEntry !== undefined}
    />
  );
}

function OpenManagedPreviewSheet({ serverId, entry, eligible, onClose }: OpenManagedPreviewProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const runtime = useHostRuntimeSnapshot(serverId);
  const outcome = useReplicaQuery<ManagedActionState>({
    queryKey: managedActionKey(serverId, entry),
    pushEvent: "services.managed.action",
  });
  const saving = outcome.data?.status === "pending";
  const enabled = entry.previewEnrollment?.enabled === true;
  const available =
    eligible &&
    runtime?.connectionStatus === "online" &&
    runtime.client?.getLastServerInfoMessage()?.servicePreviews?.managedRegistration === 1;
  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);
  const submit = useCallback(async () => {
    if (!available || saving) return;
    const saved = await runManagedAction({
      client,
      serverId,
      entry,
      action: enabled ? "disable" : "enable",
      getSnapshot: () => getHostRuntimeStore().getSnapshot(serverId),
    });
    if (saved) onClose();
  }, [available, saving, client, serverId, entry, enabled, onClose]);
  const header = useMemo(
    () => ({ title: `${t("services.managed.settings")}: ${entry.scriptName}` }),
    [t, entry.scriptName],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={close} disabled={saving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={submit}
          disabled={!available || saving}
          loading={saving}
          testID="service-managed-submit"
        >
          {t(enabled ? "services.managed.disable" : "services.registration.connect")}
        </Button>
      </View>
    ),
    [close, saving, t, submit, available, enabled],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      footer={footer}
      testID="service-managed-sheet"
    >
      <View style={styles.fields}>
        <Text style={styles.description}>
          {t(enabled ? "services.managed.disableHelp" : "services.managed.enableHelp")}
        </Text>
        {entry.previewEnrollment ? (
          <Text style={styles.description} selectable>
            {t("services.registration.basePath")}: /__paseo_services/apps/
            {entry.previewEnrollment.serviceId}/
          </Text>
        ) : null}
        {!available ? (
          <Alert variant="warning" description={t("services.managed.unavailable")} />
        ) : null}
        {outcome.data?.status === "error" ? (
          <Alert variant="error" description={t(managedErrorKey(outcome.data.code))} />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing[4] },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
