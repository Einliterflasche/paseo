import { WEB_SURFACE_PLANE, hasActiveWebOverlay } from "@/lib/overlay-root";
import type { PreviewDocument, PreviewTabLifetime } from "./preview-owner";

export interface PreviewPlacement {
  anchor: HTMLElement;
  active: boolean;
  blocked: boolean;
  focus(): void;
}

export interface PreviewSurfaceDocument extends PreviewDocument<PreviewPlacement> {
  readonly frame: HTMLIFrameElement;
}

interface Surface {
  container: HTMLDivElement;
  frame: HTMLIFrameElement;
  placement: PreviewPlacement | null;
  hasDocument: boolean;
  removeFocusListeners(): void;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function hide(surface: Surface) {
  surface.container.hidden = true;
  surface.container.inert = true;
  surface.container.setAttribute("aria-hidden", "true");
  surface.frame.tabIndex = -1;
}

function clipToAncestors(anchor: HTMLElement, view: Window): Bounds {
  const bounds = anchor.getBoundingClientRect();
  const clip = {
    left: Math.max(0, bounds.left),
    top: Math.max(0, bounds.top),
    right: Math.min(view.innerWidth, bounds.right),
    bottom: Math.min(view.innerHeight, bounds.bottom),
  };
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (style.overflowX !== "visible") {
      clip.left = Math.max(clip.left, rect.left);
      clip.right = Math.min(clip.right, rect.right);
    }
    if (style.overflowY !== "visible") {
      clip.top = Math.max(clip.top, rect.top);
      clip.bottom = Math.min(clip.bottom, rect.bottom);
    }
  }
  return clip;
}

function subtractBounds(bounds: Bounds, obstacle: Bounds): Bounds[] {
  const left = Math.max(bounds.left, obstacle.left);
  const right = Math.min(bounds.right, obstacle.right);
  const top = Math.max(bounds.top, obstacle.top);
  const bottom = Math.min(bounds.bottom, obstacle.bottom);
  if (left >= right || top >= bottom) return [bounds];
  return [
    { ...bounds, bottom: top },
    { ...bounds, top: bottom },
    { left: bounds.left, right: left, top, bottom },
    { left: right, right: bounds.right, top, bottom },
  ].filter((region) => region.left < region.right && region.top < region.bottom);
}

function interactionClip(bounds: Bounds, document: Document): string {
  let regions = [bounds];
  for (const handle of document.querySelectorAll('[data-surface-occlusion="resize"]')) {
    const obstacle = handle.getBoundingClientRect();
    regions = regions.flatMap((region) => subtractBounds(region, obstacle));
  }
  // Disjoint contours also preserve hit testing at overlapping splitter corners.
  const contours = regions.map((region) => {
    const left = region.left - bounds.left;
    const top = region.top - bounds.top;
    const right = region.right - bounds.left;
    const bottom = region.bottom - bounds.top;
    return `M${left},${top}H${right}V${bottom}H${left}Z`;
  });
  return `path("${contours.join(" ")}")`;
}

function hasCompactOverlay(document: Document): boolean {
  for (const panel of document.querySelectorAll('[data-surface-occlusion="compact-panel"]')) {
    const bounds = panel.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) return true;
  }
  return false;
}

function eligiblePlacement(surface: Surface): PreviewPlacement | null {
  const placement = surface.placement;
  if (!placement?.active || placement.blocked || !surface.hasDocument) return null;
  return placement.anchor.isConnected ? placement : null;
}

function present(surface: Surface, view: Window) {
  const placement = eligiblePlacement(surface);
  if (!placement || hasCompactOverlay(placement.anchor.ownerDocument)) {
    hide(surface);
    return;
  }
  const anchor = placement.anchor;
  const bounds = anchor.getBoundingClientRect();
  const clip = clipToAncestors(anchor, view);
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    clip.right <= clip.left ||
    clip.bottom <= clip.top
  ) {
    hide(surface);
    return;
  }
  const style = surface.container.style;
  style.left = `${clip.left}px`;
  style.top = `${clip.top}px`;
  style.width = `${clip.right - clip.left}px`;
  style.height = `${clip.bottom - clip.top}px`;
  style.clipPath = interactionClip(clip, anchor.ownerDocument);
  surface.frame.style.left = `${bounds.left - clip.left}px`;
  surface.frame.style.top = `${bounds.top - clip.top}px`;
  surface.frame.style.width = `${bounds.width}px`;
  surface.frame.style.height = `${bounds.height}px`;
  surface.container.hidden = false;
  surface.container.inert = false;
  surface.container.setAttribute("aria-hidden", "false");
  surface.frame.tabIndex = 0;
}

