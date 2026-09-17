import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { DictationStreamSender, type DictationStreamClient } from "./dictation-stream-sender";
import {
  DURATION_TICK_MS,
  PCM_DICTATION_FORMAT,
  toError,
  type UseDictationOptions,
  type UseDictationResult,
} from "@/hooks/use-dictation.shared";
import type { DictationAudioSource } from "@/hooks/use-dictation-audio-source.types";
import { i18n } from "@/i18n/i18next";
import { generateMessageId } from "@/types/stream";
import type { MicrophoneCoordinator } from "@/voice/microphone";

export interface DictationClient extends DictationStreamClient {
  subscribeConnectionStatus: DaemonClient["subscribeConnectionStatus"];
}

export interface DictationTargetOptions extends Omit<UseDictationOptions, "client"> {
  client: DictationClient | null;
}

export interface DictationSnapshot extends Pick<
  UseDictationResult,
  "isRecording" | "isProcessing" | "partialTranscript" | "duration" | "volume" | "error" | "status"
> {
  owner: symbol | null;
  busy: boolean;
}

export const IDLE_DICTATION: DictationSnapshot = {
  owner: null,
  busy: false,
  isRecording: false,
  isProcessing: false,
  partialTranscript: "",
  duration: 0,
  volume: 0,
  error: null,
  status: "idle",
};

interface Session {
  owner: symbol;
  options: DictationTargetOptions;
  sender: DictationStreamSender;
  valid: boolean;
  attempt: number;
  start: Promise<void>;
  stop: Promise<void> | null;
  stopped: boolean;
  cancellation: Promise<void> | null;
  releaseMicrophone: () => void;
  unsubscribe: Array<() => void>;
  durationTimer: ReturnType<typeof setInterval> | null;
}

interface DictationSessionDependencies {
  audio: Pick<DictationAudioSource, "start" | "stop">;
  microphone: MicrophoneCoordinator;
}

