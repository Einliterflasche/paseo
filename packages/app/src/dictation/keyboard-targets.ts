import type { KeyboardFocusScope } from "@/keyboard/actions";

export interface DictationKeyboardTarget {
  id: string;
  isFocused: () => boolean;
  isVisible: () => boolean;
  /** Owns a recording, pending transcription, or recoverable failed session. */
  isActive: () => boolean;
  toggle: () => void;
  cancel: () => void;
  confirm: () => void;
}

const targets = new Map<string, DictationKeyboardTarget>();

interface DictationKeyboardContext {
  focusScope: KeyboardFocusScope;
  commandCenterOpen: boolean;
  overlayOpen: boolean;
}

export function dispatchDictationSessionKey(
  event: {
    key: string;
    repeat?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  context: DictationKeyboardContext,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  let action: "cancel" | "confirm" | null = null;
  if (event.key === "Escape") action = "cancel";
  else if (event.key === "Enter" && !event.shiftKey && !event.altKey) action = "confirm";
  return (
    action !== null &&
    dispatchDictationKeyboardAction({ ...context, action, repeat: event.repeat }) === "handled"
  );
}

export function registerDictationKeyboardTarget(target: DictationKeyboardTarget): () => void {
  targets.set(target.id, target);
  return () => {
    if (targets.get(target.id) === target) targets.delete(target.id);
  };
}

export function dispatchDictationKeyboardAction(
  input: DictationKeyboardContext & {
    action: "toggle" | "cancel" | "confirm";
    repeat?: boolean;
  },
): "handled" | "composer" | "unhandled" {
  if (
    input.commandCenterOpen ||
    input.focusScope === "terminal" ||
    input.focusScope === "command-center" ||
    input.focusScope === "browser"
  ) {
    return "unhandled";
  }
  const entries = Array.from(targets.values());
  const active = entries.find((target) => target.isActive());
  const focused = entries.find((entry) => entry.isVisible() && entry.isFocused());
  const target = active ?? focused;
  if (target) {
    if (input.action !== "toggle" && (!active || !target.isVisible())) return "unhandled";
    if (
      input.action !== "toggle" &&
      !target.isFocused() &&
      (focused || input.focusScope !== "other" || input.overlayOpen)
    ) {
      return "unhandled";
    }
    if (!input.repeat) target[input.action]();
    return "handled";
  }
  return !input.overlayOpen &&
    (input.focusScope === "message-input" || input.focusScope === "other")
    ? "composer"
    : "unhandled";
}