/** Owns permanent DOM parents. Navigation remains the Open coordinator's responsibility. */
export function createPreviewSurfaceHost(ownerDocument: Document) {
  const view = ownerDocument.defaultView;
  if (!view) throw new Error("Preview surfaces require a browser document");
  const host = ownerDocument.createElement("div");
  host.dataset.testid = "service-preview-resident-host";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: String(WEB_SURFACE_PLANE.browser),
  });
  ownerDocument.body.appendChild(host);
  const surfaces = new Set<Surface>();
  let scheduled: number | null = null;
  let closed = false;

  function update() {
    scheduled = null;
    if (closed) return;
    for (const surface of surfaces) present(surface, view!);
    // CSS transitions move anchors without resizing them. Observe their actual
    // animation lifetime instead of polling settled or hidden documents.
    for (const surface of surfaces) {
      const placement = eligiblePlacement(surface);
      if (!placement) continue;
      for (
        let anchor: HTMLElement | null = placement.anchor;
        anchor;
        anchor = anchor.parentElement
      ) {
        if (anchor.getAnimations().some((animation) => animation.playState === "running")) {
          schedule();
          return;
        }
      }
    }
  }
  function schedule() {
    if (!closed && scheduled === null) scheduled = view!.requestAnimationFrame(update);
  }
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => !host.contains(record.target))) schedule();
  });
  mutations.observe(ownerDocument.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "inert", "aria-hidden"],
  });
  ownerDocument.addEventListener("scroll", schedule, true);
  ownerDocument.addEventListener("transitionrun", schedule, true);
  ownerDocument.addEventListener("animationstart", schedule, true);
  view.addEventListener("resize", schedule);

  function observeAnchors() {
    resize.disconnect();
    for (const surface of surfaces) {
      const anchor = surface.placement?.anchor;
      if (anchor) resize.observe(anchor);
    }
  }

  function focus(surface: Surface) {
    if (!surface.container.hidden && !hasActiveWebOverlay()) surface.placement?.focus();
  }
  function onWindowBlur() {
    queueMicrotask(() => {
      for (const surface of surfaces) {
        if (ownerDocument.activeElement === surface.frame) focus(surface);
      }
    });
  }
  view.addEventListener("blur", onWindowBlur);

  return {
    create(lifetime: PreviewTabLifetime): PreviewSurfaceDocument {
      if (closed) throw new Error("Preview surface host is closed");
      const container = ownerDocument.createElement("div");
      // oxlint-disable-next-line react/iframe-missing-sandbox -- Set before DOM attachment below.
      const frame = ownerDocument.createElement("iframe");
      const surface: Surface = {
        container,
        frame,
        placement: null,
        hasDocument: false,
        removeFocusListeners() {},
      };
      container.dataset.testid = "service-preview-surface";
      frame.dataset.testid = "service-preview-frame";
      frame.dataset.serviceId = lifetime.identity.serviceId;
      frame.dataset.workspaceKey = lifetime.identity.workspaceKey;
      frame.dataset.tabId = lifetime.identity.tabId;
      frame.title = lifetime.identity.serviceId;
      frame.name = `paseo-service-preview-${crypto.randomUUID()}`;
      frame.setAttribute(
        "sandbox",
        "allow-forms allow-scripts allow-same-origin allow-popups allow-modals allow-downloads",
      );
      frame.referrerPolicy = "no-referrer";
      Object.assign(container.style, {
        position: "fixed",
        overflow: "hidden",
        pointerEvents: "auto",
      });
      Object.assign(frame.style, { position: "absolute", border: "0" });
      hide(surface);
      container.appendChild(frame);
      host.appendChild(container);
      surfaces.add(surface);
      const focusPane = () => focus(surface);
      function loaded() {
        surface.removeFocusListeners();
        const content = frame.contentDocument;
        surface.hasDocument = content?.URL !== "about:blank";
        if (content) {
          content.addEventListener("pointerdown", focusPane, true);
          content.addEventListener("focusin", focusPane, true);
          surface.removeFocusListeners = () => {
            content.removeEventListener("pointerdown", focusPane, true);
            content.removeEventListener("focusin", focusPane, true);
          };
        }
        present(surface, view!);
        schedule();
      }
      frame.addEventListener("load", loaded);
      frame.addEventListener("focus", focusPane);
      return {
        frame,
        place(placement) {
          surface.placement = placement;
          observeAnchors();
          present(surface, view!);
          schedule();
        },
        close() {
          surface.placement = null;
          surface.removeFocusListeners();
          frame.removeEventListener("load", loaded);
          frame.removeEventListener("focus", focusPane);
          surfaces.delete(surface);
          container.remove();
          observeAnchors();
        },
      };
    },
    close() {
      closed = true;
      if (scheduled !== null) view.cancelAnimationFrame(scheduled);
      resize.disconnect();
      mutations.disconnect();
      ownerDocument.removeEventListener("scroll", schedule, true);
      ownerDocument.removeEventListener("transitionrun", schedule, true);
      ownerDocument.removeEventListener("animationstart", schedule, true);
      view.removeEventListener("resize", schedule);
      view.removeEventListener("blur", onWindowBlur);
      host.remove();
    },
  };
}
