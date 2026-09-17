import { createContext, useContext, useLayoutEffect } from "react";
import type { PanelRetention } from "./panel-retention";

export const PanelRetentionContext = createContext<{
  retention: PanelRetention;
  tabId: string;
} | null>(null);

export function useRetainPanel(retain: boolean) {
  const panel = useContext(PanelRetentionContext);
  useLayoutEffect(() => {
    if (retain && panel) return panel.retention.retain(panel.tabId);
  }, [panel, retain]);
}
