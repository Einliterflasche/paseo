import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getHostRuntimeStore, type InitialDaemonConnectionState } from "@/runtime/host-runtime";

interface SameOriginLoginProps {
  connection: NonNullable<InitialDaemonConnectionState>;
  onOtherHost: () => void;
}

export function SameOriginLogin({ connection, onOtherHost }: SameOriginLoginProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const isCompact = useIsCompactFormFactor();
  const size = isCompact ? "md" : "sm";
  const isConnecting = connection.status === "connecting";
  const error = "error" in connection ? connection.error : null;
  const origin = new URL(`${connection.hint.useTls ? "https" : "http"}://${connection.hint.listen}`)
    .origin;
  const handleConnect = useCallback(() => {
    void getHostRuntimeStore().connectInitialDaemon(password);
  }, [password]);

  return (
    <View style={styles.form} testID="same-origin-login">
      <Text style={styles.title}>{t("onboarding.thisServer.title")}</Text>
      <Text style={styles.origin} selectable testID="same-origin-address">
        {origin}
      </Text>
      <Field label={t("pairing.direct.fields.password")}>
        <FormTextInput
          size={size}
          testID="same-origin-password-input"
          accessibilityLabel={t("pairing.direct.fields.password")}
          initialValue=""
          onChangeText={setPassword}
          onSubmitEditing={handleConnect}
          editable={!isConnecting}
          autoComplete="current-password"
          textContentType="password"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="go"
        />
      </Field>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="same-origin-error">
          {error === "Incorrect password"
            ? t("onboarding.thisServer.incorrectPassword")
            : t("onboarding.thisServer.connectionError", { detail: error })}
        </Text>
      ) : null}
      <Button
        size={size}
        variant="default"
        loading={isConnecting}
        onPress={handleConnect}
        testID="same-origin-connect"
      >
        {t(isConnecting ? "pairing.direct.actions.connecting" : "pairing.direct.actions.connect")}
      </Button>
      <Button size={size} variant="ghost" onPress={onOtherHost} testID="same-origin-other-host">
        {t("onboarding.thisServer.otherHost")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  origin: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    marginBottom: theme.spacing[3],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
