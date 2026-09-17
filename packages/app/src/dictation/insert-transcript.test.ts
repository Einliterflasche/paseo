import { describe, expect, it } from "vitest";
import { insertTranscript } from "./insert-transcript";

describe("insertTranscript", () => {
  it("preserves existing text on both sides of the caret", () => {
    expect(
      insertTranscript({
        text: "Please fix this",
        selection: { start: 7, end: 7 },
        transcript: "carefully",
      }),
    ).toEqual({ text: "Please carefully fix this", selection: { start: 17, end: 17 } });
  });

  it("replaces only the selected text", () => {
    expect(
      insertTranscript({
        text: "This is wrong.",
        selection: { start: 8, end: 13 },
        transcript: "correct",
      }),
    ).toEqual({ text: "This is correct.", selection: { start: 15, end: 15 } });
  });

  it("separates an appended transcript from existing prose", () => {
    expect(
      insertTranscript({
        text: "First sentence.",
        selection: { start: 15, end: 15 },
        transcript: "Second sentence.",
      }).text,
    ).toBe("First sentence. Second sentence.");
  });

  it("preserves line breaks and punctuation at the insertion boundary", () => {
    expect(
      insertTranscript({ text: "Notes:\n()", selection: { start: 8, end: 8 }, transcript: "hello" })
        .text,
    ).toBe("Notes:\n(hello)");
  });

  it("does not erase a selection when transcription is empty", () => {
    expect(
      insertTranscript({ text: "Keep this", selection: { start: 0, end: 9 }, transcript: " " }),
    ).toEqual({ text: "Keep this", selection: { start: 0, end: 9 } });
  });

  it("uses the current editor text if it was replaced programmatically", () => {
    expect(
      insertTranscript({ text: "New", selection: { start: 12, end: 12 }, transcript: "note" }),
    ).toEqual({ text: "New note", selection: { start: 8, end: 8 } });
  });
});
