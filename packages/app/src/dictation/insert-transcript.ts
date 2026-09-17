interface TranscriptInsertion {
  text: string;
  selection: { start: number; end: number };
  transcript: string;
}

export function insertTranscript({ text, selection, transcript }: TranscriptInsertion) {
  const spoken = transcript.trim();
  if (!spoken) return { text, selection };

  const start = Math.min(selection.start, text.length);
  const end = Math.min(Math.max(selection.end, start), text.length);
  const before = text.slice(0, start);
  const after = text.slice(end);
  const needsLeadingSpace =
    before.length > 0 && !/[\s([{]$/u.test(before) && !/^[.,!?;:)}\]]/u.test(spoken);
  const needsTrailingSpace =
    after.length > 0 && !/^[\s.,!?;:)}\]]/u.test(after) && !/[([{]$/u.test(spoken);
  const leadingSpace = needsLeadingSpace ? " " : "";
  const trailingSpace = needsTrailingSpace ? " " : "";
  const inserted = `${leadingSpace}${spoken}${trailingSpace}`;
  const nextText = `${before}${inserted}${after}`;
  const caret = before.length + inserted.length;
  return { text: nextText, selection: { start: caret, end: caret } };
}
