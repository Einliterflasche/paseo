import { Redirect, useNavigation } from "expo-router";
import { StackActions, useIsFocused } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHosts } from "@/runtime/host-runtime";
import { ServiceCatalogView } from "@/services/catalog-view";
import { servicesCatalogEnabled } from "@/services/feature";

export default function ServicesRoute() {
  const { t } = useTranslation();
  const active = useIsFocused();
  const serverId = useHostRouteServerId();
  const hosts = useHosts();
  const rootNavigation = useNavigation("/");
  const selectHost = useCallback(
    (id: string) => {
      if (id === serverId) return;
      // Replace the host boundary, which owns serverId, along with its child.
      // Replacing only the leaf retains the previous host context; navigating
      // to another host can carry the previous host's nested navigation state.
      rootNavigation.dispatch(
        StackActions.replace("h/[serverId]", {
          serverId: id,
          screen: "services",
          params: { serverId: id },
        }),
      );
    },
    [rootNavigation, serverId],
  );
  const hostFilter = useMemo(
    () =>
      serverId ? (
        <HostFilter
          hosts={hosts}
          selectedHost={serverId}
          onSelectHost={selectHost}
          includeAllHost={false}
        />
      ) : null,
    [hosts, serverId, selectHost],
  );
  if (!servicesCatalogEnabled || !serverId) return <Redirect href="/sessions" />;
  return (
    <View style={styles.container}>
      <MenuHeader title={t("services.title")} rightContent={hostFilter} />
      <ServiceCatalogView key={serverId} serverId={serverId} active={active} />
    </View>
  );
}

const styles = StyleSheet.create({ container: { flex: 1, minHeight: 0 } });
