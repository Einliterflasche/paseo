import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchDictationKeyboardAction,
  dispatchDictationSessionKey,
  registerDictationKeyboardTarget,
  type DictationKeyboardTarget,
} from "./keyboard-targets";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function register(overrides: Partial<DictationKeyboardTarget> = {}) {
  const actions: string[] = [];
  cleanup.push(
    registerDictationKeyboardTarget({
      id: "comment",
      isFocused: () => true,
      isVisible: () => true,
      isActive: () => false,
      toggle: () => actions.push("toggle"),
      cancel: () => actions.push("cancel"),
      confirm: () => actions.push("confirm"),
      ...overrides,
    }),
  );
  return actions;
}

const context = {
  action: "toggle" as const,
  focusScope: "editable" as const,
  commandCenterOpen: false,
  overlayOpen: false,
};

describe("dictation keyboard targets", () => {
  it("directs dictation to the focused field instead of the composer", () => {
    const actions = register();
    expect(dispatchDictationKeyboardAction(context)).toBe("handled");
    expect(actions).toEqual(["toggle"]);
  });

  it("keeps Ctrl+D on the recording owner but leaves another field's Enter and Escape alone", () => {
    const active = register({ isActive: () => true, isFocused: () => false });
    const focused = register({ id: "other" });
    expect(dispatchDictationKeyboardAction(context)).toBe("handled");
    expect(dispatchDictationKeyboardAction({ ...context, action: "confirm" })).toBe("unhandled");
    expect(dispatchDictationKeyboardAction({ ...context, action: "cancel" })).toBe("unhandled");
    expect(active).toEqual(["toggle"]);
    expect(focused).toEqual([]);
  });

  it("stops hidden owners with Ctrl+D but never confirms or cancels them from bare-page keys", () => {
    const actions = register({ isActive: () => true, isVisible: () => false });
    for (const action of ["confirm", "cancel"] as const) {
      expect(dispatchDictationKeyboardAction({ ...context, action, focusScope: "other" })).toBe(
        "unhandled",
      );
    }
    expect(dispatchDictationKeyboardAction(context)).toBe("handled");
    expect(actions).toEqual(["toggle"]);
  });

  it("lets idle fields retain Enter and Escape", () => {
    const actions = register();
    expect(dispatchDictationKeyboardAction({ ...context, action: "confirm" })).toBe("unhandled");
    expect(dispatchDictationKeyboardAction({ ...context, action: "cancel" })).toBe("unhandled");
    expect(actions).toEqual([]);
  });

  it("consumes a disabled focused field's toggle without falling through to chat", () => {
    register({ toggle: () => {} });
    expect(dispatchDictationKeyboardAction(context)).toBe("handled");
  });

  it("allows chat fallback only outside unrelated editors, browsers, terminals and overlays", () => {
    for (const focusScope of ["editable", "browser", "terminal", "command-center"] as const) {
      expect(dispatchDictationKeyboardAction({ ...context, focusScope })).toBe("unhandled");
    }
    for (const focusScope of ["message-input", "other"] as const) {
      expect(dispatchDictationKeyboardAction({ ...context, focusScope })).toBe("composer");
      expect(dispatchDictationKeyboardAction({ ...context, focusScope, overlayOpen: true })).toBe(
        "unhandled",
      );
      expect(
        dispatchDictationKeyboardAction({ ...context, focusScope, commandCenterOpen: true }),
      ).toBe("unhandled");
    }
  });

  it("does not capture terminal or command-center keys even with an active recording", () => {
    const actions = register({ isActive: () => true });
    for (const focusScope of ["terminal", "command-center", "browser"] as const) {
      for (const action of ["toggle", "cancel", "confirm"] as const) {
        expect(dispatchDictationKeyboardAction({ ...context, focusScope, action })).toBe(
          "unhandled",
        );
      }
    }
    expect(actions).toEqual([]);
  });

  it("allows a focused field inside a modal and cancels its active session", () => {
    let active = false;
    const actions = register({ isActive: () => active });
    expect(dispatchDictationKeyboardAction({ ...context, overlayOpen: true })).toBe("handled");
    active = true;
    expect(
      dispatchDictationKeyboardAction({ ...context, overlayOpen: true, action: "cancel" }),
    ).toBe("handled");
    expect(actions).toEqual(["toggle", "cancel"]);
  });

  it("leaves unrelated editors and overlays alone while allowing bare-page session control", () => {
    const actions = register({ isActive: () => true, isFocused: () => false });
    for (const action of ["confirm", "cancel"] as const) {
      expect(dispatchDictationKeyboardAction({ ...context, action })).toBe("unhandled");
      expect(
        dispatchDictationKeyboardAction({
          ...context,
          action,
          focusScope: "other",
          overlayOpen: true,
        }),
      ).toBe("unhandled");
      expect(dispatchDictationKeyboardAction({ ...context, action, focusScope: "other" })).toBe(
        "handled",
      );
    }
    expect(actions).toEqual(["confirm", "cancel"]);
  });

  it("unregisters closed fields without removing a replacement registration", () => {
    register();
    const disposeFirst = cleanup[0]!;
    const replacement = register();
    disposeFirst();
    expect(dispatchDictationKeyboardAction(context)).toBe("handled");
    expect(replacement).toEqual(["toggle"]);
    cleanup[1]!();
    expect(dispatchDictationKeyboardAction(context)).toBe("unhandled");
  });

  it("consumes active-session Enter and Escape but leaves IME and newline keys alone", () => {
    const actions = register({ isActive: () => true });
    expect(dispatchDictationSessionKey({ key: "Enter" }, context)).toBe(true);
    expect(dispatchDictationSessionKey({ key: "Escape" }, context)).toBe(true);
    expect(dispatchDictationSessionKey({ key: "Enter", repeat: true }, context)).toBe(true);
    for (const event of [
      { key: "Enter", isComposing: true },
      { key: "Enter", keyCode: 229 },
      { key: "Enter", shiftKey: true },
      { key: "Enter", altKey: true },
      { key: "a" },
    ]) {
      expect(dispatchDictationSessionKey(event, context)).toBe(false);
    }
    expect(actions).toEqual(["confirm", "cancel"]);
  });
});
