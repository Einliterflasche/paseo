import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useDndContext } from "@dnd-kit/core";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { createPreviewRuntime } from "./preview-runtime.web";
import { type createPreviewCoordinator, type PreviewOpenState } from "./preview-coordinator";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { servicesCatalogEnabled } from "./feature";
import { useToast } from "@/contexts/toast-context";
import { useTranslation } from "react-i18next";

type PreviewRuntime = ReturnType<typeof createPreviewRuntime>;
const PreviewRuntimeContext = createContext<PreviewRuntime | null>(null);

function ResidentHost({ children }: { children: ReactNode }) {
  const toast = useToast();
  const { t } = useTranslation();
  const notice = useRef(() => {});
  useLayoutEffect(() => {
    notice.current = () =>
      toast.show(t("services.previewCloseError"), {
        variant: "warning",
        durationMs: null,
        testID: "service-preview-close-error",
      });
  }, [toast, t]);
  const [runtime, setRuntime] = useState<PreviewRuntime | null>(null);
  useLayoutEffect(() => {
    const next = createPreviewRuntime({ document, onCloseFailure: () => notice.current() });
    setRuntime(next);
    return () => {
      next.close();
    };
  }, []);
  return <PreviewRuntimeContext value={runtime}>{children}</PreviewRuntimeContext>;
}

export function ServicePreviewHost({ children }: { children: ReactNode }) {
  return servicesCatalogEnabled ? <ResidentHost>{children}</ResidentHost> : children;
}

const anchorStyle = { display: "flex", flex: 1, minHeight: 0, minWidth: 0 } as const;
const noSubscription = () => () => {};

export function ServicePreviewAnchor({ children }: { children: ReactNode }) {
  const owner = useContext(PreviewRuntimeContext)?.owner;
  const anchor = useRef<HTMLDivElement | null>(null);
  const { serverId, workspaceId, tabId, target } = usePaneContext();
  const { isWorkspaceFocused, focusPane } = usePaneFocus();
  const retained = useRetainedPanelActive();
  const drag = useDndContext();
  const compact = useIsCompactFormFactor();
  const mobileTarget = usePanelStore((state) => state.mobilePanel.target);
  const centerSettled = useIsMobilePanelActive("agent");
  const compactOverlay = compact && (mobileTarget !== "agent" || !centerSettled);
  const active = retained && isWorkspaceFocused;
  const blocked = drag.active !== null || compactOverlay;
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const serviceId = target.kind === "service_preview" ? target.serviceId : null;
  const getGeneration = useCallback(() => {
    if (!owner || !workspaceKey || !serviceId) return null;
    return owner.getGeneration({ workspaceKey, tabId, serviceId });
  }, [owner, workspaceKey, tabId, serviceId]);
  const generation = useSyncExternalStore(
    owner?.subscribe ?? noSubscription,
    getGeneration,
    getGeneration,
  );
  useLayoutEffect(() => {
    if (!owner || !workspaceKey || !serviceId || !generation || !anchor.current) return;
    const placement = owner.place({
      identity: { workspaceKey, tabId, serviceId },
      generation,
      placement: {
        anchor: anchor.current,
        active,
        blocked,
        focus: focusPane,
      },
    });
    return () => placement?.release();
  }, [owner, workspaceKey, tabId, serviceId, generation, active, blocked, focusPane]);
  return (
    <div ref={anchor} style={anchorStyle} data-testid="service-preview-anchor">
      {children}
    </div>
  );
}

const idle: PreviewOpenState = { status: "idle" };
const getIdle = () => idle;

