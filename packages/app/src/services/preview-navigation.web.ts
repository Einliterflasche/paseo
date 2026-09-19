import type { PreparedPreview, PreviewLaunchOptions } from "./preview-coordinator";
import { submitPreviewForm } from "./preview-form.web";

interface PreviewNavigationOptions extends PreviewLaunchOptions {
  document: Document;
  frame: HTMLIFrameElement;
  prepared: PreparedPreview;
  completed(success: boolean): void;
}

function isApplication(document: Document | null, origin: string, serviceId: string): boolean {
  if (!document) return false;
  const url = new URL(document.URL);
  return (
    url.origin === origin &&
    url.pathname.startsWith(`/__paseo_services/apps/${encodeURIComponent(serviceId)}/`) &&
    !document.querySelector("[data-paseo-preview-error]")
  );
}

/** Reauthorization confirms cookies in a disposable frame, preserving the app's document. */
export function openPreviewDocument({
  document,
  frame,
  prepared,
  signal,
  reload,
  completed,
}: PreviewNavigationOptions): void {
  if (signal.aborted) return;
  const origin = document.location.origin;
  const preserve = !reload && isApplication(frame.contentDocument, origin, prepared.serviceId);
  const target = preserve ? document.createElement("iframe") : frame;
  if (preserve) {
    target.name = `paseo-preview-resume:${prepared.bootstrapId}`;
    target.hidden = true;
    target.title = "Restore preview access";
    target.tabIndex = -1;
  }
  const before = target.contentDocument;
  let stopped = false;

  function dispose(): void {
    if (stopped) return;
    stopped = true;
    target.removeEventListener("load", loaded);
    signal.removeEventListener("abort", cancel);
    if (preserve) target.remove();
  }

  function cancel(): void {
    if (stopped) return;
    dispose();
    if (preserve) return;
    // Removing observation does not cancel a resident frame's navigation. Keep
    // its permanent element/parent, but stop this attempt before a late response
    // can execute the confirmation document or replace the app.
    try {
      target.contentWindow?.stop();
    } catch {
      // A completed foreign redirect is inaccessible. Navigating this same
      // element to a local blank document cancels its outstanding navigation.
      target.src = "about:blank";
    }
  }

  function finish(success: boolean): void {
    dispose();
    if (!signal.aborted) completed(success);
  }

  function loaded(): void {
    if (stopped) return;
    const current = target.contentDocument;
    if (!current) {
      finish(false);
      return;
    }
    if (current === before || current.URL === "about:blank") return;
    const url = new URL(current.URL);
    const confirmation =
      url.origin === origin &&
      url.pathname === `/__paseo_services/confirm/${prepared.bootstrapId}` &&
      current.querySelector("[data-paseo-preview-confirmation]") !== null;
    if (confirmation) {
      if (preserve) finish(true);
      return;
    }
    finish(!preserve && isApplication(current, origin, prepared.serviceId));
  }

  signal.addEventListener("abort", cancel, { once: true });
  target.addEventListener("load", loaded);
  if (preserve) document.body.appendChild(target);
  try {
    if (!stopped) submitPreviewForm({ document, prepared, target: target.name });
  } catch (error) {
    dispose();
    throw error;
  }
}
