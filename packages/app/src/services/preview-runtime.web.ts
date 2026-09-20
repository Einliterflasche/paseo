import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  createPreviewTabOwner,
  type PreviewTabIdentity,
  type PreviewTabLifetime,
} from "./preview-owner";
import { createPreviewSurfaceHost, type PreviewSurfaceDocument } from "./preview-surfaces.web";
import { createPreviewCoordinator } from "./preview-coordinator";
import { createPreviewBrowserOwner } from "./preview-browser-owner";
import { browserPreviewProfile } from "./preview-browser-profile.web";
import { submitPreviewForm } from "./preview-form.web";
import { openPreviewDocument } from "./preview-navigation.web";
import { reserveStandalonePreview } from "./preview-standalone-navigation.web";
import { createPreviewThumbnailFrame } from "./preview-thumbnail-frame.web";

export interface PreviewWorkspaceContext {
  serverId: string;
  workspaceId: string;
  tabId: string;
  serviceId: string;
}

interface Resident {
  lifetime: PreviewTabLifetime;
  surface: PreviewSurfaceDocument;
  coordinators: Map<"iframe" | "tab", ReturnType<typeof createPreviewCoordinator>>;
}

interface PreviewRuntimeOptions {
  document: Document;
  onCloseFailure(): void;
}

export function createPreviewRuntime({ document, onCloseFailure }: PreviewRuntimeOptions) {
  const surfaces = createPreviewSurfaceHost(document);
  const residents = new Map<AbortSignal, Resident>();
  const browserPreviews = createPreviewBrowserOwner({
    create: (identity, lifetime) => initializeCoordinator({ ...identity, lifetime, mode: "tab" }),
    onCloseFailure,
  });
  const owner = createPreviewTabOwner({
    layouts: useWorkspaceLayoutStore,
    create(lifetime) {
      const surface = surfaces.create(lifetime);
      const record: Resident = {
        lifetime,
        surface,
        coordinators: new Map(),
      };
      residents.set(lifetime.signal, record);
      return {
        place: surface.place,
        close() {
          for (const coordinator of record.coordinators.values()) coordinator.close();
          residents.delete(lifetime.signal);
          surface.close();
        },
      };
    },
  });

  function get(context: PreviewWorkspaceContext) {
    const workspaceKey = buildWorkspaceTabPersistenceKey(context);
    if (!workspaceKey) return null;
    const identity: PreviewTabIdentity = {
      workspaceKey,
      tabId: context.tabId,
      serviceId: context.serviceId,
    };
    const generation = owner.getGeneration(identity);
    const record = generation ? residents.get(generation) : null;
    if (!record) return null;
    const mode = "iframe";
    const existing = record.coordinators.get(mode);
    if (existing) return existing;
    const coordinator = initializeCoordinator({
      ...context,
      mode,
      lifetime: record.lifetime.signal,
      record,
    });
    record.coordinators.set(mode, coordinator);
    return coordinator;
  }

  function initializeCoordinator({
    serverId,
    serviceId,
    mode,
    lifetime,
    record,
    frame: suppliedFrame,
  }: {
    serverId: string;
    serviceId: string;
    mode: "iframe" | "tab";
    lifetime: AbortSignal;
    record?: Resident;
    frame?: HTMLIFrameElement;
  }) {
    const host = getHostRuntimeStore();
    const frame = suppliedFrame ?? record?.surface.frame;
    const coordinator: ReturnType<typeof createPreviewCoordinator> = createPreviewCoordinator({
      serviceId,
      mode,
      lifetime,
      profile: browserPreviewProfile(serverId),
      createId: () => crypto.randomUUID(),
      onCloseFailure,
      getSource() {
        const snapshot = host.getSnapshot(serverId);
        const info = snapshot?.client?.getLastServerInfoMessage()?.servicePreviews;
        const service = info?.services.find((candidate) => candidate.serviceId === serviceId);
        if (
          !snapshot?.client ||
          snapshot.connectionStatus !== "online" ||
          !info ||
          info.version !== 1 ||
          info.origin !== document.location.origin ||
          !service?.available
        )
          return null;
        return {
          client: snapshot.client,
          clientGeneration: snapshot.clientGeneration,
          connectionEpoch: snapshot.connectionEpoch,
          routeRevision: service.revision,
        };
      },
      subscribeSource(listener) {
        const stopHost = host.subscribe(serverId, listener);
        const stopSession = useSessionStore.subscribe(listener);
        return () => {
          stopHost();
          stopSession();
        };
      },
      reserveLaunch:
        mode === "tab"
          ? ({ attemptId, closed }) =>
              reserveStandalonePreview({
                document,
                name: `paseo-preview-${attemptId}`,
                closed,
              })
          : undefined,
      launch(prepared, options) {
        if (mode === "tab") {
          submitPreviewForm({ document, prepared, target: "_blank" });
          return;
        }
        if (!frame) throw new Error("Missing embedded preview document");
        openPreviewDocument({
          ...options,
          document,
          frame,
          prepared,
          completed: (success) => coordinator.navigationCompleted(prepared.attemptId, success),
        });
      },
    });
    return coordinator;
  }

  return {
    owner,
    get,
    acquireBrowser: browserPreviews.acquire,
    createThumbnail({
      serverId,
      serviceId,
      anchor,
    }: {
      serverId: string;
      serviceId: string;
      anchor: HTMLElement;
    }) {
      const lifetime = new AbortController();
      const thumbnail = createPreviewThumbnailFrame({ document, anchor, serviceId });
      const coordinator = initializeCoordinator({
        serverId,
        serviceId,
        mode: "iframe",
        lifetime: lifetime.signal,
        frame: thumbnail.frame,
      });
      void coordinator.open();
      return {
        close() {
          coordinator.close();
          lifetime.abort();
          thumbnail.close();
        },
      };
    },
    close() {
      browserPreviews.close();
      owner.close();
      surfaces.close();
    },
  };
}
