import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { CatalogWorkspace } from "./catalog";
import { createExternalCatalogOperations } from "./external-catalog";
import { openServiceRegistration, type RegistrationFormSnapshot } from "./registration-form";
import { registrationErrorKey } from "./registration-errors";

interface RegistrationSheetProps {
  serverId: string;
  workspaceId?: string;
  workspaces: CatalogWorkspace[];
  visible: boolean;
  onClose(): void;
}

function useRegistrationModel(snapshot: RegistrationFormSnapshot) {
  const [model] = useState(() => openServiceRegistration(snapshot));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

export function ServiceRegistrationSheet(props: RegistrationSheetProps) {
  if (!props.visible) return null;
  return (
    <OpenRegistrationSheet key={`${props.serverId}:${props.workspaceId ?? "host"}`} {...props} />
  );
}

function OpenRegistrationSheet({
  serverId,
  workspaceId,
  workspaces,
  onClose,
}: RegistrationSheetProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const runtime = useHostRuntimeSnapshot(serverId);
  const initialWorkspace = workspaces.find((item) => item.id === workspaceId);
  const { model, state } = useRegistrationModel({
    workspaceId: workspaceId ?? null,
    workspaceLabel: initialWorkspace
      ? initialWorkspace.title || initialWorkspace.name
      : t("services.registration.hostOnly"),
  });
  const operations = useMemo(
    () => createExternalCatalogOperations(() => getHostRuntimeStore().getSnapshot(serverId)),
    [serverId],
  );
  const saving = state.operation.status === "saving";
  const available =
    runtime?.connectionStatus === "online" &&
    runtime.client?.getLastServerInfoMessage()?.servicePreviews?.externalRegistration === 1;
  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);
  const submit = useCallback(async () => {
    if (!available) return;
    // Each explicit attempt captures its own current source. The draft itself
    // survives reconnect; an uncertain earlier submission is never replayed.
    const source = getHostRuntimeStore().getSnapshot(serverId);
    const saved = await model.submit((input) => operations.register(source, input));
    if (saved) onClose();
  }, [available, model, operations, serverId, onClose]);
  const selectWorkspace = useCallback(
    (id: string, display: { label: string }) => {
      model.setWorkspace({ id: id || null, label: display.label });
    },
    [model],
  );
  const header = useMemo(() => ({ title: t("services.registration.title") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={close} disabled={saving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={submit}
          disabled={!available || !state.canSubmit}
          loading={saving}
          testID="service-register-submit"
        >
          {t("services.registration.register")}
        </Button>
      </View>
    ),
    [close, saving, t, submit, available, state.canSubmit],
  );
  const workspaceOptions = [
    { id: "host", value: "", label: t("services.registration.hostOnly") },
    ...workspaces
      .filter((item) => !item.archivingAt)
      .map((item) => ({ id: item.id, value: item.id, label: item.title || item.name })),
  ];
  const mountOptions = [
    { id: "preserve", value: "preserve" as const, label: t("services.registration.preservePath") },
    { id: "strip", value: "strip" as const, label: t("services.registration.stripPath") },
  ];
  const workspaceDisplay = useMemo(
    () => ({ label: state.values.workspaceLabel }),
    [state.values.workspaceLabel],
  );
  const mountDisplay = useMemo(
    () => ({
      label: t(
        state.values.mount === "preserve"
          ? "services.registration.preservePath"
          : "services.registration.stripPath",
      ),
    }),
    [t, state.values.mount],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      testID="service-registration-sheet"
      footer={footer}
    >
      <View style={styles.fields}>
        <Field label={t("services.registration.name")}>
          <FormTextInput
            size={size}
            initialValue={state.values.name}
            onChangeText={model.setName}
            editable={!saving}
            accessibilityLabel={t("services.registration.name")}
            testID="service-register-name"
          />
        </Field>
        <Field label={t("services.registration.localPort")}>
          <FormTextInput
            size={size}
            initialValue={state.values.port}
            onChangeText={model.setPort}
            inputMode="numeric"
            autoCorrect={false}
            editable={!saving}
            accessibilityLabel={t("services.registration.localPort")}
            testID="service-register-port"
          />
        </Field>
        <SelectField
          label={t("services.registration.workspace")}
          value={state.values.workspaceId ?? ""}
          selectedDisplay={workspaceDisplay}
          options={workspaceOptions}
          onChange={selectWorkspace}
          placeholder={t("services.registration.hostOnly")}
          emptyText={t("common.empty.noResults")}
          disabled={saving}
          size={size}
          triggerTestID="service-register-workspace"
        />
        <SelectField
          label={t("services.registration.mount")}
          value={state.values.mount}
          selectedDisplay={mountDisplay}
          options={mountOptions}
          onChange={model.setMount}
          placeholder={t("services.registration.mount")}
          emptyText={t("common.empty.noResults")}
          disabled={saving}
          size={size}
          triggerTestID="service-register-mount"
        />
        {!available ? (
          <Alert variant="warning" description={t("services.registration.unavailable")} />
        ) : null}
        {state.operation.status === "error" ? (
          <Alert
            variant="error"
            description={t(registrationErrorKey(state.operation.code))}
            testID="service-register-error"
          />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing[4] },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
