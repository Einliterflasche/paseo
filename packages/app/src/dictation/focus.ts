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

/** Restore the editor after its controls disappear, without moving focus from another target. */
export function canRestoreDictationFocus(
  input: RefObject<EditingTextInputHandle | null>,
  container: RefObject<View | null>,
): boolean {
  if (isDictationInputFocused(input, container)) return true;
  if (!isWeb) return false;
  return document.activeElement === null || document.activeElement === document.body;
}

export function focusDictationContainer(container: RefObject<View | null>): void {
  if (isWeb && container.current instanceof HTMLElement) container.current.focus();
}

export function isDictationButtonFocused(container: RefObject<View | null>): boolean {
  if (!isWeb || !(container.current instanceof HTMLElement)) return false;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !container.current.contains(focused)) return false;
  const button = focused.closest('button, [role="button"]');
  return button !== null && container.current.contains(button);
}
