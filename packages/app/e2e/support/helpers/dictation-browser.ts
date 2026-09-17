import type { Page } from "@playwright/test";

interface MicrophoneState {
  requests: number;
  liveTracks: number;
  maximumLiveTracks: number;
  holdPermission: boolean;
  rejectNextPermission: boolean;
  setLevel(level: number): void;
  releasePermission(): void;
}

declare global {
  interface Window {
    dictationTestMicrophone: MicrophoneState;
  }
}

export async function installDictationMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const permissions: Array<() => void> = [];
    const gains = new Set<GainNode>();
    let level = 1;
    const state: MicrophoneState = {
      requests: 0,
      liveTracks: 0,
      maximumLiveTracks: 0,
      holdPermission: false,
      rejectNextPermission: false,
      setLevel(nextLevel) {
        level = nextLevel;
        for (const gain of gains) gain.gain.value = level;
      },
      releasePermission() {
        state.holdPermission = false;
        for (const release of permissions.splice(0)) release();
      },
    };
    window.dictationTestMicrophone = state;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        state.requests += 1;
        if (state.holdPermission) await new Promise<void>((resolve) => permissions.push(resolve));
        if (state.rejectNextPermission) {
          state.rejectNextPermission = false;
          throw new DOMException("Microphone access denied", "NotAllowedError");
        }
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = level;
        gains.add(gain);
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await context.resume();
        for (const track of destination.stream.getTracks()) {
          state.liveTracks += 1;
          state.maximumLiveTracks = Math.max(state.maximumLiveTracks, state.liveTracks);
          const stop = track.stop.bind(track);
          let stopped = false;
          track.stop = () => {
            if (stopped) return;
            stopped = true;
            state.liveTracks -= 1;
            stop();
            oscillator.stop();
            gains.delete(gain);
            void context.close();
          };
        }
        return destination.stream;
      },
    });
  });
}
