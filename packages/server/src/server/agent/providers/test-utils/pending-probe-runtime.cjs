const fs = require("node:fs");
const readline = require("node:readline");

function pending(phase) {
  fs.writeFileSync(
    process.env.PASEO_TEST_PROBE_MARKER ??
      process.argv
        .find((arg) => arg.startsWith("--probe-marker="))
        ?.slice("--probe-marker=".length),
    JSON.stringify({ phase, pid: process.pid }),
  );
}

// The probe owns a native process which deliberately never acknowledges its
// initialization. No model request or external service is involved.
if (process.argv.includes("--version")) pending("version");
else if (process.argv.includes("auth")) pending("auth");
else if (process.argv.includes("omp")) pending("ready");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") pending("initialize");
  if (request.type === "get_state") pending("get_state");
  if (request.type === "get_available_models") pending("get_available_models");
  if (request.type === "control_request" && request.request?.subtype === "initialize")
    pending("control_initialize");
});
setInterval(() => {}, 1_000);
