import type { RefObject } from "react";
import type { View } from "react-native";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";

export function isDictationInputFocused(
  input: RefObject<EditingTextInputHandle | null>,
  container: RefObject<View | null>,
): boolean {
  if (input.current?.isFocused()) return true;
  if (!isWeb || typeof HTMLElement === "undefined") return false;
  return (
    container.current instanceof HTMLElement && container.current.contains(document.activeElement)
  );
}
