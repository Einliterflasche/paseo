import type { ReservedFileTab } from "./presentation-types";
export { getMediaKind } from "./presentation-types";
export type { ReservedFileTab } from "./presentation-types";

export function browserCanPlay(_mimeType: string): boolean {
  return false;
}
export function browserCanViewPdf(): boolean {
  return false;
}

export function reserveFileTab(): ReservedFileTab | null {
  return null;
}
