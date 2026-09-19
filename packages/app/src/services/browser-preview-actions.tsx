import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBrowserServicePreview } from "./preview-host";
import type { PreviewOpenState } from "./preview-coordinator";
import { serviceGalleryStyles as styles } from "./gallery-styles";
import type { Theme } from "@/styles/theme";

const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ServiceLifecycleActions({
  name,
  onToggle,
  toggleLabel,
  toggleDisabled,
  togglePending,
  toggleTestID,
  onLogs,
  logsDisabled,
}: {
  name: string;
  onToggle(): void;
  toggleLabel: string;
  toggleDisabled: boolean;
  togglePending: boolean;
  toggleTestID: string;
  onLogs(): void;
  logsDisabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={`${t("workspace.git.actions.moreActions")}: ${name}`}
        style={styles.menuTrigger}
      >
        <ThemedMoreHorizontal size={18} uniProps={iconColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          onSelect={onToggle}
          disabled={toggleDisabled}
          status={togglePending ? "pending" : "idle"}
          testID={toggleTestID}
        >
          {toggleLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogs} disabled={logsDisabled}>
          {t("services.logs")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface BrowserActionsMenuViewProps {
  serviceId: string;
  name: string;
  available: boolean;
  disabled: boolean;
  waiting: boolean;
  ready: boolean;
  state: PreviewOpenState;
  launch(): void;
  cancel(): void;
  recover(): void;
  onToggle?: () => void;
  toggleLabel?: string;
  toggleDisabled: boolean;
  togglePending: boolean;
  toggleTestID?: string;
  onLogs?: () => void;
  logsDisabled: boolean;
}

function BrowserActionsMenuView(props: BrowserActionsMenuViewProps) {
  const { t } = useTranslation();
  const {
    serviceId,
    name,
    available,
    disabled,
    waiting,
    ready,
    state,
    launch,
    cancel,
    recover,
    onToggle,
    toggleLabel,
    toggleDisabled,
    togglePending,
    toggleTestID,
    onLogs,
    logsDisabled,
  } = props;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled || waiting}
          accessibilityRole="button"
          accessibilityLabel={`${t("workspace.git.actions.moreActions")}: ${name}`}
          style={styles.menuTrigger}
          testID={`service-more-${serviceId}`}
        >
          <ThemedMoreHorizontal size={18} uniProps={iconColor} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={220}>
          {available ? (
            <DropdownMenuItem
              onSelect={launch}
              disabled={disabled || waiting}
              status={waiting ? "pending" : "idle"}
            >
              {t(ready ? "services.openBrowserTabReady" : "services.openBrowserTab")}
            </DropdownMenuItem>
          ) : null}
          {state.status === "open" ? (
            <DropdownMenuItem onSelect={cancel}>
              {t("services.closeBrowserPreview")}
            </DropdownMenuItem>
          ) : null}
          {state.status === "error" && state.recovery ? (
            <DropdownMenuItem onSelect={recover} disabled={disabled}>
              {t("services.recoverPreview")}
            </DropdownMenuItem>
          ) : null}
          {onToggle && toggleLabel ? (
            <DropdownMenuItem
              onSelect={onToggle}
              disabled={toggleDisabled}
              status={togglePending ? "pending" : "idle"}
              testID={toggleTestID}
            >
              {toggleLabel}
            </DropdownMenuItem>
          ) : null}
          {onLogs ? (
            <DropdownMenuItem onSelect={onLogs} disabled={logsDisabled}>
              {t("services.logs")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
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

/** The root owner keeps browser authority alive when catalog cards remount. */
export function BrowserPreviewActions({
  serverId,
  serviceId,
  name,
  available,
  disabled,
  onToggle,
  toggleLabel,
  toggleDisabled = false,
  togglePending = false,
  toggleTestID,
  onLogs,
  logsDisabled = false,
}: {
  serverId: string;
  serviceId: string;
  name: string;
  available: boolean;
  disabled: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  toggleDisabled?: boolean;
  togglePending?: boolean;
  toggleTestID?: string;
  onLogs?: () => void;
  logsDisabled?: boolean;
}) {
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
  if (!coordinator && !onToggle && !onLogs) return null;
  return (
    <BrowserActionsMenuView
      serviceId={serviceId}
      name={name}
      available={available && Boolean(coordinator)}
      disabled={disabled}
      waiting={waiting}
      ready={ready}
      state={state}
      launch={launch}
      cancel={cancel}
      recover={recover}
      onToggle={onToggle}
      toggleLabel={toggleLabel}
      toggleDisabled={toggleDisabled}
      togglePending={togglePending}
      toggleTestID={toggleTestID}
      onLogs={onLogs}
      logsDisabled={logsDisabled}
    />
  );
}
