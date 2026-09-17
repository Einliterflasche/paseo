import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPanelRetention, type PanelRetention } from "@/panels/panel-retention";
import { PanelRetentionContext } from "@/panels/panel-retention-context";
import { RetainedPanel } from "@/components/retained-panel";
import { useModifiedPanelTabIds } from "@/panels/panel-instance-attributes";
import {
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { RenderProfile } from "@/utils/render-profiler";

interface WorkspacePanelHostProps {
  paneId: string;
  tabs: WorkspaceTabDescriptor[];
  activeTabId: string | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  onFocusPane?: (paneId: string) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

interface MountedTabProps {
  retention: PanelRetention;
  tab: WorkspaceTabDescriptor;
  paneId: string;
  visible: boolean;
  interactive: boolean;
  isWorkspaceFocused: boolean;
  onFocusPane?: (paneId: string) => void;
  buildPaneContentModel: WorkspacePanelHostProps["buildPaneContentModel"];
}

const MountedTab = memo(function MountedTab({
  retention,
  tab,
  paneId,
  visible,
  interactive,
  isWorkspaceFocused,
  onFocusPane,
  buildPaneContentModel,
}: MountedTabProps) {
  const content = useMemo(
    () => buildPaneContentModel({ paneId, tab }),
    [buildPaneContentModel, paneId, tab],
  );
  const retentionContext = useMemo(() => ({ retention, tabId: tab.tabId }), [retention, tab.tabId]);
  const handleFocusPane = useCallback(() => onFocusPane?.(paneId), [onFocusPane, paneId]);
  return (
    <RenderProfile id={`DesktopMountedTab:${tab.kind}:${tab.tabId}`}>
      <PanelRetentionContext.Provider value={retentionContext}>
        <RetainedPanel active={visible}>
          <WorkspacePaneContent
            content={content}
            isWorkspaceFocused={isWorkspaceFocused}
            isPaneFocused={interactive}
            onFocusPane={onFocusPane ? handleFocusPane : undefined}
          />
        </RetainedPanel>
      </PanelRetentionContext.Provider>
    </RenderProfile>
  );
});

function useStableTabs(tabs: WorkspaceTabDescriptor[]) {
  const cacheRef = useRef(new Map<string, WorkspaceTabDescriptor>());
  const stableTabs = useMemo(() => {
    const next = new Map<string, WorkspaceTabDescriptor>();
    for (const tab of tabs) {
      const cached = cacheRef.current.get(tab.tabId);
      next.set(
        tab.tabId,
        cached &&
          cached.key === tab.key &&
          cached.kind === tab.kind &&
          cached.state === tab.state &&
          workspaceTabTargetsEqual(cached.target, tab.target)
          ? cached
          : tab,
      );
    }
    return next;
  }, [tabs]);
  useEffect(() => {
    cacheRef.current = stableTabs;
  }, [stableTabs]);
  return stableTabs;
}

/** Mounts panel implementations behind the shared host contract and retains modified tabs and panels with in-flight work. */
export function WorkspacePanelHost({
  paneId,
  tabs,
  activeTabId,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  isPaneFocused,
  onFocusPane,
  buildPaneContentModel,
}: WorkspacePanelHostProps) {
  const tabIds = useMemo(() => tabs.map((tab) => tab.tabId), [tabs]);
  const modifiedTabIds = useModifiedPanelTabIds({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    tabIds,
  });
  const [retention] = useState(createPanelRetention);
  const leasedTabIds = useSyncExternalStore(
    retention.subscribe,
    retention.getSnapshot,
    retention.getSnapshot,
  );
  const retainedTabIds = useMemo(
    () => new Set([...modifiedTabIds, ...leasedTabIds]),
    [modifiedTabIds, leasedTabIds],
  );
  const stableTabs = useStableTabs(tabs);
  const { mountedTabIds } = useMountedTabSet({
    activeTabId,
    allTabIds: tabIds,
    retainedTabIds,
    cap: 3,
  });
  const mountedIds = useMemo(
    () => tabIds.filter((tabId) => mountedTabIds.has(tabId)),
    [mountedTabIds, tabIds],
  );

  return mountedIds.map((tabId) => {
    const tab = stableTabs.get(tabId);
    if (!tab) return null;
    const visible = tabId === activeTabId;
    return (
      <MountedTab
        key={tabId}
        retention={retention}
        tab={tab}
        paneId={paneId}
        visible={visible}
        interactive={isPaneFocused && visible}
        isWorkspaceFocused={isWorkspaceFocused}
        onFocusPane={onFocusPane}
        buildPaneContentModel={buildPaneContentModel}
      />
    );
  });
}
