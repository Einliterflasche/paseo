import { useContext, useLayoutEffect, useRef } from "react";
import { PreviewRuntimeContext } from "./preview-host.web";

interface ServiceThumbnailProps {
  serverId: string;
  serviceId: string;
}

const thumbnailStyle = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  pointerEvents: "none",
} as const;

export function ServiceThumbnail({ serverId, serviceId }: ServiceThumbnailProps) {
  const runtime = useContext(PreviewRuntimeContext);
  const anchor = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = anchor.current;
    if (!runtime || !element) return;
    const owner = runtime;
    const host = element;
    let thumbnail: ReturnType<typeof runtime.createThumbnail> | null = null;

    function update(visible: boolean) {
      if (visible && !thumbnail) {
        thumbnail = owner.createThumbnail({ serverId, serviceId, anchor: host });
      } else if (!visible && thumbnail) {
        thumbnail.close();
        thumbnail = null;
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => update(Boolean(entry?.isIntersecting) && !document.hidden),
      { rootMargin: "80px" },
    );
    function visibilityChanged() {
      if (document.hidden) update(false);
      else {
        observer.unobserve(host);
        observer.observe(host);
      }
    }
    observer.observe(host);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      observer.disconnect();
      thumbnail?.close();
    };
  }, [runtime, serverId, serviceId]);

  return <div ref={anchor} style={thumbnailStyle} data-testid="service-preview-thumbnail" />;
}
