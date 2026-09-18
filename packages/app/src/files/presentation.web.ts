import { isWeb } from "@/constants/platform";
import type { ReservedFileTab } from "./presentation-types";
export { getMediaKind } from "./presentation-types";
export type { ReservedFileTab } from "./presentation-types";

export function browserCanPlay(mimeType: string): boolean {
  return isWeb && document.createElement("video").canPlayType(mimeType) !== "";
}

export function browserCanViewPdf(): boolean {
  return isWeb && navigator.pdfViewerEnabled === true;
}

// Reserve synchronously within the click, before the authenticated RPC. Using
// noopener in window.open returns null even on success, so sever it immediately.
export function reserveFileTab(): ReservedFileTab | null {
  if (!isWeb) return null;
  const tab = window.open("about:blank", "_blank");
  if (!tab) return null;
  tab.opener = null;
  tab.document.title = "Opening file…";
  const policy = tab.document.createElement("meta");
  policy.name = "referrer";
  policy.content = "no-referrer";
  tab.document.head.appendChild(policy);
  tab.document.body.textContent = "Opening file…";
  return {
    open(url) {
      if (tab.closed) throw new Error("The file tab was closed. Click the file link to try again.");
      tab.location.replace(url);
    },
    close() {
      tab.close();
    },
  };
}
