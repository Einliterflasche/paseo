import { describe, expect, it } from "vitest";
import { decideFileOpening } from "./open-decision";

describe("file opening", () => {
  const capabilities = {
    canPlay: (mime: string) => mime === "video/mp4" || mime === "audio/wav",
    canViewPdf: true,
  };
  it.each(["text", "image"] as const)("keeps %s in its existing Paseo viewer", (kind) => {
    expect(decideFileOpening({ kind, mimeType: "irrelevant" }, capabilities)).toBe("pane");
  });
  it.each(["video/mp4", "audio/wav"])("opens supported %s in the media pane", (mimeType) => {
    expect(decideFileOpening({ kind: "binary", mimeType }, capabilities)).toBe("pane");
  });
  it("opens PDF in the browser without requesting a second saved copy", () => {
    expect(decideFileOpening({ kind: "binary", mimeType: "application/pdf" }, capabilities)).toBe(
      "browser",
    );
  });
  it.each([
    "application/pdf",
    "video/unknown",
    "application/octet-stream",
    "application/x-unregistered",
  ])("downloads unsupported %s", (mimeType) => {
    expect(
      decideFileOpening({ kind: "binary", mimeType }, { ...capabilities, canViewPdf: false }),
    ).toBe("download");
  });
});
