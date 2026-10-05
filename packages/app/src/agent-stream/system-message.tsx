import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentMessageSender } from "@getpaseo/protocol/agent-message";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { messageSenderLabel, systemMessageLabel } from "./system-message-label";

interface SystemMessageProps {
  message: string;
  sender?: AgentMessageSender;
}

export const SystemMessage = memo(function SystemMessage({ message, sender }: SystemMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const webAccessibility = useMemo(() => (isWeb ? { "aria-expanded": expanded } : {}), [expanded]);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const label = `${messageSenderLabel(sender)} · ${systemMessageLabel(message, sender)}`;
  return (
    <View style={styles.row} dataSet={CODE_SURFACE_DATASET} testID="system-message">
      <Button
        {...webAccessibility}
        variant="ghost"
        size="xs"
        style={styles.trigger}
        textStyle={styles.label}
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        onPress={toggle}
        testID="system-message-toggle"
      >
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
      </Button>
      {expanded ? (
        <Text selectable style={styles.content} testID="system-message-content">
          {message}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  trigger: {
    maxWidth: "100%",
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  content: {
    width: "100%",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
