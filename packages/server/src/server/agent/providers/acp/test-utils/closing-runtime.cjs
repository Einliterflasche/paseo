// Actual ACP SDK protocol peer for shutdown/output-drain regressions.
const readline = require("node:readline");
let promptId;
let mode = "unanswered";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (text) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "close-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  },
});
process.on("SIGTERM", () => {
  send(update("final output"));
  if (mode === "completed") {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  } else if (mode === "failed") {
    send({ jsonrpc: "2.0", id: promptId, error: { code: -32603, message: "native failure" } });
  }
  process.stdout.write("", () => process.exit(0));
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.argv[2] === "hold-initialize") return;
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    if (process.argv[2] === "hold-new") return;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "close-session" } });
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    mode = message.params.prompt[0].text;
    send(update("ready"));
    if (mode === "already-dead") {
      process.stdout.write(`${JSON.stringify(update("final output"))}\n`, () => process.exit(0));
    }
  }
});
setInterval(() => {}, 1000);
