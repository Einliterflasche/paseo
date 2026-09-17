import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  createDictationSession,
  IDLE_DICTATION,
  type DictationClient,
  type DictationTargetOptions,
} from "./session";
import { createMicrophoneCoordinator } from "@/voice/microphone";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class MemoryClient implements DictationClient {
  isConnected = true;
  streams: string[] = [];
  chunks: string[] = [];
  cancelled: string[] = [];
  finishes = 0;
  finished: string[] = [];
  finishStarted = deferred<void>();
  listeners = new Set<(message: SessionOutboundMessage) => void>();
  connections = new Set<Parameters<DictationClient["subscribeConnectionStatus"]>[0]>();
  finishText: () => Promise<string> = async () => "spoken words";

  async startDictationStream(id: string) {
    this.streams.push(id);
  }
  sendDictationStreamChunk(id: string, seq: number, audio: string) {
    this.chunks.push(audio);
    for (const listener of this.listeners) {
      listener({ type: "dictation_stream_ack", payload: { dictationId: id, ackSeq: seq } });
    }
  }
  async finishDictationStream(dictationId: string) {
    this.finishes += 1;
    this.finished.push(dictationId);
    this.finishStarted.resolve();
    return { dictationId, text: await this.finishText() };
  }
  cancelDictationStream(id: string) {
    this.cancelled.push(id);
  }
  subscribeRawMessages(listener: (message: SessionOutboundMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeConnectionStatus(listener: Parameters<DictationClient["subscribeConnectionStatus"]>[0]) {
    this.connections.add(listener);
    listener({ status: this.isConnected ? "connected" : "disconnected" });
    return () => {
      this.connections.delete(listener);
    };
  }
}

function fixture() {
  const client = new MemoryClient();
  const microphone = createMicrophoneCoordinator();
  const audio = {
    starts: 0,
    stops: 0,
    capturing: false,
    async start() {
      this.starts += 1;
      this.capturing = true;
    },
    async stop() {
      this.stops += 1;
      this.capturing = false;
    },
  };
  const session = createDictationSession({ audio, microphone });
  function target(key: string) {
    const owner = Symbol(key);
    const transcripts: string[] = [];
    const errors: string[] = [];
    const options: DictationTargetOptions = {
      client,
      targetKey: key,
      onTranscript: (text) => {
        transcripts.push(text);
      },
      onError: (error) => {
        errors.push(error.message);
      },
    };
    session.updateTarget(owner, options);
    return { owner, transcripts, errors, options };
  }
  return { client, microphone, audio, session, target };
}

async function waitForFinish(client: MemoryClient) {
  await client.finishStarted.promise;
}

describe("shared dictation session", () => {
  it("claims a target before microphone permission settles and ignores another target's cleanup", async () => {
    const { session, target, audio, microphone } = fixture();
    const first = target("first");
    const other = target("other");
    const permission = deferred<void>();
    audio.start = async () => {
      audio.starts += 1;
      await permission.promise;
      audio.capturing = true;
    };
    const starting = session.start(first.owner);
    await session.start(other.owner);
    session.releaseTarget(other.owner);
    expect(audio.starts).toBe(1);
    expect(audio.stops).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ owner: first.owner, isRecording: true });
    const cancelling = session.cancel(first.owner);
    expect(microphone.getSnapshot()).toBe("dictation");
    permission.resolve();
    await Promise.all([starting, cancelling]);
    expect(audio.capturing).toBe(false);
    expect(audio.stops).toBe(1);
    expect(microphone.getSnapshot()).toBe(null);
  });

  it("keeps capture and transcript callbacks with the initiating target", async () => {
    const { session, target, client } = fixture();
    const first = target("first");
    const other = target("other");
    await session.start(first.owner);
    session.handlePcmSegment("one");
    session.updateTarget(first.owner, {
      ...first.options,
      onTranscript: (text) => {
        other.transcripts.push(text);
      },
    });
    await session.confirm(other.owner);
    await session.confirm(first.owner);
    expect(first.transcripts).toEqual(["spoken words"]);
    expect(other.transcripts).toEqual([]);
    expect(client.chunks).toEqual(["one"]);
    expect(client.streams).toHaveLength(1);
    expect(client.finished).toEqual(client.streams);
    expect(session.getSnapshot()).toEqual(IDLE_DICTATION);
  });

  it("cancels upload on a client change and never replays the old audio to the new host", async () => {
    const { session, target, client } = fixture();
    const field = target("field");
    const transcript = deferred<string>();
    client.finishText = () => transcript.promise;
    await session.start(field.owner);
    session.handlePcmSegment("private old host audio");
    const confirming = session.confirm(field.owner);
    await waitForFinish(client);
    const newClient = new MemoryClient();
    session.updateTarget(field.owner, { ...field.options, client: newClient });
    await session.dispose();
    transcript.resolve("late old host transcript");
    await confirming;
    expect(field.transcripts).toEqual([]);
    expect(newClient.streams).toEqual([]);
    expect(newClient.chunks).toEqual([]);
  });

  it.each(["unmount", "disabled", "target changed"] as const)(
    "invalidates a pending upload when %s",
    async (reason) => {
      const { session, target, client } = fixture();
      const field = target("field");
      const transcript = deferred<string>();
      client.finishText = () => transcript.promise;
      await session.start(field.owner);
      session.handlePcmSegment("audio");
      const confirming = session.confirm(field.owner);
      await waitForFinish(client);
      if (reason === "unmount") session.releaseTarget(field.owner);
      if (reason === "disabled")
        session.updateTarget(field.owner, { ...field.options, enabled: false });
      if (reason === "target changed")
        session.updateTarget(field.owner, { ...field.options, targetKey: "different field" });
      transcript.resolve("too late");
      await confirming;
      expect(field.transcripts).toEqual([]);
    },
  );

  it("keeps retry audio with its owner, prevents duplicate retry, and invalidates a cancelled retry", async () => {
    const { session, target, client, audio } = fixture();
    const field = target("field");
    const other = target("other");
    client.finishText = async () => {
      throw new Error("transcription unavailable");
    };
    await session.start(field.owner);
    session.handlePcmSegment("retained audio");
    await session.confirm(field.owner);
    expect(session.getSnapshot()).toMatchObject({
      status: "failed",
      error: "transcription unavailable",
      owner: field.owner,
    });
    await session.start(other.owner);
    expect(audio.starts).toBe(1);
    const transcript = deferred<string>();
    client.finishText = () => transcript.promise;
    const retry = session.retry(field.owner);
    await session.retry(field.owner);
    await session.cancel(field.owner);
    transcript.resolve("cancelled retry text");
    await retry;
    expect(field.transcripts).toEqual([]);
    expect(other.transcripts).toEqual([]);
    expect(session.getSnapshot()).toEqual(IDLE_DICTATION);
  });

  it("successfully retries with the original callback and client", async () => {
    const { session, target, client } = fixture();
    const field = target("field");
    client.finishText = async () => {
      throw new Error("retry me");
    };
    await session.start(field.owner);
    session.handlePcmSegment("retained audio");
    await session.confirm(field.owner);
    client.finishText = async () => "recovered text";
    await session.retry(field.owner);
    expect(field.transcripts).toEqual(["recovered text"]);
    expect(client.chunks).toEqual(["retained audio", "retained audio"]);
  });

  it("respects live voice ownership without touching its microphone", async () => {
    const { session, target, microphone, audio } = fixture();
    const field = target("field");
    const releaseVoice = microphone.acquire("voice");
    await session.start(field.owner);
    session.releaseTarget(field.owner);
    await session.dispose();
    expect(audio.starts).toBe(0);
    expect(audio.stops).toBe(0);
    expect(microphone.getSnapshot()).toBe("voice");
    releaseVoice?.();
  });

  it("disposal waits for cancellation already in progress before releasing microphone ownership", async () => {
    const { session, target, audio, microphone } = fixture();
    const field = target("field");
    const permission = deferred<void>();
    audio.start = () => permission.promise;
    const starting = session.start(field.owner);
    session.releaseTarget(field.owner);
    let disposed = false;
    const disposing = session.dispose().then(() => {
      disposed = true;
      return undefined;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(microphone.getSnapshot()).toBe("dictation");
    permission.resolve();
    await Promise.all([starting, disposing]);
    expect(microphone.getSnapshot()).toBe(null);
  });
  it("recovers from rejected microphone permission without reserving the next recording", async () => {
    const { session, target, audio, microphone, client } = fixture();
    const field = target("field");
    audio.start = async () => {
      throw new Error("permission denied");
    };
    await session.start(field.owner);
    expect(session.getSnapshot()).toMatchObject({
      status: "idle",
      error: "permission denied",
      busy: false,
    });
    expect(audio.stops).toBe(1);
    expect(microphone.getSnapshot()).toBe(null);
    expect(client.streams).toEqual([]);

    audio.start = async () => {
      audio.capturing = true;
    };
    await session.start(field.owner);
    expect(session.getSnapshot()).toMatchObject({
      status: "recording",
      error: null,
      owner: field.owner,
    });
    expect(audio.capturing).toBe(true);
    await session.cancel(field.owner);
  });

  it("keeps a microphone denial visible when stopped during permission", async () => {
    const { session, target, audio, microphone, client } = fixture();
    const field = target("field");
    const permission = deferred<void>();
    audio.start = () => permission.promise;
    const starting = session.start(field.owner);
    const confirming = session.confirm(field.owner);
    permission.reject(new Error("permission denied"));
    await Promise.all([starting, confirming]);

    expect(session.getSnapshot()).toMatchObject({
      owner: field.owner,
      status: "idle",
      error: "permission denied",
      busy: false,
    });
    expect(field.errors).toEqual(["permission denied"]);
    expect(field.transcripts).toEqual([]);
    expect(audio.stops).toBe(1);
    expect(microphone.getSnapshot()).toBe(null);
    expect(client.streams).toEqual([]);
    expect(client.finishes).toBe(0);

    audio.start = async () => {
      audio.capturing = true;
    };
    await session.start(field.owner);
    session.handlePcmSegment("new recording");
    await session.confirm(field.owner);
    expect(field.transcripts).toEqual(["spoken words"]);
    expect(session.getSnapshot()).toEqual(IDLE_DICTATION);
    expect(microphone.getSnapshot()).toBe(null);
  });

  it("replays buffered audio in order when the same host reconnects", async () => {
    const { session, target, client } = fixture();
    const field = target("field");
    await session.start(field.owner);
    session.handlePcmSegment("before disconnect");
    client.isConnected = false;
    for (const listener of client.connections) listener({ status: "disconnected" });
    session.handlePcmSegment("while disconnected");
    client.isConnected = true;
    for (const listener of client.connections) listener({ status: "connected" });
    await session.confirm(field.owner);

    expect(client.streams).toHaveLength(2);
    expect(client.cancelled).toEqual([client.streams[0]]);
    expect(client.finished).toEqual([client.streams[1]]);
    expect(client.chunks).toEqual(["before disconnect", "before disconnect", "while disconnected"]);
    expect(field.transcripts).toEqual(["spoken words"]);
    expect(client.finishes).toBe(1);
  });

  it("stops capture and exposes stream startup failures even before any audio arrives", async () => {
    const { session, target, client, audio, microphone } = fixture();
    const field = target("field");
    client.startDictationStream = async (id) => {
      client.streams.push(id);
      throw new Error("stream unavailable");
    };
    await session.start(field.owner);
    expect(audio.capturing).toBe(false);
    expect(audio.stops).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      status: "idle",
      error: "stream unavailable",
      busy: false,
    });
    expect(field.errors).toEqual(["stream unavailable"]);
    expect(client.streams).toHaveLength(1);
    expect(client.cancelled).toEqual(client.streams);
    expect(microphone.getSnapshot()).toBe(null);
  });

  it("delivers partial transcript fallback exactly once despite double confirmation", async () => {
    const { session, target, client } = fixture();
    const field = target("field");
    const transcript = deferred<string>();
    client.finishText = () => transcript.promise;
    await session.start(field.owner);
    session.handlePcmSegment("audio");
    for (const listener of client.listeners)
      listener({
        type: "dictation_stream_partial",
        payload: { dictationId: client.streams[0], text: "  partial fallback  " },
      });
    const first = session.confirm(field.owner);
    await session.confirm(field.owner);
    await waitForFinish(client);
    transcript.resolve("  ");
    await first;
    await session.confirm(field.owner);
    expect(field.transcripts).toEqual(["partial fallback"]);
    expect(client.finishes).toBe(1);
  });

  it("does not release microphone ownership when cancelling fails to stop capture", async () => {
    const { session, target, audio, microphone } = fixture();
    const field = target("field");
    const other = target("other");
    await session.start(field.owner);
    audio.stop = async () => {
      throw new Error("microphone stop failed");
    };
    await session.cancel(field.owner);
    await session.start(other.owner);
    expect(audio.starts).toBe(1);
    expect(microphone.getSnapshot()).toBe("dictation");
    expect(session.getSnapshot()).toMatchObject({
      status: "failed",
      error: "microphone stop failed",
    });
    audio.stop = async () => {
      audio.capturing = false;
    };
    await session.cancel(field.owner);
    expect(microphone.getSnapshot()).toBe(null);
  });
  it("closes an empty recording's daemon stream", async () => {
    const { session, target, client } = fixture();
    const field = target("field");
    await session.start(field.owner);
    await session.confirm(field.owner);
    expect(client.streams).toHaveLength(1);
    expect(client.cancelled).toEqual(client.streams);
    expect(field.transcripts).toEqual([]);
  });

  it("stops locally while disconnected and keeps audio for an eligible retry", async () => {
    const { session, target, client, audio } = fixture();
    const field = target("field");
    session.updateTarget(field.owner, { ...field.options, canConfirm: () => client.isConnected });
    await session.start(field.owner);
    session.handlePcmSegment("before disconnect");
    client.isConnected = false;
    await session.confirm(field.owner);
    expect(audio.capturing).toBe(false);
    expect(session.getSnapshot()).toMatchObject({
      status: "failed",
      isRecording: false,
      isProcessing: false,
    });
    expect(client.finishes).toBe(0);
    client.isConnected = true;
    await session.retry(field.owner);
    expect(field.transcripts).toEqual(["spoken words"]);
  });

  it("rechecks current eligibility before retrying a failed recording", async () => {
    const { session, target, client } = fixture();
    const field = target("field");
    client.finishText = async () => {
      throw new Error("retry later");
    };
    await session.start(field.owner);
    session.handlePcmSegment("audio");
    await session.confirm(field.owner);
    session.updateTarget(field.owner, { ...field.options, canStart: () => false });
    await session.retry(field.owner);
    expect(client.finishes).toBe(1);
    expect(session.getSnapshot().status).toBe("failed");
    session.updateTarget(field.owner, {
      ...field.options,
      canStart: () => true,
      canConfirm: () => false,
    });
    await session.retry(field.owner);
    expect(client.finishes).toBe(1);
    session.updateTarget(field.owner, field.options);
    client.finishText = async () => "retry allowed";
    await session.retry(field.owner);
    expect(field.transcripts).toEqual(["retry allowed"]);
  });

  it("lets an existing owner confirm when only starting another recording is disabled", async () => {
    const { session, target, audio } = fixture();
    const field = target("field");
    await session.start(field.owner);
    session.handlePcmSegment("audio");
    session.updateTarget(field.owner, { ...field.options, canStart: () => false });
    await session.confirm(field.owner);
    expect(field.transcripts).toEqual(["spoken words"]);
    await session.start(field.owner);
    expect(audio.starts).toBe(1);
  });

  it("can confirm during a pending permission prompt without leaving capture running", async () => {
    const { session, target, audio } = fixture();
    const field = target("field");
    const permission = deferred<void>();
    audio.start = async () => {
      await permission.promise;
      audio.capturing = true;
    };
    const starting = session.start(field.owner);
    const confirming = session.confirm(field.owner);
    expect(audio.stops).toBe(0);
    permission.resolve();
    await Promise.all([starting, confirming]);
    expect(audio.capturing).toBe(false);
    expect(audio.stops).toBe(1);
    expect(session.getSnapshot()).toEqual(IDLE_DICTATION);
  });

  it("an interruption during confirmation prevents the interrupted attempt delivering a late result", async () => {
    const { session, target, client, audio } = fixture();
    const field = target("field");
    const stopped = deferred<void>();
    audio.stop = () => stopped.promise;
    await session.start(field.owner);
    session.handlePcmSegment("audio");
    const confirming = session.confirm(field.owner);
    const interrupted = session.handleInterruption();
    stopped.resolve();
    await Promise.all([confirming, interrupted]);
    expect(session.getSnapshot().status).toBe("failed");
    expect(field.transcripts).toEqual([]);
    expect(field.errors).toEqual(["Dictation was interrupted by another audio source."]);
    expect(client.finishes).toBe(0);
    await session.retry(field.owner);
    expect(field.transcripts).toEqual(["spoken words"]);
  });
});
