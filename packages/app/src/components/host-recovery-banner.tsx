import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
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
      >
        <RestartAnywayAction serverId={serverId} />
      </Alert>
    </View>
  );
}

function RestartAnywayAction({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = useRef(false);
  const error = serverInfo?.restartRecoveryError;
  useEffect(() => {
    busy.current = false;
    setPending(false);
    setActionError(null);
  }, [serverInfo?.restartAnywayId, error]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      busy.current = false;
      setPending(false);
      setActionError(t("common.hostRecovery.restartUnconfirmed"));
    }, 45_000);
    return () => clearTimeout(timer);
  }, [pending, t]);
  const restartAnyway = useCallback(async () => {
    if (busy.current || !client || !serverInfo || !error) return;
    busy.current = true;
    setActionError(null);
    try {
      const accepted = await confirmDialog({
        title: t("common.hostRecovery.restartAnyway"),
        message: t("common.hostRecovery.restartWarning", {
          hostName: serverInfo.hostname ?? serverId,
        }),
        confirmLabel: t("common.hostRecovery.restartAnyway"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!accepted) {
        busy.current = false;
        return;
      }
      setPending(true);
      await client.restartAnyway(error, serverInfo.restartRecoveryGeneration ?? null);
    } catch (cause) {
      busy.current = false;
      setPending(false);
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, error, serverInfo, serverId, t]);
  if (
    !serverInfo?.features?.restartAnyway ||
    !client?.getLastServerInfoMessage()?.permissions?.includes("daemon.manage")
  )
    return null;
  return (
    <View style={styles.description}>
      <Button
        variant="destructive"
        size="sm"
        testID="host-restart-anyway"
        disabled={pending}
        loading={pending}
        onPress={restartAnyway}
      >
        {t(pending ? "common.hostRecovery.restarting" : "common.hostRecovery.restartAnyway")}
      </Button>
      {actionError ? (
        <Text selectable style={styles.text} testID="host-restart-anyway-error">
          {actionError}
        </Text>
      ) : null}
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
