import type { PreviewBrokerMessage, PreviewChannel, PreviewGatewayMessage } from "./channel.js";

type AuthorityMessage = PreviewBrokerMessage | PreviewGatewayMessage;

export interface PreviewIpcFrame {
  type: "preview-authority";
  message: AuthorityMessage;
}

interface PreviewIpcTransport {
  readonly signal: AbortSignal;
  send(frame: PreviewIpcFrame, completed: (error: Error | null) => void): void;
  subscribe(receive: (frame: unknown) => void): () => void;
  disconnect(): void;
}

/** IPC framing stays separate from job approval and cancellation acknowledgement. */
export function createPreviewIpcChannel<Message extends AuthorityMessage>(
  transport: PreviewIpcTransport,
): PreviewChannel<Message> {
  const controller = new AbortController();
  const listeners = new Set<(message: unknown) => void>();
  let unsubscribe = () => {};
  function close() {
    if (controller.signal.aborted) return;
    unsubscribe();
    transport.signal.removeEventListener("abort", close);
    controller.abort();
    listeners.clear();
    transport.disconnect();
  }
  unsubscribe = transport.subscribe((frame) => {
    if (
      !frame ||
      typeof frame !== "object" ||
      !("type" in frame) ||
      frame.type !== "preview-authority"
    )
      return;
    if (!("message" in frame)) {
      close();
      return;
    }
    for (const receive of listeners) receive(frame.message);
  });
  transport.signal.addEventListener("abort", close, { once: true });
  if (transport.signal.aborted) close();
  return {
    signal: controller.signal,
    close,
    subscribe(receive) {
      if (controller.signal.aborted) return () => {};
      listeners.add(receive);
      return () => {
        listeners.delete(receive);
      };
    },
    send(message) {
      if (controller.signal.aborted) throw new Error("preview-ipc-closed");
      try {
        transport.send({ type: "preview-authority", message }, (error) => {
          if (error) close();
        });
      } catch (error) {
        close();
        throw error;
      }
    },
  };
}
