import type { StyleProp, TextStyle } from "react-native";
import { useLayoutEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { DictationTextInput } from "@/dictation/text-input";

interface SettingsTextAreaProps {
  accessibilityLabel: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  testID?: string;
  style?: StyleProp<TextStyle>;
  editable?: boolean;
  dictationServerId?: string | null;
}

export function SettingsTextArea({
  accessibilityLabel,
  value,
  onChangeText,
  placeholder,
  testID,
  style,
  editable,
  dictationServerId,
}: SettingsTextAreaProps) {
  const inputStyle = useMemo(() => [styles.input, style], [style]);
  const dictationInput = useRef<EditingTextInputHandle | null>(null);
  useLayoutEffect(() => {
    const input = dictationInput.current;
    if (input && input.getText() !== value) input.replaceText(value);
  }, [value]);

  if (dictationServerId !== undefined) {
    return (
      <DictationTextInput
        ref={dictationInput}
        serverId={dictationServerId}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        multiline
        initialValue={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={styles.placeholder.color}
        style={inputStyle}
        editable={editable}
      />
    );
  }

  return (
    <TextInput
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      multiline
      initialValue={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={styles.placeholder.color}
      style={inputStyle}
      editable={editable}
    />
  );
}

export function SettingsTextAreaCard(props: SettingsTextAreaProps) {
  return (
    <View style={settingsStyles.card}>
      <SettingsTextArea {...props} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  placeholder: { color: theme.colors.foregroundMuted },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    minHeight: 96,
    textAlignVertical: "top",
  },
}));
