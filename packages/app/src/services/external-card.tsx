import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/status-badge";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { useReplicaQuery } from "@/data/query";
import { externalActionKey, runExternalAction, type ExternalActionState } from "./external-actions";
import { createExternalCatalogOperations, type ExternalCatalogEntry } from "./external-catalog";
import { BrowserPreviewActions } from "./browser-preview-actions";
import { registrationErrorKey } from "./registration-errors";
import { serviceGalleryStyles as styles } from "./gallery-styles";

const ThemedGlobe = withUnistyles(Globe);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ExternalServiceCard({
  entry,
  compact,
  busy,
  onOpen,
}: {
  entry: ExternalCatalogEntry;
  compact: boolean;
  busy: boolean;
  onOpen?: (entry: ExternalCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const runtime = useHostRuntimeSnapshot(entry.serverId);
  const operations = useMemo(
    () => createExternalCatalogOperations(() => getHostRuntimeStore().getSnapshot(entry.serverId)),
    [entry.serverId],
  );
  const queryClient = useQueryClient();
  const outcome = useReplicaQuery<ExternalActionState>({
    queryKey: externalActionKey(entry),
    pushEvent: "services.external.action",
  });
  const action = useCallback(
    (operation: "connect" | "disconnect") => {
      if (busy) return;
      void runExternalAction({
        client: queryClient,
        operations,
        rendered: runtime,
        entry,
        action: operation,
      });
    },
    [busy, queryClient, operations, runtime, entry],
  );
  const connect = useCallback(() => action("connect"), [action]);
  const disconnect = useCallback(() => action("disconnect"), [action]);
  const openWorkspace = useCallback(() => onOpen?.(entry), [onOpen, entry]);
  const errorKey =
    outcome.data?.status === "error" ? registrationErrorKey(outcome.data.code) : null;
  const pending = outcome.data?.status === "pending";
  const disabled = busy || pending;
  let workspaceLabel = t("services.registration.hostOnly");
  if (entry.workspaceId)
    workspaceLabel = entry.workspaceName ?? t("services.registration.unknownWorkspace");
  return (
    <View style={styles.card} testID={`external-service-${entry.serviceId}`}>
      {!compact ? (
        <Pressable
          style={styles.preview}
          disabled={!entry.available || !entry.workspaceId || !onOpen || disabled}
          onPress={openWorkspace}
          accessibilityRole="button"
          accessibilityLabel={`${t("services.openPreview")}: ${entry.name}`}
        >
          <ThemedGlobe size={32} uniProps={muted} />
          <Text style={styles.caption}>{t("services.registration.external")}</Text>
        </Pressable>
      ) : null}
      <View style={styles.cardBody}>
        <View style={styles.cardHeading}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.name}
          </Text>
          <StatusBadge
            label={t(
              entry.available ? "services.registration.enabled" : "services.registration.disabled",
            )}
          />
        </View>
        <Text style={styles.caption}>{workspaceLabel}</Text>
        <Text style={styles.caption}>{t("services.port", { port: entry.port })}</Text>
        <Text style={styles.caption} selectable>
          {t("services.registration.basePath")}: /__paseo_services/apps/{entry.serviceId}/
        </Text>
        <View style={styles.actions}>
          {compact && entry.available && entry.workspaceId && entry.workspaceName && onOpen ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onPress={openWorkspace}
              accessibilityLabel={`${t("services.openPreview")}: ${entry.name}`}
            >
              {t("services.openPreview")}
            </Button>
          ) : null}
          {!entry.available ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              loading={pending}
              onPress={connect}
              accessibilityLabel={`${t("services.registration.connect")}: ${entry.name}`}
            >
              {t("services.registration.connect")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onPress={disconnect}
            accessibilityLabel={`${t("services.registration.remove")}: ${entry.name}`}
          >
            {t("services.registration.remove")}
          </Button>
          <BrowserPreviewActions
            serverId={entry.serverId}
            serviceId={entry.serviceId}
            name={entry.name}
            available={entry.available}
            disabled={disabled}
          />
        </View>
        {errorKey ? <Alert variant="error" description={t(errorKey)} /> : null}
      </View>
    </View>
  );
}
