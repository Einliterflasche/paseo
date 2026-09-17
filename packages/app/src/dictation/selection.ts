interface Selection {
  start: number;
  end: number;
}

// React Native Web's selection callback does not cover ordinary caret moves.
// Read the DOM input's current selection even after it blurs onto the mic button.
export function resolveDictationSelection(input: unknown, fallback: Selection): Selection {
  if (input && typeof input === "object" && "selectionStart" in input && "selectionEnd" in input) {
    const { selectionStart, selectionEnd } = input;
    if (typeof selectionStart === "number" && typeof selectionEnd === "number") {
      return { start: selectionStart, end: selectionEnd };
    }
  }
  return fallback;
}
