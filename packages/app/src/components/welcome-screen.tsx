import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import {
  QrCode,
  Link2,
  ClipboardPaste,
  ExternalLink,
  Settings,
  Terminal,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostProfile } from "@/types/host-connection";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHosts,
  useInitialDaemonConnection,
} from "@/runtime/host-runtime";
import { SameOriginLogin } from "./same-origin-login";
import { AddHostModal } from "./add-host-modal";
import { AddRemoteSshHostModal } from "./add-remote-ssh-host-modal";
import { PairLinkModal } from "./pair-link-modal";
import { Button } from "@/components/ui/button";
import { resolveAppVersion } from "@/utils/app-version";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { openExternalUrl } from "@/utils/open-external-url";
import { isFdroidBuild } from "@/constants/build-profile";
import { isWeb, isNative } from "@/constants/platform";
import { isElectronRuntime } from "@/desktop/host";

interface WelcomeAction {
  key: "scan-qr" | "direct-connection" | "remote-ssh" | "paste-pairing-link";
  label: string;
  testID: string;
  primary: boolean;
  icon: typeof QrCode;
  onPress: () => void;
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  container: (bottomInset: number) => ({
    flexGrow: 1,
    padding: theme.spacing[6],
    paddingBottom: theme.spacing[6] + bottomInset,
    alignItems: "center",
  }),
  content: {
    width: "100%",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  copyBlock: {
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[12],
  },
  actions: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[3],
  },
  versionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[6],
  },
  settingsButton: {
    alignSelf: "center",
    marginTop: theme.spacing[6],
  },
}));

function useAnyHostOnline(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
  );
}

export interface WelcomeScreenProps {
  onHostAdded?: (profile: HostProfile) => void;
}

export function WelcomeScreen({ onHostAdded }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const [isDirectOpen, setIsDirectOpen] = useState(false);
  const [isRemoteSshOpen, setIsRemoteSshOpen] = useState(false);
  const [isPasteLinkOpen, setIsPasteLinkOpen] = useState(false);
  const hosts = useHosts();
  const initialConnection = useInitialDaemonConnection();
  const [showOtherHosts, setShowOtherHosts] = useState(false);
  const showThisServer = initialConnection !== null && !showOtherHosts;
  const handleOtherHost = useCallback(() => setShowOtherHosts(true), []);
  const handleThisServer = useCallback(() => setShowOtherHosts(false), []);
  const anyOnlineServerId = useAnyHostOnline(hosts.map((h) => h.serverId));

  useEffect(() => {
    if (!anyOnlineServerId) return;
    router.replace(buildOpenProjectRoute());
  }, [anyOnlineServerId, router]);

  const finishOnboarding = useCallback(() => {
    router.replace(buildOpenProjectRoute());
  }, [router]);

  const handleOpenPaseoSite = useCallback(() => {
    void openExternalUrl("https://paseo.sh");
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);

  const handleOpenDirect = useCallback(() => setIsDirectOpen(true), []);
  const handleCloseDirect = useCallback(() => setIsDirectOpen(false), []);
  const handleOpenRemoteSsh = useCallback(() => setIsRemoteSshOpen(true), []);
  const handleCloseRemoteSsh = useCallback(() => setIsRemoteSshOpen(false), []);
  const handleOpenPasteLink = useCallback(() => setIsPasteLinkOpen(true), []);
  const handleClosePasteLink = useCallback(() => setIsPasteLinkOpen(false), []);
  const handleScanQr = useCallback(() => {
    router.push("/pair-scan?source=onboarding");
  }, [router]);

  const handleHostSaved = useCallback(
    ({ profile }: { profile: HostProfile; serverId: string }) => {
      onHostAdded?.(profile);
      finishOnboarding();
    },
    [onHostAdded, finishOnboarding],
  );

  const actions: WelcomeAction[] =
    isWeb || isFdroidBuild
      ? [
          {
            key: "direct-connection",
            label: t("pairing.connectionMethods.direct.title"),
            testID: "welcome-direct-connection",
            primary: true,
            icon: Link2,
            onPress: handleOpenDirect,
          },
          {
            key: "paste-pairing-link",
            label: t("pairing.connectionMethods.pasteLink.title"),
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: handleOpenPasteLink,
          },
        ]
      : [
          {
            key: "scan-qr",
            label: t("pairing.connectionMethods.scanQr.title"),
            testID: "welcome-scan-qr",
            primary: true,
            icon: QrCode,
            onPress: handleScanQr,
          },
          {
            key: "direct-connection",
            label: t("pairing.connectionMethods.direct.title"),
            testID: "welcome-direct-connection",
            primary: false,
            icon: Link2,
            onPress: handleOpenDirect,
          },
          {
            key: "paste-pairing-link",
            label: t("pairing.connectionMethods.pasteLink.title"),
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: handleOpenPasteLink,
          },
        ];

  if (isElectronRuntime()) {
    actions.splice(1, 0, {
      key: "remote-ssh",
      label: t("pairing.connectionMethods.remoteSsh.title"),
      testID: "welcome-remote-ssh",
      primary: false,
      icon: Terminal,
      onPress: handleOpenRemoteSsh,
    });
  }

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.container(insets.bottom)}
        showsVerticalScrollIndicator={false}
        testID="welcome-screen"
      >
        <View style={styles.content}>
          <PaseoLogo size={96} />
          <View style={styles.copyBlock}>
            <Text style={styles.title}>{t("onboarding.title")}</Text>
            {!showThisServer ? (
              <Text style={styles.subtitle}>{t("onboarding.subtitle")}</Text>
            ) : null}
            {isNative ? (
              <Button
                variant="ghost"
                size="sm"
                leftIcon={ExternalLink}
                onPress={handleOpenPaseoSite}
              >
                paseo.sh
              </Button>
            ) : null}
          </View>

          <View style={styles.actions}>
            {showThisServer ? (
              <SameOriginLogin connection={initialConnection} onOtherHost={handleOtherHost} />
            ) : (
              <>
                {initialConnection ? (
                  <Button variant="default" onPress={handleThisServer} testID="welcome-this-server">
                    {t("onboarding.thisServer.title")}
                  </Button>
                ) : null}
                {actions.map((action) => (
                  <Button
                    key={action.key}
                    variant={action.primary && !initialConnection ? "default" : "secondary"}
                    leftIcon={action.icon}
                    onPress={action.onPress}
                    testID={action.testID}
                  >
                    {action.label}
                  </Button>
                ))}
              </>
            )}
          </View>

          <Button
            variant="ghost"
            size="sm"
            leftIcon={Settings}
            onPress={handleOpenSettings}
            style={styles.settingsButton}
            testID="welcome-open-settings"
          >
            {t("onboarding.actions.settings")}
          </Button>
        </View>
        <Text style={styles.versionLabel}>{appVersionText}</Text>

        <AddHostModal
          visible={isDirectOpen}
          onClose={handleCloseDirect}
          onSaved={handleHostSaved}
        />

        <AddRemoteSshHostModal
          visible={isRemoteSshOpen}
          onClose={handleCloseRemoteSsh}
          onSaved={handleHostSaved}
        />

        <PairLinkModal
          visible={isPasteLinkOpen}
          onClose={handleClosePasteLink}
          onSaved={handleHostSaved}
        />
      </ScrollView>
    </View>
  );
}
