import type {
  PreparedPreview,
  PreviewLaunchOptions,
  PreviewLaunchReservation,
} from "./preview-coordinator";
import { submitPreviewForm } from "./preview-form.web";

/** Reserves a popup during the click and owns it until it closes or is released. */
export function reserveStandalonePreview({
  document,
  name,
  closed,
}: {
  document: Document;
  name: string;
  closed(): void;
}): PreviewLaunchReservation | null {
  const popup = document.defaultView?.open("about:blank", name);
  if (!popup) return null;
  popup.opener = null;
  let active = true;
  const timer = document.defaultView?.setInterval(() => {
    if (!active || !popup.closed) return;
    active = false;
    if (timer !== undefined) document.defaultView?.clearInterval(timer);
    closed();
  }, 500);

  return {
    launch(prepared: PreparedPreview, _options: PreviewLaunchOptions) {
      if (!active || popup.closed) throw new Error("Preview window closed");
      submitPreviewForm({ document, prepared, target: name, openerAlreadyCleared: true });
    },
    close() {
      if (!active) return;
      active = false;
      if (timer !== undefined) document.defaultView?.clearInterval(timer);
      if (!popup.closed) popup.close();
    },
  };
}
