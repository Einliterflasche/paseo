import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const listenPort = Number.parseInt(process.env.PASEO_PORT ?? "", 10);
const baseUrl = (process.env.PASEO_DEV_BASE_URL ?? "").trim().replace(/\/+$/, "");
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535 || !baseUrl) {
  throw new Error("PASEO_PORT and PASEO_DEV_BASE_URL are required");
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reserve = net.createServer();
await new Promise((resolve, reject) => {
  reserve.once("error", reject);
  reserve.listen(0, "127.0.0.1", resolve);
});
const upstreamPort = reserve.address().port;
await new Promise((resolve, reject) =>
  reserve.close((error) => (error ? reject(error) : resolve())),
);

const expo = spawn(
  path.resolve(appRoot, "..", "..", "node_modules", ".bin", "expo"),
  ["start", "--web", "--port", String(upstreamPort)],
  { cwd: appRoot, env: process.env, stdio: "inherit" },
);

const developmentBaseGuard = Buffer.from("if (process.env.NODE_ENV !== 'development') {");

class DevelopmentBaseUrlTransform extends Transform {
  #pending = "";

  _transform(chunk, _encoding, callback) {
    this.#pending += chunk.toString("utf8");
    this.#drain(false);
    callback();
  }

  _flush(callback) {
    this.#drain(true);
    callback();
  }

  #drain(flush) {
    const needle = developmentBaseGuard.toString("utf8");
    while (true) {
      const match = this.#pending.indexOf(needle);
      if (match < 0) break;
      this.push(this.#pending.slice(0, match));
      this.push("if (true) {");
      this.#pending = this.#pending.slice(match + needle.length);
    }
    const readyLength = flush ? this.#pending.length : this.#pending.length - needle.length + 1;
    if (readyLength > 0) {
      this.push(this.#pending.slice(0, readyLength));
      this.#pending = this.#pending.slice(readyLength);
    }
  }
}
expo.once("error", (error) => {
  console.error(error);
  server.close(() => {
    process.exitCode = 1;
  });
});

function proxyRequest(req, res) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
    },
    (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers["content-type"] ?? "");
      if (contentType.includes("javascript")) {
        const headers = { ...upstreamResponse.headers };
        delete headers["content-length"];
        res.writeHead(upstreamResponse.statusCode ?? 200, headers);
        upstreamResponse.pipe(new DevelopmentBaseUrlTransform()).pipe(res);
        return;
      }
      if (!contentType.includes("text/html")) {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
        return;
      }

      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const html = Buffer.concat(chunks)
          .toString("utf8")
          .replaceAll('src="/', `src="${baseUrl}/`)
          .replaceAll('href="/', `href="${baseUrl}/`);
        const headers = { ...upstreamResponse.headers };
        delete headers["content-length"];
        res.writeHead(upstreamResponse.statusCode ?? 200, headers);
        res.end(html);
      });
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Development server is starting");
  });
  req.pipe(upstream);
}

const server = http.createServer(proxyRequest);
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(req.headers)) {
      if (name !== "host" && value !== undefined) upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write(`host: 127.0.0.1:${upstreamPort}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

await new Promise((resolve, reject) => {
  let stopped = false;
  const check = () => {
    const request = http.get({ host: "127.0.0.1", port: upstreamPort, path: "/" }, (response) => {
      response.once("end", resolve);
      response.resume();
    });
    request.once("error", () => {
      if (!stopped) setTimeout(check, 100);
    });
  };
  expo.once("exit", (code, signal) => {
    stopped = true;
    reject(new Error(`Expo exited before becoming ready (${signal ?? code ?? "unknown"})`));
  });
  check();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(listenPort, "127.0.0.1", resolve);
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  server.close();
  expo.kill(signal);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
expo.once("exit", (code, signal) => {
  server.close(() => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
});
