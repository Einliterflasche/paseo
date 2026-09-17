import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Mic } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useDictation } from "@/hooks/use-dictation";
import { DictationOverlay } from "@/components/dictation-controls";
import type { UseDictationResult } from "@/hooks/use-dictation.shared";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";
import { registerDictationKeyboardTarget } from "./keyboard-targets";
import { insertTranscript } from "./insert-transcript";
import {
  canRestoreDictationFocus,
  isDictationInputFocused,
  focusDictationContainer,
  isDictationButtonFocused,
} from "./focus";
import { isWeb } from "@/constants/platform";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { resolveDictationSelection } from "./selection";

interface DictationTextInputProps extends AdaptiveTextInputProps {
  serverId: string | null;
  appearance?: "plain" | "form";
  size?: "sm" | "md";
  containerStyle?: StyleProp<ViewStyle>;
  /** Receives the complete inserted text; the parent may not have rendered it yet. */
  onDictationSubmit?: (text: string) => void;
  dictationSubmitLabel?: string;
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
      onDictationSubmit,
      dictationSubmitLabel,
      style,
      editable = true,
      initialValue = "",
      testID,
      ...props
    },
    forwardedRef,
  ) {
    const targetId = useId();
    const [compactOverlay, setCompactOverlay] = useState(false);
    const measureField = useCallback((event: LayoutChangeEvent) => {
      setCompactOverlay(event.nativeEvent.layout.height < FOOTER_HEIGHT);
    }, []);
    const submitRef = useRef(onDictationSubmit);
    submitRef.current = onDictationSubmit;
    // The first stop action owns the eventual final, including retries. Cancel,
    // reset, or a fresh recording clears it before another session can use it.
    const restoreFocusRef = useRef(false);
    const stopActionRef = useRef<"insert" | "submit" | null>(null);
    const panelActive = useRetainedPanelActive();
    const panelActiveRef = useRef(panelActive);
    panelActiveRef.current = panelActive;
    const inputRef = useRef<EditingTextInputHandle | null>(null);
    const containerRef = useRef<View | null>(null);
    const selectionRef = useRef({ start: initialValue.length, end: initialValue.length });
    const changeTextRef = useRef(onChangeText);
    changeTextRef.current = onChangeText;
    const { client, canStart, reason } = useDictationConnection(serverId, editable);

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
      const shouldSubmit = stopActionRef.current === "submit";
      stopActionRef.current = null;
      restoreFocusRef.current = !shouldSubmit;
      changeTextRef.current?.(insertion.text);
      if (shouldSubmit) submitRef.current?.(insertion.text);
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
    const controlsRef = useRef(dictation);
    controlsRef.current = dictation;
    const canStartRef = useRef(canStart);
    canStartRef.current = canStart;

    const accept = useCallback((submit: boolean) => {
      const current = controlsRef.current;
      if (!current.isRecordingActive() || current.isProcessing || stopActionRef.current) return;
      stopActionRef.current = submit ? "submit" : "insert";
      void current.confirmDictation();
    }, []);
    const insert = useCallback(() => accept(false), [accept]);
    const submit = useCallback(() => accept(true), [accept]);
    const toggle = useCallback(() => {
      const current = controlsRef.current;
      if (current.isProcessing) return;
      if (current.status === "failed") {
        void current.retryFailedDictation();
      } else if (current.isRecordingActive()) {
        insert();
      } else if (canStartRef.current) {
        stopActionRef.current = null;
        void current.startDictation();
      }
    }, [insert]);
    const cancel = useCallback(() => {
      restoreFocusRef.current = false;
      stopActionRef.current = null;
      const current = controlsRef.current;
      if (current.status === "failed" || current.status === "idle") current.reset();
      else void current.cancelDictation();
    }, []);

    const cancelAndFocus = useCallback(() => {
      cancel();
      restoreFocusRef.current = true;
    }, [cancel]);

    useEffect(
      () =>
        registerDictationKeyboardTarget({
          id: targetId,
          isFocused: () => isDictationInputFocused(inputRef, containerRef),
          isControlFocused: () => isDictationButtonFocused(containerRef),
          isActive: () => controlsRef.current.isSessionActive(),
          isVisible: () => panelActiveRef.current,
          toggle,
          cancel: cancelAndFocus,
          confirm: insert,
        }),
      [cancelAndFocus, insert, targetId, toggle],
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
    const active = dictation.status !== "idle" || dictation.error !== null;
    useLayoutEffect(() => {
      if (active) {
        if (
          panelActiveRef.current &&
          !isDictationButtonFocused(containerRef) &&
          canRestoreDictationFocus(inputRef, containerRef)
        ) {
          focusDictationContainer(containerRef);
        }
        return;
      }
      if (!restoreFocusRef.current) return;
      restoreFocusRef.current = false;
      if (panelActiveRef.current && canRestoreDictationFocus(inputRef, containerRef)) {
        inputRef.current?.focus();
      }
    }, [active, dictation.isProcessing, dictation.status]);
    const inputEditable = editable && !active;
    const suffix = `${testID ?? targetId}-dictation`;

    return (
      <View
        ref={containerRef}
        style={containerStyle}
        testID={`${suffix}-field`}
        onLayout={measureField}
        tabIndex={isWeb ? -1 : undefined}
      >
        {/* Retain the editor and its selection while replacing only its presentation. */}
        <View
          style={[styles.inputFrame, active && styles.hiddenInput]}
          pointerEvents={active ? "none" : "auto"}
          accessibilityElementsHidden={active}
          importantForAccessibility={active ? "no-hide-descendants" : "auto"}
          aria-hidden={active}
        >
          <Input
            {...props}
            ref={inputRef}
            {...sizeProps}
            initialValue={initialValue}
            onChangeText={onChangeText}
            onSelectionChange={trackSelection}
            editable={inputEditable}
            tabIndex={active && isWeb ? -1 : props.tabIndex}
            style={[style, styles.inputWithMicrophone]}
            testID={testID}
          />
        </View>
        <FieldDictationControls
          dictation={dictation}
          active={active}
          canStart={canStart}
          reason={reason}
          suffix={suffix}
          compact={compactOverlay}
          toggle={toggle}
          cancel={cancelAndFocus}
          insert={insert}
          submit={onDictationSubmit ? submit : undefined}
          submitLabel={dictationSubmitLabel}
        />
      </View>
    );
  },
);

