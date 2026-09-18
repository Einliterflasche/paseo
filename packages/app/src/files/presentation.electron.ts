import { getDesktopHost } from "@/desktop/host";
import type { ReservedFileTab } from "./presentation-types";
export { getMediaKind } from "./presentation-types";
export { browserCanPlay } from "./presentation.web";
export type { ReservedFileTab } from "./presentation-types";

// The desktop bridge opens the system browser without a web popup gesture.
export function browserCanViewPdf(): boolean {
  return typeof getDesktopHost()?.opener?.openUrl === "function";
}

export function reserveFileTab(): ReservedFileTab | null {
  const opener = getDesktopHost()?.opener?.openUrl;
  if (!opener) return null;
  return { open: opener, close() {} };
}
