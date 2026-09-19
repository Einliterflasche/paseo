import { PanelsTopLeft } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { definePanel } from "@/panels/panel-registry";
import { ServiceCatalogView } from "./catalog-view";
import { servicesCatalogEnabled } from "./feature";

function ServicesPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const active = useRetainedPanelActive();
  return servicesCatalogEnabled ? (
    <ServiceCatalogView
      key={`${serverId}:${workspaceId}`}
      serverId={serverId}
      workspaceId={workspaceId}
      active={active}
    />
  ) : null;
}

export const servicesPanelRegistration = definePanel("services", {
  component: ServicesPanel,
  presentation: {
    label: (t) => t("services.title"),
    subtitle: (t) => t("services.description"),
    tooltip: (t) => t("services.title"),
    icon: withUnistyles(PanelsTopLeft),
  },
});
