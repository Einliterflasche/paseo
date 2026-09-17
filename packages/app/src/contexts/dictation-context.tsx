import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createDictationSession, type DictationSession } from "@/dictation/session";
import { useDictationAudioSource } from "@/hooks/use-dictation-audio-source";
import type { MicrophoneCoordinator } from "@/voice/microphone";
import { createDeferredCleanup } from "@/dictation/deferred-cleanup";

interface DictationContextValue {
  session: DictationSession;
  microphone: MicrophoneCoordinator;
}

const DictationContext = createContext<DictationContextValue | null>(null);

export function useDictationContext() {
  const context = useContext(DictationContext);
  if (!context) throw new Error("useDictation must be used within VoiceProvider");
  return context;
}

interface DictationProviderProps {
  children: ReactNode;
  microphone: MicrophoneCoordinator;
}

export function DictationProvider({ children, microphone }: DictationProviderProps) {
  const sessionRef = useRef<DictationSession | null>(null);
  const audio = useDictationAudioSource({
    onPcmSegment: (pcm) => sessionRef.current?.handlePcmSegment(pcm),
    onError: (error) => sessionRef.current?.handleError(error),
    onInterruption: () => {
      void sessionRef.current?.handleInterruption();
    },
  });
  if (!sessionRef.current) {
    sessionRef.current = createDictationSession({ audio, microphone });
  }
  const session = sessionRef.current;
  const context = useMemo(() => ({ session, microphone }), [session, microphone]);
  useEffect(() => {
    session.handleVolume(audio.volume);
  }, [session, audio.volume]);
  const attach = useMemo(
    () =>
      createDeferredCleanup(() => {
        // React may replay effect setup after cleanup without unmounting the tree.
        // Targets invalidate synchronously; release the audio source only once the
        // provider really leaves, after any pending permission prompt has settled.
        void session
          .dispose()
          .then(audio.dispose)
          .catch((error) => {
            console.error("[DictationProvider] Failed to dispose dictation", error);
          });
      }, queueMicrotask),
    [session, audio.dispose],
  );
  useEffect(attach, [attach]);

  return <DictationContext.Provider value={context}>{children}</DictationContext.Provider>;
}
