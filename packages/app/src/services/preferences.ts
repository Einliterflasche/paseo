import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery, useReplicaQuery } from "@/data/query";
import {
  createServicesPreferencesStore,
  DEFAULT_PREFERENCES,
  servicesPreferenceOutcomeKey,
  servicesPreferencesKey,
  type ServicesPreferenceScope,
  type ServicesPreferenceWriteOutcome,
} from "./preferences-state";

export { servicesPreferencesKey, type ServicesViewMode } from "./preferences-state";

const preferences = createServicesPreferencesStore(AsyncStorage);

export function useServicesPreferences(scope: ServicesPreferenceScope) {
  const client = useQueryClient();
  const query = useFetchQuery(preferences.readOptions(scope));
  const mutation = useMutation(preferences.writeOptions(scope, client));
  const outcome = useReplicaQuery<ServicesPreferenceWriteOutcome>({
    queryKey: servicesPreferenceOutcomeKey(scope),
    pushEvent: "services.preferences.write",
  });
  const saving = useIsMutating({ mutationKey: [servicesPreferencesKey(scope)], exact: true }) > 0;
  let error: "load" | "save" | null = null;
  if (query.isError) error = "load";
  if (outcome.data === "failed") error = "save";
  const { refetch } = query;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  return {
    view: query.data?.view ?? DEFAULT_PREFERENCES.view,
    pending: query.isFetching || saving,
    error,
    setView: mutation.mutate,
    reload,
  };
}
