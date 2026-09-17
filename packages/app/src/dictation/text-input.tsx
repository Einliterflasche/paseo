import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
} from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Mic, Square, X, RefreshCcw } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useDictation } from "@/hooks/use-dictation";
import type { UseDictationResult } from "@/hooks/use-dictation.shared";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";
import { registerDictationKeyboardTarget } from "./keyboard-targets";
import { insertTranscript } from "./insert-transcript";
import { isDictationInputFocused } from "./focus";
import { isWeb } from "@/constants/platform";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { resolveDictationSelection } from "./selection";

interface DictationTextInputProps extends AdaptiveTextInputProps {
  serverId: string | null;
  appearance?: "plain" | "form";
  size?: "sm" | "md";
  containerStyle?: StyleProp<ViewStyle>;
}

export const DictationTextInput = forwardRef<EditingTextInputHandle, DictationTextInputProps>(
  function DictationTextInput(
    {
      serverId,
      appearance = "plain",
      size = "md",
      containerStyle,
      onChangeText,
      onSelectionChange,
      editable = true,
      initialValue = "",
      testID,
      ...props
    },
    forwardedRef,
  ) {
    const targetId = useId();
    const panelActive = useRetainedPanelActive();
    const panelActiveRef = useRef(panelActive);
    panelActiveRef.current = panelActive;
    const inputRef = useRef<EditingTextInputHandle | null>(null);
    const containerRef = useRef<View | null>(null);
    const selectionRef = useRef({ start: initialValue.length, end: initialValue.length });
    const changeTextRef = useRef(onChangeText);
    changeTextRef.current = onChangeText;
    const store = getHostRuntimeStore();
    const runtime = useSyncExternalStore(
      (notify) => (serverId ? store.subscribe(serverId, notify) : () => {}),
      () => (serverId ? store.getSnapshot(serverId) : null),
      () => null,
    );
    const serverInfo = useSessionStore(
      useCallback(
        (state) => (serverId ? (state.sessions[serverId]?.serverInfo ?? null) : null),
        [serverId],
      ),
    );
    const readiness = getVoiceReadinessState({ serverInfo, mode: "dictation" });
    const client = runtime?.client ?? null;
    const isConnected = client?.isConnected ?? false;
    const capabilityEnabled = readiness?.enabled ?? true;
    const canStart = editable && isConnected && capabilityEnabled;

    const acceptTranscript = useCallback((transcript: string) => {
      const input = inputRef.current;
      if (!input) return;
      const insertion = insertTranscript({
        text: input.getText(),
        selection: resolveDictationSelection(
          isWeb ? input.getNativeRef() : null,
          selectionRef.current,
        ),
        transcript,
      });
      selectionRef.current = insertion.selection;
      input.replaceText(insertion.text, insertion.selection);
      changeTextRef.current?.(insertion.text);
    }, []);
    const dictation = useDictation({
      client,
      enabled: editable,
      targetKey: props.resetKey,
      canStart: () => canStart,
      canConfirm: () => client?.isConnected ?? false,
      onTranscript: acceptTranscript,
      enableDuration: true,
    });
    const pending = dictation.isRecording || dictation.isProcessing;
    const controlsRef = useRef(dictation);
    controlsRef.current = dictation;
    const canStartRef = useRef(canStart);
    canStartRef.current = canStart;

    const toggle = useCallback(() => {
      const current = controlsRef.current;
      if (current.isProcessing) return;
      if (current.status === "failed") {
        void current.retryFailedDictation();
      } else if (current.isRecordingActive()) {
        void current.confirmDictation();
      } else if (canStartRef.current) {
        void current.startDictation();
      }
    }, []);
    const cancel = useCallback(() => {
      const current = controlsRef.current;
      if (current.status === "failed") current.discardFailedDictation();
      else void current.cancelDictation();
    }, []);

    useEffect(
      () =>
        registerDictationKeyboardTarget({
          id: targetId,
          isFocused: () => isDictationInputFocused(inputRef, containerRef),
          isActive: () => controlsRef.current.isSessionActive(),
          isVisible: () => panelActiveRef.current,
          toggle,
          cancel,
          confirm: () => {
            const current = controlsRef.current;
            if (current.isRecordingActive()) void current.confirmDictation();
          },
        }),
      [cancel, targetId, toggle],
    );

    useImperativeHandle(
      forwardedRef,
      () => ({
        focus: () => inputRef.current?.focus(),
        blur: () => inputRef.current?.blur(),
        isFocused: () => inputRef.current?.isFocused() ?? false,
        getText: () => inputRef.current?.getText() ?? "",
        getNativeRef: () => inputRef.current?.getNativeRef(),
        replaceText: (text, selection) => {
          cancel();
          selectionRef.current = selection ?? { start: text.length, end: text.length };
          inputRef.current?.replaceText(text, selectionRef.current);
        },
        reset: () => {
          cancel();
          selectionRef.current = { start: 0, end: 0 };
          inputRef.current?.reset();
        },
      }),
      [cancel],
    );
    const trackSelection = useCallback<NonNullable<AdaptiveTextInputProps["onSelectionChange"]>>(
      (event) => {
        selectionRef.current = event.nativeEvent.selection;
        onSelectionChange?.(event);
      },
      [onSelectionChange],
    );
    const Input = appearance === "form" ? FormTextInput : AdaptiveTextInput;
    const sizeProps = appearance === "form" ? { size } : {};
    const inputEditable = editable && !pending;
    const suffix = testID ?? targetId;

    return (
      <View ref={containerRef} style={containerStyle}>
        <Input
          {...props}
          ref={inputRef}
          {...sizeProps}
          initialValue={initialValue}
          onChangeText={onChangeText}
          onSelectionChange={trackSelection}
          editable={inputEditable}
          testID={testID}
        />
        <FieldDictationControls
          dictation={dictation}
          canStart={canStart}
          reason={readiness?.reason}
          suffix={suffix}
          toggle={toggle}
          cancel={cancel}
        />
      </View>
    );
  },
);

