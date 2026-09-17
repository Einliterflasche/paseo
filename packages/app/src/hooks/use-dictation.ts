import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useDictationContext } from "@/contexts/dictation-context";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useRetainPanel } from "@/panels/panel-retention-context";
import { IDLE_DICTATION } from "@/dictation/session";
import type { UseDictationOptions, UseDictationResult } from "./use-dictation.shared";

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const { session, microphone } = useDictationContext();
  const [owner] = useState(() => Symbol("dictation target"));
  const panelActive = useRetainedPanelActive();
  const enabled = options.enabled !== false;
  const getTargetSnapshot = useCallback(() => {
    const snapshot = session.getSnapshot();
    return snapshot.owner === owner ? snapshot : IDLE_DICTATION;
  }, [session, owner]);
  const snapshot = useSyncExternalStore(session.subscribe, getTargetSnapshot, getTargetSnapshot);
  useRetainPanel(snapshot.busy || snapshot.status === "failed");
  const microphoneOwner = useSyncExternalStore(
    microphone.subscribe,
    microphone.getSnapshot,
    microphone.getSnapshot,
  );

  useLayoutEffect(() => {
    session.updateTarget(owner, {
      ...options,
      enabled,
      // Retained tabs keep their existing recording and destination. Only the
      // visible panel may start a new recording through the global shortcut.
      canStart: () => panelActive && options.canStart?.() !== false,
    });
  });
  useLayoutEffect(() => () => session.releaseTarget(owner), [session, owner]);

  const isSessionActive = useCallback(
    () => session.getSnapshot().owner === owner && session.getSnapshot().busy,
    [session, owner],
  );
  const isRecordingActive = useCallback(
    () => session.getSnapshot().owner === owner && session.getSnapshot().isRecording,
    [session, owner],
  );
  const startDictation = useCallback(() => session.start(owner), [session, owner]);
  const cancelDictation = useCallback(() => session.cancel(owner), [session, owner]);
  const confirmDictation = useCallback(() => session.confirm(owner), [session, owner]);
  const retryFailedDictation = useCallback(() => session.retry(owner), [session, owner]);
  const reset = useCallback(() => session.reset(owner), [session, owner]);

  return {
    ...snapshot,
    volume: snapshot.isRecording ? snapshot.volume : 0,
    busyElsewhere: microphoneOwner !== null && !snapshot.busy,
    isSessionActive,
    isRecordingActive,
    startDictation,
    cancelDictation,
    confirmDictation,
    retryFailedDictation,
    discardFailedDictation: reset,
    reset,
  };
}

export type {
  DictationStatus,
  UseDictationOptions,
  UseDictationResult,
} from "./use-dictation.shared";