export function useServicePreview(mode: "iframe" | "tab" = "iframe") {
  const runtime = useContext(PreviewRuntimeContext);
  const { serverId, workspaceId, tabId, target } = usePaneContext();
  const serviceId = target.kind === "service_preview" ? target.serviceId : null;
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const generation = useSyncExternalStore(
    runtime?.owner.subscribe ?? noSubscription,
    () =>
      runtime && workspaceKey && serviceId
        ? runtime.owner.getGeneration({ workspaceKey, tabId, serviceId })
        : null,
    () => null,
  );
  const [coordinator, setCoordinator] = useState<ReturnType<
    typeof createPreviewCoordinator
  > | null>(null);
  useLayoutEffect(() => {
    if (runtime && serviceId && generation && mode === "tab") {
      const lease = runtime.acquireBrowser({ serverId, serviceId });
      setCoordinator(lease?.coordinator ?? null);
      return lease?.release;
    }
    setCoordinator(
      runtime && serviceId && generation
        ? runtime.get({ serverId, workspaceId, tabId, serviceId })
        : null,
    );
  }, [runtime, serverId, workspaceId, tabId, serviceId, generation, mode]);
  const state = useSyncExternalStore(
    coordinator?.subscribe ?? noSubscription,
    coordinator?.getSnapshot ?? getIdle,
    getIdle,
  );
  return { coordinator, state };
}

export function useOpenServicePreview() {
  const runtime = useContext(PreviewRuntimeContext);
  const open = useCallback(
    (input: { serverId: string; workspaceId: string; serviceId: string }) => {
      if (!runtime) return;
      const target = { kind: "service_preview" as const, serviceId: input.serviceId };
      navigateToWorkspace({ ...input, target });
      const coordinator = runtime.get({
        ...input,
        tabId: buildDeterministicWorkspaceTabId(target),
      });
      const status = coordinator?.getSnapshot().status;
      if (status === "idle" || status === "error") void coordinator?.open();
    },
    [runtime],
  );
  return runtime ? open : null;
}

/** Root-owned so catalog filtering or grid changes do not revoke a browser tab. */
export function useBrowserServicePreview({
  serverId,
  serviceId,
}: {
  serverId: string;
  serviceId: string;
}) {
  const runtime = useContext(PreviewRuntimeContext);
  const [coordinator, setCoordinator] = useState<ReturnType<
    typeof createPreviewCoordinator
  > | null>(null);
  useLayoutEffect(() => {
    const lease = runtime?.acquireBrowser({ serverId, serviceId });
    setCoordinator(lease?.coordinator ?? null);
    return lease?.release;
  }, [runtime, serverId, serviceId]);
  const state = useSyncExternalStore(
    coordinator?.subscribe ?? noSubscription,
    coordinator?.getSnapshot ?? getIdle,
    getIdle,
  );
  return { coordinator, state };
}

/** Resolves preview actions for a tab-strip item without depending on pane focus. */
export function useServicePreviewForTab(
  context: { serverId: string; workspaceId: string; tabId: string; serviceId: string } | null,
  mode: "iframe" | "tab",
) {
  const runtime = useContext(PreviewRuntimeContext);
  const workspaceKey = context ? buildWorkspaceTabPersistenceKey(context) : null;
  const generation = useSyncExternalStore(
    runtime?.owner.subscribe ?? noSubscription,
    () =>
      runtime && context && workspaceKey
        ? runtime.owner.getGeneration({
            workspaceKey,
            tabId: context.tabId,
            serviceId: context.serviceId,
          })
        : null,
    () => null,
  );
  const [coordinator, setCoordinator] = useState<ReturnType<
    typeof createPreviewCoordinator
  > | null>(null);
  useLayoutEffect(() => {
    if (!runtime || !context || !generation) {
      setCoordinator(null);
      return;
    }
    if (mode === "tab") {
      const lease = runtime.acquireBrowser(context);
      setCoordinator(lease?.coordinator ?? null);
      return lease?.release;
    }
    setCoordinator(runtime.get(context));
  }, [runtime, context, generation, mode]);
  const state = useSyncExternalStore(
    coordinator?.subscribe ?? noSubscription,
    coordinator?.getSnapshot ?? getIdle,
    getIdle,
  );
  return { coordinator, state };
}
