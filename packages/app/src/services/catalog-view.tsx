import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { buildServiceCatalog, type ServiceCatalogEntry } from "./catalog";
import { ServiceGallery, type ServiceAction } from "./gallery";
import { useServicesPreferences } from "./preferences";
import { useOpenServicePreview } from "./preview-host";
import { buildExternalCatalog, type ExternalCatalogEntry } from "./external-catalog";
import { ServiceRegistrationSheet } from "./registration-sheet";
import { ManagedPreviewSheet } from "./managed-sheet";

import {
  CatalogChangedError,
  catalogDirectoryPresentation,
  catalogMutationPolicy,
  createCatalogOperations,
} from "./catalog-state";

export function ServiceCatalogView({
  serverId,
  workspaceId,
  active = true,
}: {
  serverId: string;
  workspaceId?: string;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const [registering, setRegistering] = useState(false);
  const [managedEntry, setManagedEntry] = useState<ServiceCatalogEntry | null>(null);
  const hideManaged = useCallback(() => setManagedEntry(null), []);
  const showRegistration = useCallback(() => setRegistering(true), []);
  const hideRegistration = useCallback(() => setRegistering(false), []);
  const preferences = useServicesPreferences({ serverId, workspaceId });
  const openPreview = useOpenServicePreview();
  const previews = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.servicePreviews,
  );
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const hydrated = useSessionStore(
    (state) => state.sessions[serverId]?.hasHydratedWorkspaces === true,
  );
  const runtime = useHostRuntimeSnapshot(serverId);
  const hasRuntime = runtime !== null;
  useEffect(() => {
    if (!active || !hasRuntime) return;
    return getHostRuntimeStore().acquireDirectoryDemand(serverId);
  }, [active, hasRuntime, serverId]);
  const {
    ready,
    online,
    loading,
    error: directoryFailure,
    unavailable,
  } = catalogDirectoryPresentation(runtime, hydrated);
  let directoryError: string | undefined;
  if (directoryFailure !== undefined)
    directoryError = `${t("services.refreshError")} ${directoryFailure}`;
  if (unavailable) directoryError = t("services.catalogUnavailable");
  const canManage = useHostFeature(serverId, "workspaceScriptManagement");
  const services = useMemo(
    () =>
      [
        ...buildServiceCatalog({ serverId, workspaces: workspaces?.values() ?? [], previews }),
        ...buildExternalCatalog({ serverId, workspaces: workspaces?.values() ?? [], previews }),
      ].filter((entry) => !workspaceId || entry.workspaceId === workspaceId),
    [serverId, workspaces, workspaceId, previews],
  );
  const currentManagedEntry = services.find(
    (entry): entry is ServiceCatalogEntry => !("kind" in entry) && entry.id === managedEntry?.id,
  );
  const operations = useMemo(
    () =>
      createCatalogOperations({
        getSnapshot: () => getHostRuntimeStore().getSnapshot(serverId),
        getWorkspace: (id) => useSessionStore.getState().sessions[serverId]?.workspaces.get(id),
        refresh: () => getHostRuntimeStore().refreshWorkspaceDirectory({ serverId }),
      }),
    [serverId],
  );
  const inFlight = useRef(false);
  const refresh = useMutation({
    ...catalogMutationPolicy,
    mutationFn: operations.refresh,
    onSuccess: () => mutation.reset(),
  });
  const mutation = useMutation({
    ...catalogMutationPolicy,
    mutationFn: ({ entry, action }: { entry: ServiceCatalogEntry; action: ServiceAction }) =>
      operations.runAction({ rendered: runtime, active, canManage }, entry, action),
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const message = (error: Error) =>
    error instanceof CatalogChangedError ? t("services.changed") : error.message;
  const { mutate } = mutation;
  const onAction = useCallback(
    (entry: ServiceCatalogEntry, action: ServiceAction) => {
      if (inFlight.current) return;
      inFlight.current = true;
      mutate({ entry, action });
    },
    [mutate],
  );
  const onLogs = useCallback(
    (entry: ServiceCatalogEntry) => {
      if (entry.terminalId)
        navigateToWorkspace({
          serverId,
          workspaceId: entry.workspaceId,
          target: { kind: "terminal", terminalId: entry.terminalId },
        });
    },
    [serverId],
  );
  const onOpen = useCallback(
    (entry: ServiceCatalogEntry | ExternalCatalogEntry) => {
      if ("kind" in entry && !entry.available) return;
      const serviceId = "kind" in entry ? entry.serviceId : entry.previewServiceId;
      if (active && ready && serviceId && entry.workspaceId && openPreview) {
        openPreview({
          serverId,
          workspaceId: entry.workspaceId,
          serviceId,
        });
      }
    },
    [active, ready, openPreview, serverId],
  );
  return (
    <>
      <ServiceGallery
        serverId={serverId}
        services={services}
        mode={preferences.view}
        onModeChange={preferences.setView}
        modePending={preferences.pending}
        preferenceError={preferences.error}
        onPreferenceReload={preferences.reload}
        online={online}
        stale={!ready}
        loading={loading}
        canManage={canManage}
        actionsBlocked={!active || !ready || mutation.isError || refresh.isPending}
        pendingId={mutation.isPending ? mutation.variables.entry.id : undefined}
        error={
          (refresh.error ? message(refresh.error) : undefined) ??
          (mutation.error
            ? `${t("services.actionError")} ${message(mutation.error)}`
            : directoryError)
        }
        onRefresh={refresh.mutate}
        refreshing={refresh.isPending}
        onAction={onAction}
        onLogs={onLogs}
        onOpen={openPreview ? onOpen : undefined}
        onRegister={previews?.externalRegistration === 1 ? showRegistration : undefined}
        onManagePreview={previews?.managedRegistration === 1 ? setManagedEntry : undefined}
      />
      <ManagedPreviewSheet
        serverId={serverId}
        entry={managedEntry}
        currentEntry={currentManagedEntry}
        eligible={active && ready}
        onClose={hideManaged}
      />
      <ServiceRegistrationSheet
        visible={registering}
        onClose={hideRegistration}
        serverId={serverId}
        workspaceId={workspaceId}
        workspaces={Array.from(workspaces?.values() ?? [])}
      />
    </>
  );
}
