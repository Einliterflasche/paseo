import { serviceGalleryStyles as styles } from "./gallery-styles";
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Text, View, type ViewStyle, type LayoutChangeEvent } from "react-native";
import { Globe, LayoutGrid, List } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ServiceCatalogEntry } from "./catalog";
import type { ExternalCatalogEntry } from "./external-catalog";
import { ExternalServiceCard } from "./external-card";
import { ManagedPreviewControls } from "./managed-controls";
import type { ServicesViewMode } from "./preferences";

import type { Theme } from "@/styles/theme";
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedGlobe = withUnistyles(Globe);
function renderGridIcon(props: { color: string; size: number }) {
  return <LayoutGrid {...props} />;
}
function renderListIcon(props: { color: string; size: number }) {
  return <List {...props} />;
}
export type ServiceAction = "start" | "stop";
type GalleryEntry = ServiceCatalogEntry | ExternalCatalogEntry;

function isExternal(entry: GalleryEntry): entry is ExternalCatalogEntry {
  return "kind" in entry && entry.kind === "external";
}

interface ServiceGalleryProps {
  serverId: string;
  services: GalleryEntry[];
  mode: ServicesViewMode;
  onModeChange: (mode: ServicesViewMode) => void;
  modePending: boolean;
  preferenceError: "load" | "save" | null;
  onPreferenceReload: () => void;
  loading: boolean;
  online: boolean;
  stale: boolean;
  canManage: boolean;
  actionsBlocked: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  error?: string;
  pendingId?: string;
  onAction: (entry: ServiceCatalogEntry, action: ServiceAction) => void;
  onLogs: (entry: ServiceCatalogEntry) => void;
  onOpen?: (entry: GalleryEntry) => void;
  onRegister?: () => void;
  onManagePreview?: (entry: ServiceCatalogEntry) => void;
}

