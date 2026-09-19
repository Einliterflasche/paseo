import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import { Alert } from "@/components/ui/alert";
import { selectRecoveryPausedHostIds, useSessionStore } from "@/stores/session-store";
import { WindowChromeSafeArea } from "@/utils/desktop-window";

const safeAreaEdges = ["top", "left", "right"] as const;

export function HostRecoveryBanners() {
  const serverIds = useSessionStore(useShallow(selectRecoveryPausedHostIds));
  if (serverIds.length === 0) return null;
  return (
    <SafeAreaView edges={safeAreaEdges} style={styles.safeArea}>
      <WindowChromeSafeArea placement="below" />
      {serverIds.map((serverId) => (
        <HostRecoveryBanner key={serverId} serverId={serverId} />
      ))}
    </SafeAreaView>
  );
}

function HostRecoveryBanner({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const error = serverInfo?.restartRecoveryError;
  const generation = serverInfo?.restartRecoveryGeneration;
  const description = useMemo(
    () => (
      <View style={styles.description}>
        <Text style={styles.text}>{t("common.hostRecovery.description")}</Text>
        <Text selectable style={styles.text} testID="host-recovery-error">
          {error}
        </Text>
        {generation ? (
          <Text selectable style={styles.text} testID="host-recovery-generation">
            {t("common.hostRecovery.generation", { generation })}
          </Text>
        ) : null}
      </View>
    ),
    [t, error, generation],
  );
  if (serverInfo?.restartRecoveryState !== "paused" || !error?.trim()) return null;

  return (
    <View style={styles.container}>
      <Alert
        variant="error"
        testID="host-recovery-paused"
        title={t("common.hostRecovery.title", { hostName: serverInfo.hostname ?? serverId })}
        description={description}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    backgroundColor: theme.colors.surface0,
  },
  container: {
    padding: theme.spacing[3],
  },
  description: {
    gap: theme.spacing[2],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
