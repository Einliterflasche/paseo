import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { preferServiceOomKill } from "../../utils/service-process.js";
import { openPreviewAuthorityClient } from "./authority-client.js";
import type { PreviewGatewayMessage } from "./channel.js";
import { createPreviewGateway } from "./gateway.js";
import { createPreviewIngress } from "./ingress.js";
import { createPreviewIpcChannel } from "./ipc-channel.js";
import { PreviewWorkerStartSchema, type PreviewWorkerStart } from "./worker-protocol.js";

const lifetime = new AbortController();
let started = false;
let closeGateway = () => {};

function close(): void {
  if (lifetime.signal.aborted) return;
  lifetime.abort();
  closeGateway();
  if (process.connected) process.disconnect();
}

async function start(config: PreviewWorkerStart): Promise<void> {
  preferServiceOomKill();
  const channel = createPreviewIpcChannel<PreviewGatewayMessage>({
    signal: lifetime.signal,
    send(frame, completed) {
      if (!process.send) throw new Error("preview-ipc-unavailable");
      process.send(frame, completed);
    },
    subscribe(receive) {
      process.on("message", receive);
      return () => {
        process.off("message", receive);
      };
    },
    disconnect: close,
  });
  const authority = openPreviewAuthorityClient({ channelId: config.channelId, channel });
  const gateway = createPreviewGateway({
    broker: authority,
    controlOrigin: config.controlOrigin,
    controlCookieNames: config.controlCookieNames,
  });
  const ingress = createPreviewIngress({
    preview: gateway,
    application(_request, response) {
      response.writeHead(404);
      response.end();
    },
    legacyUpgrade() {
      return false;
    },
    daemonUpgrade(_request, socket) {
      socket.destroy();
    },
  });
  const server = createServer(ingress.handle);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", ingress.upgrade);
  server.on("connect", ingress.connect);
  closeGateway = () => {
    ingress.close();
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  if (lifetime.signal.aborted) {
    closeGateway();
    return;
  }
  // A caller-owned unique Unix socket avoids a selectable infrastructure TCP
  // endpoint. Never unlink an existing pathname to make startup succeed.
  server.listen({ path: config.socketPath });
  await once(server, "listening");
  server.on("error", close);
  if (lifetime.signal.aborted) return;
  process.send?.({ type: "preview-ready", channelId: config.channelId }, (error) => {
    if (error) close();
  });
}

process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("message", (raw: unknown) => {
  if (raw && typeof raw === "object" && "type" in raw && raw.type === "preview-authority") return;
  const config = PreviewWorkerStartSchema.safeParse(raw);
  if (started || !config.success) {
    close();
    return;
  }
  started = true;
  void start(config.data).catch(() => {
    process.exitCode = 1;
    close();
  });
});
