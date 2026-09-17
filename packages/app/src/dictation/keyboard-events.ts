import { dispatchDictationSessionKey } from "./keyboard-targets";
import { resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { hasActiveWebOverlay } from "@/lib/overlay-root";

/** Call before a capture-phase form shortcut can save or dismiss its editor. */
export function handleDictationSessionKeyDown(event: KeyboardEvent): boolean {
  const store = useKeyboardShortcutsStore.getState();
  if (store.capturingShortcut) return false;
  const handled = dispatchDictationSessionKey(event, {
    focusScope: resolveKeyboardFocusScope({
      target: event.target,
      commandCenterOpen: store.commandCenterOpen,
    }),
    commandCenterOpen: store.commandCenterOpen,
    overlayOpen: hasActiveWebOverlay(),
  });
  if (handled) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  return handled;
}
