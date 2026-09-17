import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useMemo } from "react";
import { View, Text, Pressable, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw, Check, Mic, Pencil } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { VolumeMeter } from "./volume-meter";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { DictationStatus } from "@/hooks/use-dictation";

interface DictationControlsProps {
  volume: number;
  duration: number;
  transcript?: string;
  isRecording: boolean;
  isProcessing: boolean;
  status: DictationStatus;
  onStart: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onAcceptAndSend: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  disabled?: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function DictationControls({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  onStart,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  disabled = false,
}: DictationControlsProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const micButtonStyle = useMemo(
    () => [styles.micButton, disabled && styles.buttonDisabled],
    [disabled],
  );
  const timerTextStyle = useMemo(
    () => [styles.timerText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const cancelButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.actionButtonCancel,
      actionsDisabled && !isFailed ? styles.buttonDisabled : undefined,
    ],
    [actionsDisabled, isFailed],
  );

  if (!showActiveState) {
    return (
      <Pressable
        onPress={onStart}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.start")}
        style={micButtonStyle}
      >
        <Mic size={theme.iconSize.md} color={theme.colors.foreground} />
      </Pressable>
    );
  }

  return (
    <View style={styles.activeContainer}>
      <View style={styles.meterWrapper}>
        <VolumeMeter volume={volume} isMuted={false} isSpeaking={false} orientation="horizontal" />
      </View>
      <Text style={timerTextStyle}>{formatDuration(duration)}</Text>
      <View style={styles.actionGroup}>
        <Pressable
          onPress={handleCancel}
          disabled={actionsDisabled && !isFailed}
          accessibilityLabel={t("message.dictation.cancel")}
          style={cancelButtonStyle}
        >
          <X size={theme.iconSize.sm} color={theme.colors.foreground} />
        </Pressable>
        {actionsDisabled ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="small" color={theme.colors.foreground} />
          </View>
        ) : null}
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityLabel={t("message.dictation.retry")}
            style={[styles.actionButton, styles.actionButtonConfirm]}
          >
            <RefreshCcw size={theme.iconSize.sm} color={theme.colors.surface0} />
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityLabel={t("message.dictation.insert")}
              style={[styles.actionButton, styles.actionButtonSecondary]}
            >
              <Check size={theme.iconSize.sm} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityLabel={t("message.dictation.insertAndSend")}
              style={[styles.actionButton, styles.actionButtonConfirm]}
            >
              <ArrowUp size={theme.iconSize.sm} color={theme.colors.surface0} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

interface DictationOverlayProps extends Omit<
  DictationControlsProps,
  "onStart" | "disabled" | "transcript" | "onAcceptAndSend"
> {
  errorText?: string;
  onAcceptAndSend?: () => void;
  submitLabel?: string;
  allowCancelWhileProcessing?: boolean;
  retryDisabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Shared recording surface for the chat composer and dictatable text fields. */
export function DictationOverlay({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  errorText,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  submitLabel,
  allowCancelWhileProcessing = false,
  retryDisabled = false,
  compact = false,
  style,
  testID,
}: DictationOverlayProps) {
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const cancelDisabled = isProcessing && !allowCancelWhileProcessing && !isFailed;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;
  const iconSize = compact ? compactOverlayIcon : overlayIcon;

  if (!showActiveState) return null;

  return (
    <View
      style={[overlayStyles.container, compact && overlayStyles.compactContainer, style]}
      testID={overlayTestID(testID, "overlay")}
    >
      <Pressable
        onPress={handleCancel}
        disabled={cancelDisabled}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.cancel")}
        testID={overlayTestID(testID, "cancel")}
        style={[
          overlayStyles.cancelButton,
          compact && overlayStyles.compactButton,
          cancelDisabled && overlayStyles.buttonDisabled,
        ]}
      >
        <OverlayX uniProps={iconSize} strokeWidth={2.5} />
      </Pressable>

      <DictationOverlayCenter
        volume={volume}
        duration={duration}
        compact={compact}
        isFailed={isFailed}
        errorText={errorText}
        testID={testID}
      />

      <DictationOverlayActions
        isProcessing={isProcessing}
        isFailed={isFailed}
        retryDisabled={retryDisabled}
        compact={compact}
        testID={testID}
        onRetry={onRetry}
        onAccept={onAccept}
        onAcceptAndSend={onAcceptAndSend}
        submitLabel={submitLabel}
      />
    </View>
  );
}

function DictationOverlayCenter({
  volume,
  duration,
  compact,
  isFailed,
  errorText,
  testID,
}: Pick<DictationOverlayProps, "volume" | "duration" | "compact" | "errorText" | "testID"> & {
  isFailed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={overlayStyles.centerContainer}>
      {!(compact && isFailed) ? (
        <View style={[overlayStyles.meterRow, compact && overlayStyles.compactMeterRow]}>
          <OverlayVolumeMeter
            volume={volume}
            isMuted={false}
            isSpeaking={false}
            orientation="horizontal"
            variant={compact ? "compact" : "default"}
            uniProps={overlayForeground}
            testID={overlayTestID(testID, "meter")}
          />
          <Text
            style={[overlayStyles.timerText, compact && overlayStyles.compactTimerText]}
            testID={overlayTestID(testID, "status")}
          >
            {formatDuration(duration)}
          </Text>
        </View>
      ) : null}
      {isFailed ? (
        <Text
          numberOfLines={2}
          style={overlayStyles.transcriptText}
          accessibilityRole="alert"
          testID={overlayTestID(testID, "error")}
        >
          {errorText
            ? t("message.dictation.failed", { error: errorText })
            : t("message.dictation.failedRetry")}
        </Text>
      ) : null}
    </View>
  );
}

function DictationOverlayActions({
  isProcessing,
  isFailed,
  retryDisabled,
  compact,
  testID,
  onRetry,
  onAccept,
  onAcceptAndSend,
  submitLabel,
}: Pick<
  DictationOverlayProps,
  | "isProcessing"
  | "retryDisabled"
  | "compact"
  | "testID"
  | "onRetry"
  | "onAccept"
  | "onAcceptAndSend"
  | "submitLabel"
> & { isFailed: boolean }) {
  const { t } = useTranslation();
  const iconSize = compact ? compactOverlayIcon : overlayIcon;
  const confirmIconSize = compact ? compactConfirmIcon : confirmIcon;
  return (
    <View style={overlayStyles.actionButtonsContainer}>
      {isProcessing ? (
        <View style={[overlayStyles.loadingContainer, compact && overlayStyles.compactButton]}>
          <OverlaySpinner size="small" uniProps={overlayForeground} />
        </View>
      ) : null}
      {!isProcessing && isFailed ? (
        <Pressable
          onPress={onRetry}
          disabled={retryDisabled}
          accessibilityRole="button"
          accessibilityLabel={t("message.dictation.retry")}
          testID={overlayTestID(testID, "retry")}
          style={[
            overlayStyles.actionButton,
            overlayStyles.confirmButton,
            compact && overlayStyles.compactButton,
            retryDisabled && overlayStyles.buttonDisabled,
          ]}
        >
          <OverlayRetry uniProps={confirmIconSize} strokeWidth={2.5} />
        </Pressable>
      ) : null}
      {!isProcessing && !isFailed ? (
        <>
          {onAcceptAndSend ? (
            <Pressable
              onPress={onAccept}
              accessibilityRole="button"
              accessibilityLabel={t("message.dictation.insert")}
              testID={overlayTestID(testID, "toggle")}
              style={[
                overlayStyles.actionButton,
                OVERLAY_ACCEPT_BUTTON_BG,
                compact && overlayStyles.compactButton,
              ]}
            >
              <OverlayPencil uniProps={iconSize} strokeWidth={2.5} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={onAcceptAndSend ?? onAccept}
            accessibilityRole="button"
            accessibilityLabel={
              onAcceptAndSend
                ? (submitLabel ?? t("message.dictation.insertAndSend"))
                : t("message.dictation.insert")
            }
            testID={overlayTestID(testID, onAcceptAndSend ? "submit" : "toggle")}
            style={[
              overlayStyles.actionButton,
              overlayStyles.confirmButton,
              compact && overlayStyles.compactButton,
            ]}
          >
            <OverlayArrow uniProps={confirmIconSize} strokeWidth={2.5} />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function overlayTestID(prefix: string | undefined, suffix: string) {
  return prefix ? `${prefix}-${suffix}` : undefined;
}

const OverlayX = withUnistyles(X);
const OverlayPencil = withUnistyles(Pencil);
const OverlayArrow = withUnistyles(ArrowUp);
const OverlayRetry = withUnistyles(RefreshCcw);
const OverlayVolumeMeter = withUnistyles(VolumeMeter);
const OverlaySpinner = withUnistyles(LoadingSpinner);
const overlayForeground = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.accentForeground,
});
const overlayIcon = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.accentForeground,
  size: theme.iconSize.lg,
});
const compactOverlayIcon = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.accentForeground,
  size: theme.iconSize.md,
});
const confirmIcon = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.accent,
  size: theme.iconSize.lg,
});
const compactConfirmIcon = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.accent,
  size: theme.iconSize.md,
});

const BUTTON_SIZE = 32;

const styles = StyleSheet.create((theme) => ({
  micButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  activeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  meterWrapper: {
    width: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  timerText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionButtonCancel: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonConfirm: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  loadingContainer: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;

const overlayStyles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.accent,
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    height: FOOTER_HEIGHT,
  },
  cancelButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerContainer: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  meterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  timerText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  transcriptText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
    paddingHorizontal: theme.spacing[2],
    opacity: 0.95,
  },
  actionButtonsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  compactContainer: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
  },
  compactButton: { width: BUTTON_SIZE, height: BUTTON_SIZE },
  compactMeterRow: { gap: theme.spacing[2] },
  compactTimerText: { fontSize: theme.fontSize.base },
  confirmButton: { backgroundColor: theme.colors.accentForeground },
  buttonDisabled: {
    opacity: 0.5,
  },
  loadingContainer: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
}));

const OVERLAY_ACCEPT_BUTTON_BG = { backgroundColor: "rgba(255, 255, 255, 0.25)" };
