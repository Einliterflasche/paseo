interface PreviewThumbnailFrameInput {
  document: Document;
  anchor: HTMLElement;
  serviceId: string;
}

export function createPreviewThumbnailFrame({
  document,
  anchor,
  serviceId,
}: PreviewThumbnailFrameInput) {
  // oxlint-disable-next-line react/iframe-missing-sandbox -- Set before DOM attachment below.
  const frame = document.createElement("iframe");
  frame.dataset.testid = "service-preview-thumbnail-frame";
  frame.dataset.serviceId = serviceId;
  frame.title = serviceId;
  frame.name = `paseo-service-thumbnail-${crypto.randomUUID()}`;
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.referrerPolicy = "no-referrer";
  Object.assign(frame.style, {
    position: "absolute",
    inset: "0 auto auto 0",
    width: "400%",
    height: "400%",
    border: "0",
    pointerEvents: "none",
    transform: "scale(0.25)",
    transformOrigin: "top left",
  });
  anchor.appendChild(frame);
  return {
    frame,
    close() {
      frame.remove();
    },
  };
}