interface FieldDictationControlsProps {
  dictation: UseDictationResult;
  canStart: boolean;
  reason: string | undefined;
  suffix: string;
  toggle: () => void;
  cancel: () => void;
}

function FieldDictationControls({
  dictation,
  canStart,
  reason,
  suffix,
  toggle,
  cancel,
}: FieldDictationControlsProps) {
  const { t } = useTranslation();
  const active = dictation.status !== "idle";
  const micDisabled = !canStart || dictation.busyElsewhere;
  const buttonLabel = active ? t("message.dictation.insert") : t("message.dictation.start");
  const icon = active ? Square : Mic;
  const timer = `${Math.floor(dictation.duration / 60)}:${String(dictation.duration % 60).padStart(2, "0")}`;
  return (
    <View style={styles.controls}>
      {dictation.error ? (
        <Text
          style={styles.error}
          numberOfLines={2}
          accessibilityRole="alert"
          testID={`${suffix}-dictation-error`}
        >
          {dictation.error}
        </Text>
      ) : null}
      {active ? (
        <Text style={styles.timer} testID={`${suffix}-dictation-status`}>
          {timer}
        </Text>
      ) : null}
      {active ? (
        <Button
          size="xs"
          variant="ghost"
          leftIcon={X}
          accessibilityLabel={t("message.dictation.cancel")}
          testID={`${suffix}-dictation-cancel`}
          onPress={cancel}
        />
      ) : null}
      {dictation.status === "failed" ? (
        <Button
          size="xs"
          variant="ghost"
          leftIcon={RefreshCcw}
          accessibilityLabel={t("message.dictation.retry")}
          testID={`${suffix}-dictation-retry`}
          onPress={toggle}
          disabled={!canStart}
        />
      ) : (
        <Button
          size="xs"
          variant="ghost"
          leftIcon={icon}
          accessibilityLabel={buttonLabel}
          accessibilityHint={reason}
          testID={`${suffix}-dictation-toggle`}
          onPress={toggle}
          loading={dictation.isProcessing}
          disabled={active ? dictation.isProcessing : micDisabled}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
    minHeight: 32,
  },
  timer: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  error: { flex: 1, color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