export function ServiceGallery(props: ServiceGalleryProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { mode, modePending } = props;
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    // Hidden retained panels report zero; keep their last usable geometry.
    if (next > 0) setWidth(next);
  }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return props.services.filter((entry) =>
      (isExternal(entry)
        ? [entry.name, entry.workspaceName, entry.port]
        : [entry.scriptName, entry.workspaceName, entry.projectName, entry.port ?? ""]
      )
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [props.services, query]);
  const columns = mode === "list" ? 1 : Math.max(1, Math.floor(width / 320));
  const options = useMemo(
    () => [
      {
        value: "grid" as const,
        label: t("services.grid"),
        icon: renderGridIcon,
        testID: "services-grid",
        disabled: modePending,
      },
      {
        value: "list" as const,
        label: t("services.list"),
        icon: renderListIcon,
        testID: "services-list",
        disabled: modePending,
      },
    ],
    [t, modePending],
  );
  const {
    serverId,
    online,
    stale,
    canManage,
    actionsBlocked,
    pendingId,
    onAction,
    onLogs,
    onOpen,
    onManagePreview,
  } = props;
  const cellStyle = useMemo<ViewStyle>(() => ({ width: `${100 / columns}%` }), [columns]);
  const empty = useMemo(() => {
    // A missing or cached snapshot cannot establish that the host has no services.
    // The existing offline/stale/error message describes that unavailable state.
    if (props.error || props.stale) return null;
    let key = "services.empty";
    if (props.loading) key = "common.loading";
    else if (query.trim()) key = "services.noMatches";
    return <Text style={styles.empty}>{t(key)}</Text>;
  }, [props.loading, props.error, props.stale, query, t]);
  const renderItem = useCallback(
    ({ item }: { item: GalleryEntry }) => (
      <View style={cellStyle}>
        {isExternal(item) ? (
          <ExternalServiceCard
            entry={item}
            compact={mode === "list"}
            busy={!online || actionsBlocked}
            onOpen={onOpen}
          />
        ) : (
          <ServiceCard
            serverId={serverId}
            entry={item}
            compact={mode === "list"}
            online={online}
            stale={stale}
            canManage={canManage}
            busy={actionsBlocked || pendingId !== undefined}
            pending={pendingId === item.id}
            onAction={onAction}
            onLogs={onLogs}
            onOpen={onOpen}
            onManagePreview={onManagePreview}
          />
        )}
      </View>
    ),
    [
      cellStyle,
      mode,
      online,
      stale,
      canManage,
      actionsBlocked,
      pendingId,
      onAction,
      onLogs,
      onOpen,
      onManagePreview,
      serverId,
    ],
  );

  return (
    <View style={styles.container} onLayout={onLayout} testID="services-gallery">
      <View style={styles.heading}>
        <Text style={styles.title}>{t("services.title")}</Text>
        <Text style={styles.description}>{t("services.description")}</Text>
      </View>
      <View style={styles.toolbar}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t("services.search")}
          clearAccessibilityLabel={t("services.clearSearch")}
          testID="services-search"
        />
        {props.onRegister ? (
          <Button
            size="sm"
            variant="outline"
            onPress={props.onRegister}
            disabled={!props.online || props.actionsBlocked}
            testID="service-register-open"
          >
            {t("services.registration.title")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onPress={props.onRefresh}
          disabled={!props.online || props.refreshing || props.pendingId !== undefined}
          loading={props.refreshing}
        >
          {t("services.refresh")}
        </Button>
        <SegmentedControl
          options={options}
          value={mode}
          onValueChange={props.onModeChange}
          size="sm"
        />
      </View>
      {props.preferenceError ? (
        <Alert
          variant="warning"
          description={t(
            props.preferenceError === "load"
              ? "services.preferenceLoadError"
              : "services.preferenceSaveError",
          )}
          testID="services-preference-error"
        >
          {props.preferenceError === "load" ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={props.onPreferenceReload}
              disabled={modePending}
              loading={modePending}
            >
              {t("common.actions.retry")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {!online ? <Alert variant="warning" description={t("services.offline")} /> : null}
      {online && stale && !props.error ? (
        <Alert variant="warning" description={t("services.stale")} />
      ) : null}
      {props.loading && props.online ? (
        <Text style={styles.caption}>{t("common.loading")}</Text>
      ) : null}
      {props.error ? (
        <Alert variant="error" description={props.error} testID="services-error" />
      ) : null}
      <FlatList
        key={columns}
        style={styles.list}
        data={filtered}
        numColumns={columns}
        keyExtractor={serviceKey}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        ListEmptyComponent={empty}
      />
    </View>
  );
}

function healthLabel(entry: ServiceCatalogEntry, stale: boolean) {
  if (stale) return "services.cached";
  if (entry.health === "healthy") return "services.reachable";
  if (entry.health === "unhealthy") return "services.unreachable";
  return "services.unknown";
}

function serviceKey(entry: GalleryEntry) {
  return entry.id;
}

function ServicePreviewPlaceholder({
  entry,
  canOpen,
}: {
  entry: ServiceCatalogEntry;
  canOpen: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.preview}>
      <ThemedGlobe size={32} uniProps={mutedColorMapping} />
      <Text style={styles.caption}>
        {t(
          entry.previewServiceId && canOpen
            ? "services.previewReady"
            : "services.previewUnavailable",
        )}
      </Text>
    </View>
  );
}

const ServiceCard = memo(function ServiceCard({
  serverId,
  entry,
  compact,
  online,
  stale,
  canManage,
  busy,
  pending,
  onAction,
  onLogs,
  onOpen,
  onManagePreview,
}: {
  serverId: string;
  entry: ServiceCatalogEntry;
  compact: boolean;
  online: boolean;
  stale: boolean;
  canManage: boolean;
  busy: boolean;
  pending: boolean;
  onAction: ServiceGalleryProps["onAction"];
  onLogs: ServiceGalleryProps["onLogs"];
  onOpen: ServiceGalleryProps["onOpen"];
  onManagePreview: ServiceGalleryProps["onManagePreview"];
}) {
  const { t } = useTranslation();
  const running = entry.lifecycle === "running";
  const toggle = useCallback(
    () => onAction(entry, running ? "stop" : "start"),
    [entry, running, onAction],
  );
  const logs = useCallback(() => onLogs(entry), [entry, onLogs]);
  const open = useCallback(() => onOpen?.(entry), [entry, onOpen]);
  const serviceDescription = `${entry.scriptName} · ${entry.projectName} · ${entry.workspaceName}`;
  const actionLabel = t(running ? "services.stop" : "services.start");
  return (
    <View style={styles.card} testID={`service-card-${entry.workspaceId}-${entry.scriptName}`}>
      {!compact ? <ServicePreviewPlaceholder entry={entry} canOpen={Boolean(onOpen)} /> : null}
      <View style={styles.cardBody}>
        <View style={styles.cardHeading}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.scriptName}
          </Text>
          <StatusBadge label={t(running ? "services.started" : "services.stopped")} />
        </View>
        <Text style={styles.caption} numberOfLines={2}>
          {entry.projectName} · {entry.workspaceName}
        </Text>
        <View style={styles.metadata}>
          <Text style={styles.caption}>
            {entry.port === null ? t("services.noPort") : t("services.port", { port: entry.port })}
          </Text>
          {running ? (
            <StatusBadge
              variant={!stale && entry.health === "healthy" ? "success" : "muted"}
              label={t(healthLabel(entry, stale))}
            />
          ) : null}
        </View>
        <View style={styles.actions}>
          {entry.previewServiceId && onOpen ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!online || stale || busy}
              onPress={open}
              accessibilityLabel={`${t("services.openPreview")}: ${serviceDescription}`}
              testID={`service-open-${entry.scriptName}`}
            >
              {t("services.openPreview")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!online || !canManage || busy}
            loading={pending}
            onPress={toggle}
            accessibilityLabel={`${actionLabel}: ${serviceDescription}`}
            testID={`service-${running ? "stop" : "start"}-${entry.scriptName}`}
          >
            {actionLabel}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!online || !entry.terminalId}
            onPress={logs}
            accessibilityLabel={`${t("services.logs")}: ${serviceDescription}`}
          >
            {t("services.logs")}
          </Button>
        </View>
        {!canManage ? <Text style={styles.caption}>{t("services.readOnly")}</Text> : null}
        {onManagePreview ? (
          <ManagedPreviewControls
            serverId={serverId}
            entry={entry}
            disabled={!online || stale || busy}
            onConfigure={onManagePreview}
          />
        ) : null}
      </View>
    </View>
  );
});
