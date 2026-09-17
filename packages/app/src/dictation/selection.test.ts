import { describe, expect, it } from "vitest";
import { resolveDictationSelection } from "./selection";

describe("dictation insertion selection", () => {
  it("reads an ordinary caret move even when no selection event updated the fallback", () => {
    const input = { selectionStart: 12, selectionEnd: 12 };
    expect(resolveDictationSelection(input, { start: 0, end: 0 })).toEqual({ start: 12, end: 12 });
    input.selectionStart = 5;
    input.selectionEnd = 5;
    expect(resolveDictationSelection(input, { start: 0, end: 0 })).toEqual({ start: 5, end: 5 });
  });

  it("preserves a selected replacement range after focus moves to microphone controls", () => {
    expect(
      resolveDictationSelection({ selectionStart: 5, selectionEnd: 12 }, { start: 0, end: 0 }),
    ).toEqual({ start: 5, end: 12 });
  });

  it("uses native selection tracking when no DOM input selection exists", () => {
    expect(resolveDictationSelection(null, { start: 4, end: 7 })).toEqual({ start: 4, end: 7 });
    expect(
      resolveDictationSelection({ selectionStart: null, selectionEnd: null }, { start: 4, end: 7 }),
    ).toEqual({ start: 4, end: 7 });
  });
});
