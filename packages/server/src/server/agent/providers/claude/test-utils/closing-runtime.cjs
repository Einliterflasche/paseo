// Test protocol peer for the real Claude SDK. It never invokes a model or tools.
const readline = require("node:readline");
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const assistant = (text, uuid) => ({
  type: "assistant",
  uuid,
  session_id: "closing-runtime",
  parent_tool_use_id: null,
  message: {
    id: uuid,
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});
let nonzeroShutdown = false;
const finishNonzeroShutdown = () => {
  process.stdout.write(
    `${JSON.stringify(assistant("final stdout before exit", "late-message"))}\n`,
    () => process.exit(1),
  );
};
process.on("SIGTERM", () => {
  if (nonzeroShutdown) {
    finishNonzeroShutdown();
    return;
  }
  process.stdout.write(
    `${JSON.stringify(assistant("final stdout before exit", "late-message"))}\n`,
    () => {
      process.removeAllListeners("SIGTERM");
      process.kill(process.pid, "SIGTERM");
    },
  );
});
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  if (nonzeroShutdown) finishNonzeroShutdown();
});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [], models: [], account: {} },
      },
    });
  } else if (message.type === "user") {
    nonzeroShutdown = JSON.stringify(message.message).includes("exit nonzero on shutdown");
    write({
      type: "system",
      subtype: "init",
      session_id: "closing-runtime",
      permissionMode: "default",
      model: "claude-test",
    });
    write(assistant("ready to stop", "ready-message"));
    if (JSON.stringify(message.message).includes("exit before close")) {
      process.stdout.write(
        `${JSON.stringify(assistant("final output before natural exit", "exit-message"))}\n`,
        () => process.exit(7),
      );
    }
  }
});
// Keep the provider process alive until its owner terminates it, even when stdin ends.
setInterval(() => {}, 1000);
