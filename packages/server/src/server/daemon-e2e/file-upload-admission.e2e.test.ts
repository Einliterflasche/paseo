import { readFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import {
  WSOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../messages.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

let daemon: TestPaseoDaemon | undefined;
let currentSocket: WebSocket | undefined;

afterEach(async () => {
  currentSocket?.terminate();
  currentSocket = undefined;
  daemon?.daemon.agentManager.openRestartAdmissions();
  await daemon?.close();
  daemon = undefined;
});

test("a frozen binary upload gets a correlated retryable error without replacing completed attachments", async () => {
  daemon = await createTestPaseoDaemon();
  const connection = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
  currentSocket = connection;
  const messages: SessionOutboundMessage[] = [];
  connection.on("message", (data: RawData, binary) => {
    if (binary) return;
    const parsed = WSOutboundMessageSchema.parse(JSON.parse(data.toString()));
    if (parsed.type === "session") messages.push(parsed.message);
  });
  await new Promise<void>((resolve, reject) => {
    connection.once("open", resolve);
    connection.once("error", reject);
  });
  const ready = waitFor(
    connection,
    "status",
    (message) => message.payload.status === "server_info",
  );
  connection.send(
    JSON.stringify({
      type: "hello",
      clientId: "upload-admission",
      clientType: "browser",
      protocolVersion: 1,
    }),
  );
  await ready;

  const preserved = Buffer.from("completed attachment survives the recovery boundary");
  const first = waitFor(
    connection,
    "file.upload.response",
    (message) => message.payload.requestId === "completed",
  );
  sendUpload(connection, "completed", preserved, true);
  const completed = await first;
  expect(completed.payload.error).toBeNull();
  if (!completed.payload.file) throw new Error("Missing completed attachment");
  const completedPath = completed.payload.file.path;

  const partial = Buffer.from("bytes accepted before FileEnd");
  sendUpload(connection, "interrupted", partial, false);
  // Ping follows the frames on this socket, establishing their receipt without
  // treating an upload response as evidence that FileEnd was already accepted.
  const ping = waitFor(
    connection,
    "pong",
    (message) => message.payload.requestId === "frames-received",
  );
  send(connection, { type: "ping", requestId: "frames-received", clientSentAt: 1 });
  await ping;
  await daemon.daemon.agentManager.freezeRestartAdmissions();

  const rejected = waitFor(
    connection,
    "rpc_error",
    (message) => message.payload.requestId === "interrupted",
  );
  connection.send(
    encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "interrupted" }),
  );
  expect((await rejected).payload).toEqual({
    requestId: "interrupted",
    requestType: "file.upload.request",
    code: "restart_in_progress",
    error: "The daemon is preparing or recovering a restart; retry this request when it is ready.",
  });
  expect(
    messages.filter(
      (message) =>
        message.type === "file.upload.response" && message.payload.requestId === "interrupted",
    ),
  ).toEqual([]);
  expect(await readFile(completedPath)).toEqual(preserved);

  daemon.daemon.agentManager.openRestartAdmissions();
  const retried = waitFor(
    connection,
    "file.upload.response",
    (message) => message.payload.requestId === "fresh-retry",
  );
  sendUpload(connection, "fresh-retry", partial, true);
  const result = await retried;
  expect(result.payload.error).toBeNull();
  expect(result.payload.file).toMatchObject({
    type: "uploaded_file",
    fileName: "attachment.bin",
    size: partial.length,
  });
  if (!result.payload.file) throw new Error("Missing retried attachment");
  expect(await readFile(result.payload.file.path)).toEqual(partial);
  expect(await readFile(completedPath)).toEqual(preserved);
  expect(
    messages.filter(
      (message) =>
        message.type === "file.upload.response" && message.payload.requestId === "interrupted",
    ),
  ).toEqual([]);
}, 30_000);

function send(socket: WebSocket, message: SessionInboundMessage): void {
  socket.send(JSON.stringify({ type: "session", message }));
}

function sendUpload(
  socket: WebSocket,
  requestId: string,
  bytes: Uint8Array,
  finish: boolean,
): void {
  const metadata = {
    mime: "application/octet-stream",
    size: bytes.byteLength,
    encoding: "binary" as const,
    modifiedAt: "2026-09-19T00:00:00.000Z",
    fileName: "attachment.bin",
  };
  send(socket, {
    type: "file.upload.request",
    requestId,
    fileName: metadata.fileName,
    mimeType: metadata.mime,
    size: metadata.size,
    modifiedAt: metadata.modifiedAt,
  });
  socket.send(
    encodeFileTransferFrame({ opcode: FileTransferOpcode.FileBegin, requestId, metadata }),
  );
  socket.send(
    encodeFileTransferFrame({ opcode: FileTransferOpcode.FileChunk, requestId, payload: bytes }),
  );
  if (finish)
    socket.send(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
}

function waitFor<K extends SessionOutboundMessage["type"]>(
  socket: WebSocket,
  type: K,
  matches: (message: Extract<SessionOutboundMessage, { type: K }>) => boolean,
): Promise<Extract<SessionOutboundMessage, { type: K }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 10_000);
    const receive = (data: RawData, binary: boolean) => {
      if (binary) return;
      const parsed = WSOutboundMessageSchema.parse(JSON.parse(data.toString()));
      if (parsed.type !== "session" || parsed.message.type !== type) return;
      const message = parsed.message as Extract<SessionOutboundMessage, { type: K }>;
      if (!matches(message)) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}