export function createDictationSession({ audio, microphone }: DictationSessionDependencies) {
  const listeners = new Set<() => void>();
  const targets = new Map<symbol, DictationTargetOptions>();
  let snapshot = IDLE_DICTATION;
  let current: Session | null = null;

  function publish(next: DictationSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function isCurrent(session: Session) {
    return current === session && session.valid;
  }

  function stopTimer(session: Session) {
    if (session.durationTimer) clearInterval(session.durationTimer);
    session.durationTimer = null;
  }

  function stopCapture(session: Session): Promise<void> {
    // A pending permission prompt cannot be interrupted. Keep the lease until
    // it settles and stop its eventual capture before any new owner can start.
    session.stop ??= (async () => {
      await session.start.catch(() => undefined);
      await audio.stop();
      session.stopped = true;
    })().catch((error: unknown) => {
      session.stop = null;
      throw error;
    });
    return session.stop;
  }

  function release(session: Session) {
    stopTimer(session);
    for (const unsubscribe of session.unsubscribe) unsubscribe();
    session.unsubscribe = [];
    session.sender.dispose();
    session.releaseMicrophone();
    if (current === session) current = null;
  }

  function report(session: Session, error: unknown) {
    if (!isCurrent(session)) return;
    const normalized = toError(error);
    publish({ ...snapshot, error: normalized.message });
    session.options.onError?.(normalized);
  }

  function cancel(owner: symbol): Promise<void> {
    const session = current;
    if (!session || session.owner !== owner) return Promise.resolve();
    if (session.cancellation) return session.cancellation;
    session.valid = false;
    stopTimer(session);
    // Invalidating delivery happens before awaiting microphone teardown.
    publish({ ...IDLE_DICTATION, busy: true });
    try {
      session.sender.cancel();
    } catch (error) {
      console.error("[Dictation] Failed to cancel stream", error);
    }
    session.sender.dispose();
    session.cancellation = (async () => {
      try {
        await stopCapture(session);
      } catch (error) {
        session.cancellation = null;
        publish({
          ...IDLE_DICTATION,
          owner,
          busy: true,
          status: "failed",
          error: toError(error).message,
        });
        return;
      }
      release(session);
      publish(IDLE_DICTATION);
    })();
    return session.cancellation;
  }

  function fail(session: Session, error: unknown) {
    if (!isCurrent(session)) return;
    stopTimer(session);
    const normalized = toError(error);
    session.sender.cancel();
    const canRetry = session.sender.hasSegments() || !session.stopped;
    publish({
      ...snapshot,
      isRecording: false,
      isProcessing: false,
      status: canRetry ? "failed" : "idle",
      error: normalized.message,
      busy: canRetry,
    });
    if (canRetry) {
      session.options.onPermanentFailure?.(normalized, { requestId: generateMessageId() });
    } else {
      release(session);
    }
    session.options.onError?.(normalized);
  }

  function complete(session: Session, text: string) {
    if (!isCurrent(session)) return;
    const transcript = text.trim() || snapshot.partialTranscript.trim();
    release(session);
    publish(IDLE_DICTATION);
    if (transcript) {
      session.options.onTranscript(transcript, { requestId: generateMessageId() });
    }
  }

  async function finish(session: Session, attempt: number) {
    try {
      const finalSeq = session.sender.getFinalSeq();
      const transcript = finalSeq < 0 ? "" : (await session.sender.finish(finalSeq)).text;
      if (session.attempt === attempt) complete(session, transcript);
    } catch (error) {
      if (session.attempt === attempt) fail(session, error);
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    updateTarget(owner: symbol, options: DictationTargetOptions) {
      targets.set(owner, options);
      const session = current;
      if (!session || session.owner !== owner || !session.valid) return;
      const changedTarget = options.targetKey !== session.options.targetKey;
      const changedClient = options.client !== session.options.client;
      if (options.enabled === false || changedTarget || changedClient) void cancel(owner);
    },
    releaseTarget(owner: symbol) {
      targets.delete(owner);
      void cancel(owner);
    },
    async start(owner: symbol) {
      const options = targets.get(owner);
      if (current || !options || options.enabled === false || options.canStart?.() === false)
        return;
      const releaseMicrophone = microphone.acquire("dictation");
      if (!releaseMicrophone) return;
      const session: Session = {
        owner,
        options: { ...options },
        sender: new DictationStreamSender({ client: options.client, format: PCM_DICTATION_FORMAT }),
        valid: true,
        attempt: 0,
        start: Promise.resolve(),
        stop: null,
        stopped: false,
        cancellation: null,
        releaseMicrophone,
        unsubscribe: [],
        durationTimer: null,
      };
      current = session;
      // Claim ownership before the first await, including permission prompts.
      publish({ ...IDLE_DICTATION, owner, busy: true, isRecording: true, status: "recording" });
      let captureStarted = false;
      let connected = options.client?.isConnected ?? false;
      if (options.client) {
        session.unsubscribe.push(
          options.client.subscribeConnectionStatus((connection) => {
            const nextConnected = connection.status === "connected";
            const reconnected = !connected && nextConnected;
            connected = nextConnected;
            if (!isCurrent(session) || !captureStarted || !reconnected || !snapshot.isRecording)
              return;
            void session.sender.restartStream("reconnect").catch((error) => report(session, error));
          }),
        );
        session.unsubscribe.push(
          options.client.subscribeRawMessages((message) => {
            if (!isCurrent(session) || message.type !== "dictation_stream_partial") return;
            if (message.payload.dictationId !== session.sender.getDictationId()) return;
            const text = message.payload.text ?? "";
            publish({ ...snapshot, partialTranscript: text });
            session.options.onPartialTranscript?.(text, { requestId: generateMessageId() });
          }),
        );
      }
      try {
        session.start = audio.start();
        await session.start;
        captureStarted = true;
        if (!isCurrent(session) || session.stop) return;
        if (options.enableDuration) {
          session.durationTimer = setInterval(() => {
            if (isCurrent(session)) publish({ ...snapshot, duration: snapshot.duration + 1 });
          }, DURATION_TICK_MS);
        }
        if (options.client?.isConnected) await session.sender.ensureStream();
      } catch (error) {
        if (!isCurrent(session)) return;
        await stopCapture(session).catch(() => undefined);
        fail(session, error);
      }
    },
    cancel,
    async confirm(owner: symbol) {
      const session = current;
      if (!session || session.owner !== owner || !isCurrent(session)) return;
      if (!snapshot.isRecording || snapshot.isProcessing) return;
      const attempt = ++session.attempt;
      stopTimer(session);
      publish({ ...snapshot, isProcessing: true, error: null });
      try {
        await stopCapture(session);
        // Teardown tolerates a denied start so it can release the microphone.
        // Confirmation must preserve that failure instead of completing empty.
        await session.start;
        if (!isCurrent(session) || session.attempt !== attempt) return;
        publish({ ...snapshot, status: "uploading", isRecording: false });
        if (targets.get(owner)?.canConfirm?.() === false) {
          const message = session.options.client?.isConnected
            ? "Dictation is unavailable. Retry when this input is ready."
            : i18n.t("common.errors.daemonClientDisconnected");
          throw new Error(message);
        }
        await finish(session, attempt);
      } catch (error) {
        if (session.attempt === attempt) fail(session, error);
      }
    },
    async retry(owner: symbol) {
      const session = current;
      if (!session || session.owner !== owner || snapshot.status !== "failed") return;
      if (!session.valid) return cancel(owner);
      const options = targets.get(owner);
      const retryAllowed =
        options &&
        options.enabled !== false &&
        options.canStart?.() !== false &&
        options.canConfirm?.() !== false;
      if (!retryAllowed) return;
      const attempt = ++session.attempt;
      publish({ ...snapshot, status: "uploading", isProcessing: true, error: null });
      try {
        await stopCapture(session);
        if (!isCurrent(session) || session.attempt !== attempt) return;
        session.sender.resetStreamForReplay();
        await finish(session, attempt);
      } catch (error) {
        if (session.attempt === attempt) fail(session, error);
      }
    },
    reset(owner: symbol) {
      if (current?.owner === owner) {
        void cancel(owner);
      } else if (snapshot.owner === owner) {
        publish(IDLE_DICTATION);
      }
    },
    handlePcmSegment(pcm: string) {
      if (current && isCurrent(current) && snapshot.isRecording) current.sender.enqueueSegment(pcm);
    },
    handleVolume(volume: number) {
      if (current && isCurrent(current) && snapshot.isRecording && snapshot.volume !== volume) {
        publish({ ...snapshot, volume });
      }
    },
    handleError(error: Error) {
      if (current) report(current, error);
    },
    async handleInterruption() {
      const session = current;
      if (!session || !isCurrent(session) || !snapshot.isRecording) return;
      const attempt = ++session.attempt;
      stopTimer(session);
      await stopCapture(session).catch(() => undefined);
      if (session.attempt === attempt) {
        fail(session, new Error("Dictation was interrupted by another audio source."));
      }
    },
    async dispose() {
      targets.clear();
      if (current) await cancel(current.owner);
    },
  };
}

export type DictationSession = ReturnType<typeof createDictationSession>;