function useDictationConnection(serverId: string | null, editable: boolean) {
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

  return { client, canStart, reason: readiness?.reason };
}

interface FieldDictationControlsProps {
  dictation: UseDictationResult;
  active: boolean;
  canStart: boolean;
  reason?: string;
  suffix: string;
  compact: boolean;
  toggle: () => void;
  cancel: () => void;
  insert: () => void;
  submit?: () => void;
  submitLabel?: string;
}

function FieldDictationControls({
  dictation,
  active,
  canStart,
  reason,
  suffix,
  compact,
  toggle,
  cancel,
  insert,
  submit,
  submitLabel,
}: FieldDictationControlsProps) {
  const { t } = useTranslation();
  if (active) {
    const failed = dictation.status === "failed" || dictation.status === "idle";
    return (
      <DictationOverlay
        volume={dictation.volume}
        duration={dictation.duration}
        isRecording={dictation.isRecording}
        isProcessing={dictation.isProcessing}
        status={failed ? "failed" : dictation.status}
        errorText={dictation.error ?? undefined}
        onCancel={cancel}
        onDiscard={cancel}
        onAccept={insert}
        onAcceptAndSend={submit}
        submitLabel={submitLabel}
        onRetry={toggle}
        retryDisabled={!canStart}
        allowCancelWhileProcessing
        compact={compact || failed}
        style={styles.overlay}
        testID={suffix}
      />
    );
  }
  return (
    <View style={styles.microphone}>
      <Button
        size="xs"
        variant="ghost"
        leftIcon={Mic}
        accessibilityLabel={t("message.dictation.start")}
        accessibilityHint={reason}
        testID={`${suffix}-toggle`}
        onPress={toggle}
        disabled={!canStart || dictation.busyElsewhere}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inputFrame: { flexGrow: 1, flexShrink: 1 },
  inputWithMicrophone: { paddingRight: theme.spacing[12] },
  hiddenInput: { opacity: 0 },
  microphone: {
    position: "absolute",
    right: theme.spacing[1],
    bottom: theme.spacing[1],
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    height: "100%",
  },
}));
