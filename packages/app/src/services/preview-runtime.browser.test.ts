import { afterEach, describe, expect, it } from "vitest";
import { createPreviewThumbnailFrame } from "./preview-thumbnail-frame.web";

describe("service preview thumbnails", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("creates a noninteractive scaled frame and releases every frame on close", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);

    for (let index = 0; index < 20; index += 1) {
      const thumbnail = createPreviewThumbnailFrame({
        document,
        serviceId: `service-${index}`,
        anchor,
      });
      const frame = anchor.querySelector<HTMLIFrameElement>(
        '[data-testid="service-preview-thumbnail-frame"]',
      );
      expect(frame?.style.pointerEvents).toBe("none");
      expect(frame?.style.transform).toBe("scale(0.25)");
      expect(frame?.sandbox.contains("allow-scripts")).toBe(true);
      expect(frame?.sandbox.contains("allow-same-origin")).toBe(true);
      expect(frame?.sandbox.contains("allow-popups")).toBe(false);
      thumbnail.close();
      expect(anchor.childElementCount).toBe(0);
    }
  });
});
