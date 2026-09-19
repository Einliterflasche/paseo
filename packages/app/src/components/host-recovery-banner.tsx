import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import { Alert } from "@/components/ui/alert";
import { selectRecoveryFailedHostIds, useSessionStore } from "@/stores/session-store";
import { WindowChromeSafeArea } from "@/utils/desktop-window";

const safeAreaEdges = ["top", "left", "right"] as const;
const recoveryPresentation = {
  blocked: {
    description: "common.hostRecovery.blockedDescription",
    title: "common.hostRecovery.blockedTitle",
    testID: "host-recovery-blocked",
  },
  stopping: {
    description: "common.hostRecovery.stoppingDescription",
    title: "common.hostRecovery.stoppingTitle",
    testID: "host-recovery-stopping",
  },
  paused: {
    description: "common.hostRecovery.description",
    title: "common.hostRecovery.title",
    testID: "host-recovery-paused",
  },
} as const;

export function HostRecoveryBanners() {
  const serverIds = useSessionStore(useShallow(selectRecoveryFailedHostIds));
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
  const stage = serverInfo?.restartRecoveryStage;
  const stopping = stage === "stopping";
  const blocked = stage === "blocked";
  const presentation = recoveryPresentation[stopping || blocked ? stage : "paused"];
  const affectedAgents = serverInfo?.restartRecoveryAffectedAgents;
  const description = useMemo(
    () => (
      <View style={styles.description}>
        <Text style={styles.text}>{t(presentation.description)}</Text>
        <Text selectable style={styles.text} testID="host-recovery-error">
          {error}
        </Text>
        {affectedAgents?.length ? (
          <Text selectable style={styles.text}>
            {t("common.hostRecovery.affectedAgents", { agents: affectedAgents.join(", ") })}
          </Text>
        ) : null}
        {generation ? (
          <Text selectable style={styles.text} testID="host-recovery-generation">
            {t("common.hostRecovery.generation", { generation })}
          </Text>
        ) : null}
      </View>
    ),
    [t, error, generation, presentation, affectedAgents],
  );
  if (
    !serverInfo ||
    !error?.trim() ||
    (serverInfo.restartRecoveryState !== "paused" &&
      !(serverInfo.restartRecoveryState === "restoring" && (stopping || blocked)))
  )
    return null;

  return (
    <View style={styles.container}>
      <Alert
        variant="error"
        testID={presentation.testID}
        title={t(presentation.title, { hostName: serverInfo.hostname ?? serverId })}
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
