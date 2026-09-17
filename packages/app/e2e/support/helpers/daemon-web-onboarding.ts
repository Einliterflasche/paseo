import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { killProcessTree } from "./spawn-node";
import { withDisabledE2ESpeechEnv } from "./speech-env";

const SERVER_DIR = path.resolve(__dirname, "../../../../server");
const WEB_DIST = path.join(SERVER_DIR, "dist/server/web-ui");

export interface OnboardingServer {
  origin: string;
  home: string;
  setAvailable(available: boolean): void;
  close(): Promise<void>;
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  return address.port;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function requireWebBuild(): Promise<void> {
  await access(path.join(WEB_DIST, "index.html")).catch(() => {
    throw new Error(
      "Build the daemon and web UI with npm run build:server and npm run build:daemon-web-ui first.",
    );
  });
}

export async function startOnboardingDaemon(options: {
  password?: string;
  tls: boolean;
}): Promise<OnboardingServer> {
  await requireWebBuild();
  const reservation = net.createServer();
  const daemonPort = await listen(reservation);
  await closeServer(reservation);
  const home = await mkdtemp(path.join(tmpdir(), "paseo-web-onboarding-"));
  const daemonOrigin = `http://127.0.0.1:${daemonPort}`;
  const child = spawn(
    process.execPath,
    [path.join(SERVER_DIR, "dist/scripts/supervisor-entrypoint.js")],
    {
      cwd: SERVER_DIR,
      env: withDisabledE2ESpeechEnv({
        ...process.env,
        PASEO_HOME: home,
        PASEO_SERVER_ID: `web-onboarding-${daemonPort}`,
        PASEO_LISTEN: `127.0.0.1:${daemonPort}`,
        PASEO_PASSWORD: options.password ?? "",
        PASEO_RELAY_ENABLED: "0",
        PASEO_WEB_UI_ENABLED: "true",
        PASEO_WEB_UI_DIST_DIR: WEB_DIST,
        PASEO_NODE_ENV: "development",
        NODE_ENV: "development",
      }),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let proxy: http.Server | https.Server | null = null;
  let available = true;
  const sockets = new Set<Socket>();
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (proxy) await closeServer(proxy);
    await killProcessTree(child);
    // Retain isolated daemon state and logs for inspecting failures.
  };

  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Onboarding daemon exited before ready: ${stderr}`);
      }
      const ready = await fetch(daemonOrigin, { signal: AbortSignal.timeout(1_000) })
        .then(
          async (response) =>
            response.ok && (await response.text()).includes("__PASEO_INITIAL_DAEMON_CONNECTION__"),
        )
        .catch(() => false);
      if (ready) break;
      if (Date.now() > deadline)
        throw new Error(`Onboarding daemon did not serve its web UI: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Deliberately preserve Host but do not add forwarded TLS headers: the daemon
    // sees HTTP, while the browser must use its own HTTPS address for WebSockets.
    // These committed credentials are test-only, for this loopback TLS listener.
    const fixture = path.resolve(__dirname, "../fixtures/onboarding-tls");
    const requestHandler: http.RequestListener = (request, response) => {
      if (!available) {
        response.writeHead(503);
        response.end();
        return;
      }
      const upstream = http.request(
        new URL(request.url ?? "/", daemonOrigin),
        {
          method: request.method,
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    };
    proxy = options.tls
      ? https.createServer(
          {
            key: await readFile(path.join(fixture, "key.txt")),
            cert: await readFile(path.join(fixture, "cert.txt")),
          },
          requestHandler,
        )
      : http.createServer(requestHandler);
    proxy.on("connection", trackSocket);
    proxy.on("upgrade", (request, socket, head) => {
      if (!available) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = net.connect(daemonPort, "127.0.0.1", () => {
        const headers = request.rawHeaders.reduce<string[]>((lines, value, index, all) => {
          if (index % 2 === 0) lines.push(`${value}: ${all[index + 1]}`);
          return lines;
        }, []);
        upstream.write(
          `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
        );
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      trackSocket(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    return {
      origin: `${options.tls ? "https" : "http"}://127.0.0.1:${proxyPort}`,
      home,
      setAvailable(value) {
        available = value;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function startStandaloneWebUi(): Promise<{ origin: string; close(): Promise<void> }> {
  await requireWebBuild();
  const contentTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const candidate = path.join(WEB_DIST, pathname);
    const candidateStat = await stat(candidate).catch(() => null);
    const file = candidateStat?.isFile() ? candidate : path.join(WEB_DIST, "index.html");
    response.setHeader(
      "Content-Type",
      contentTypes[path.extname(file)] ?? "application/octet-stream",
    );
    createReadStream(file).pipe(response);
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}
