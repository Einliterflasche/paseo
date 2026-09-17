import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeAudioEngine, type NativeAudioAdapter } from "./audio-engine.native";
import type { AudioEngine } from "./audio-engine-types";
import { PermissionStatus, type PermissionResponse } from "expo-modules-core";

const engines: AudioEngine[] = [];

function fixture() {
  const permission: PermissionResponse = {
    granted: true,
    status: PermissionStatus.GRANTED,
    expires: "never",
    canAskAgain: true,
  };
  const native: NativeAudioAdapter = {
    initialize: vi.fn(async () => true),
    addExpoTwoWayAudioEventListener: vi.fn(() => ({ remove() {} })),
    releaseAudioSession: vi.fn(),
    getMicrophonePermissionsAsync: vi.fn(async () => permission),
    requestMicrophonePermissionsAsync: vi.fn(async () => permission),
    resumePlayback: vi.fn(),
    playPCMData: vi.fn(),
    stopPlayback: vi.fn(),
    toggleRecording: vi.fn((recording) => recording),
    tearDown: vi.fn(),
  };
  function engine() {
    const instance = createNativeAudioEngine({ onCaptureData() {}, onVolumeLevel() {} }, native);
    engines.push(instance);
    return instance;
  }
  return { native, engine };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.destroy();
  vi.useRealTimers();
});

describe("native audio ownership", () => {
  it("disposing an idle initialized engine leaves another engine's capture running", async () => {
    const { native, engine } = fixture();
    const idle = engine();
    const capturing = engine();
    await idle.initialize();
    await capturing.startCapture();

    await idle.destroy();

    expect(native.toggleRecording).toHaveBeenCalledExactlyOnceWith(true);
    expect(native.stopPlayback).not.toHaveBeenCalled();
    expect(native.releaseAudioSession).not.toHaveBeenCalled();
    expect(native.tearDown).not.toHaveBeenCalled();
    await capturing.destroy();
    expect(native.toggleRecording).toHaveBeenLastCalledWith(false);
    expect(native.tearDown).toHaveBeenCalledTimes(1);
  });

  it("disposing an idle engine leaves another engine's playback running", async () => {
    const { native, engine } = fixture();
    const idle = engine();
    const playing = engine();
    await idle.initialize();
    const playback = playing.play({
      arrayBuffer: async () => new ArrayBuffer(32000),
      size: 32000,
      type: "audio/pcm;rate=16000",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.playPCMData).toHaveBeenCalledTimes(1);

    await idle.destroy();

    expect(native.stopPlayback).not.toHaveBeenCalled();
    expect(native.releaseAudioSession).not.toHaveBeenCalled();
    expect(native.tearDown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(playback).resolves.toBe(1);
    await playing.destroy();
    expect(native.tearDown).toHaveBeenCalledTimes(1);
  });

  it("an idle engine cannot release the audio session used by another capture", async () => {
    const { native, engine } = fixture();
    const idle = engine();
    const capturing = engine();
    await idle.initialize();
    await capturing.startCapture();

    await idle.stopCapture();

    expect(native.releaseAudioSession).not.toHaveBeenCalled();
    await capturing.stopCapture();
    expect(native.releaseAudioSession).toHaveBeenCalledTimes(1);
  });
});
