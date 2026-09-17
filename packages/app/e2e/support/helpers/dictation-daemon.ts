import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { expect } from "@playwright/test";
import type {
  SpeechService,
  SpeechReadinessSnapshot,
} from "../../../../server/dist/server/server/speech/speech-runtime";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
} from "../../../../server/dist/server/server/speech/speech-provider";
import type {
  AgentClient,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptInput,
  AgentSession,
} from "../../../../server/dist/server/server/agent/agent-sdk-types";
import type * as Bootstrap from "../../../../server/dist/server/server/bootstrap";
import type * as MockAgent from "../../../../server/dist/server/server/agent/providers/mock-load-test-agent";

const SERVER_DIR = path.resolve(__dirname, "../../../../server");
const WEB_DIST = path.join(SERVER_DIR, "dist/server/web-ui");

export class ControlledTranscription extends EventEmitter implements StreamingTranscriptionSession {
  readonly requiredSampleRate = 16000;
  chunks = 0;
  bytes = 0;
  connected = false;
  finished = false;
  closed = false;
  completed = false;
  private nextSegmentId = randomUUID();
  private committedSegmentIds: string[] = [];
  private completedText: string | null = null;

  constructor(readonly id: string) {
    super();
  }
  get canceled() {
    return this.closed && !this.completed;
  }
  async connect() {
    this.connected = true;
  }
  appendPcm16(pcm: Buffer) {
    this.chunks += 1;
    this.bytes += pcm.length;
  }
  commit() {
    const previousSegmentId = this.committedSegmentIds.at(-1) ?? null;
    const segmentId = this.nextSegmentId;
    this.nextSegmentId = randomUUID();
    this.committedSegmentIds.push(segmentId);
    this.finished = true;
    this.emit("committed", { segmentId, previousSegmentId });
    if (this.completedText !== null) {
      this.emitTranscript(
        segmentId,
        this.committedSegmentIds.length === 1 ? this.completedText : "",
      );
    }
  }
  clear() {}
  close() {
    this.closed = true;
  }
  complete(text: string) {
    this.completed = true;
    this.completedText = text;
    // A browser test supplies one utterance, even when its recording spans auto-commits.
    // Repeated complete calls still emit duplicate events for client idempotency checks.
    const segmentIds =
      this.committedSegmentIds.length > 0 ? this.committedSegmentIds : [this.nextSegmentId];
    segmentIds.forEach((segmentId, index) =>
      this.emitTranscript(segmentId, index === 0 ? text : ""),
    );
  }
  private emitTranscript(segmentId: string, transcript: string) {
    this.emit("transcript", { segmentId, transcript, isFinal: true });
  }
  fail(message: string) {
    this.emit("error", new Error(message));
  }
}

export function createControlledSpeech() {
  const requests: ControlledTranscription[] = [];
  const provider: SpeechToTextProvider = {
    id: "local",
    createSession({ logger }) {
      const binding = logger.bindings().dictationId;
      const request = new ControlledTranscription(
        typeof binding === "string" ? binding : randomUUID(),
      );
      requests.push(request);
      return request;
    },
  };
  const ready = {
    enabled: true,
    available: true,
    reasonCode: "ready",
    message: "Test speech ready",
    retryable: false,
    missingModelIds: [],
  } as const;
  const disabled = {
    enabled: false,
    available: false,
    reasonCode: "disabled",
    message: "Realtime voice disabled",
    retryable: false,
    missingModelIds: [],
  } as const;
  const readiness: SpeechReadinessSnapshot = {
    generatedAt: new Date().toISOString(),
    requiredLocalModelIds: [],
    missingLocalModelIds: [],
    download: { inProgress: false, error: null },
    dictation: { ...ready, missingModelIds: [] },
    voiceFeature: { ...ready, missingModelIds: [] },
    realtimeVoice: { ...disabled, missingModelIds: [] },
  };
  const service: SpeechService = {
    resolveStt: () => null,
    resolveSttLanguage: () => "en",
    resolveTts: () => null,
    resolveTurnDetection: () => null,
    resolveDictationStt: () => provider,
    resolveDictationSttLanguage: () => "en",
    getReadiness: () => readiness,
    onReadinessChange: () => () => {},
    start() {},
    async stop() {
      for (const request of requests) request.close();
    },
    ready: Promise.resolve(),
  };
  function requestAt(index: number) {
    const request = requests[index];
    if (!request) throw new Error(`No dictation request at index ${index}`);
    return request;
  }
  return {
    service,
    requests,
    openSessions: () => requests.filter((request) => !request.closed),
    async waitForAudio(index = 0) {
      await expect.poll(() => requests[index]?.chunks ?? 0).toBeGreaterThan(0);
    },
    async waitForFinish(index = 0) {
      await expect.poll(() => requests[index]?.finished ?? false).toBe(true);
    },
    complete(text: string, index = requests.length - 1) {
      requestAt(index).complete(text);
    },
    fail(message: string, index = requests.length - 1) {
      requestAt(index).fail(message);
    },
    reset() {
      if (requests.some((request) => !request.closed))
        throw new Error("Previous transcription is still open");
      requests.length = 0;
    },
  };
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function guardedSession(
  session: AgentSession,
  prompts: Array<{ initialPrompt: string }>,
  responses: AgentPermissionResponse[],
  internal: boolean,
): AgentSession {
  let duplicateQuestions = false;
  function preparePrompt(prompt: AgentPromptInput) {
    const text = promptText(prompt);
    if (!internal) prompts.push({ initialPrompt: text });
    duplicateQuestions = text.includes("Duplicate prompt dictation.");
    if (!text.startsWith("Emit synthetic questions"))
      throw new Error("Agent launch intentionally blocked by dictation browser test");
  }
  function questionRequest(request: AgentPermissionRequest): AgentPermissionRequest {
    if (!duplicateQuestions || request.kind !== "question") return request;
    return {
      ...request,
      input: {
        questions: [
          {
            question: "Same question",
            header: "repoUrl",
            options: [{ label: "First choice" }],
            multiSelect: true,
            allowOther: true,
          },
          {
            question: "Same question",
            header: "commitMessage",
            options: [{ label: "Second choice" }],
            multiSelect: true,
            allowOther: true,
          },
        ],
      },
    };
  }
  return {
    provider: session.provider,
    id: session.id,
    capabilities: session.capabilities,
    async run(prompt, options) {
      preparePrompt(prompt);
      return session.run(prompt, options);
    },
    async startTurn(prompt, options) {
      preparePrompt(prompt);
      return session.startTurn(prompt, options);
    },
    subscribe: (handler) =>
      session.subscribe((event) =>
        handler(
          event.type === "permission_requested"
            ? { ...event, request: questionRequest(event.request) }
            : event,
        ),
      ),
    streamHistory: () => session.streamHistory(),
    getRuntimeInfo: () => session.getRuntimeInfo(),
    getAvailableModes: () => session.getAvailableModes(),
    getCurrentMode: () => session.getCurrentMode(),
    setMode: (mode) => session.setMode(mode),
    getPendingPermissions: () => session.getPendingPermissions().map(questionRequest),
    respondToPermission: (id, response) => {
      responses.push(response);
      return session.respondToPermission(id, response);
    },
    describePersistence: () => session.describePersistence(),
    interrupt: () => session.interrupt(),
    close: () => session.close(),
  };
}

/** Real loopback daemon and protocol; only microphone/STT and agent harness are typed test adapters. */
export async function startDictationDaemon() {
  await access(path.join(WEB_DIST, "index.html"));
  const [{ createPaseoDaemon }, { MockLoadTestAgentClient }] = await Promise.all([
    import(pathToFileURL(path.join(SERVER_DIR, "dist/server/server/bootstrap.js")).href) as Promise<
      typeof Bootstrap
    >,
    import(
      pathToFileURL(
        path.join(SERVER_DIR, "dist/server/server/agent/providers/mock-load-test-agent.js"),
      ).href
    ) as Promise<typeof MockAgent>,
  ]);
  const home = await mkdtemp(path.join(tmpdir(), "paseo-dictation-real-"));
  await mkdir(path.join(home, "static"));
  const logger = pino({ level: "debug" }, pino.destination(path.join(home, "daemon.log")));
  const speech = createControlledSpeech();
  const agentRequests: Array<{ initialPrompt: string }> = [];
  const permissionResponses: AgentPermissionResponse[] = [];
  const harness = new MockLoadTestAgentClient(logger);
  const agent: AgentClient = {
    provider: harness.provider,
    capabilities: harness.capabilities,
    async createSession(config, context) {
      return guardedSession(
        await harness.createSession(config, context),
        agentRequests,
        permissionResponses,
        config.internal === true,
      );
    },
    async resumeSession(handle, config, context) {
      return guardedSession(
        await harness.resumeSession(handle, config, context),
        agentRequests,
        permissionResponses,
        config?.internal === true,
      );
    },
    fetchCatalog: (options) => harness.fetchCatalog(options),
    isAvailable: () => harness.isAvailable(),
  };
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome: home,
      corsAllowedOrigins: [],
      hostnames: true,
      staticDir: path.join(home, "static"),
      mcpDebug: false,
      mcpEnabled: false,
      isDev: true,
      agentClients: { mock: agent },
      agentStoragePath: path.join(home, "agents"),
      relayEnabled: false,
      autoArchiveAfterMerge: false,
      webUi: { enabled: true, distDir: WEB_DIST },
      voiceLlmProvider: null,
      voiceLlmProviderExplicit: true,
    },
    logger,
    { speechService: speech.service },
  );
  await daemon.start();
  const target = daemon.getListenTarget();
  if (target?.type !== "tcp") throw new Error("Dictation daemon has no bound TCP address");
  const daemonOrigin = `http://127.0.0.1:${target.port}`;
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const proxy = http.createServer((request, response) => {
    const upstream = http.request(
      new URL(request.url ?? "/", daemonOrigin),
      { method: request.method, headers: request.headers },
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
  });
  proxy.on("connection", track);
  proxy.on("upgrade", (request, socket, head) => {
    connectionCount += 1;
    const upstream = net.connect(target.port, "127.0.0.1", () => {
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
    track(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback proxy address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    home,
    serverId: (await readFile(path.join(home, "server-id"), "utf8")).trim(),
    speech: {
      ...speech,
      agentRequests,
      permissionResponses,
      disconnect() {
        for (const socket of sockets) socket.destroy();
      },
      connectionCount: () => connectionCount,
      reset() {
        speech.reset();
        agentRequests.length = 0;
        permissionResponses.length = 0;
      },
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      await daemon.stop();
      await daemon.agentManager.flush();
      logger.flush();
      // Keep isolated state, recordings and logs for inspection.
    },
  };
}

export type DictationDaemon = Awaited<ReturnType<typeof startDictationDaemon>>;
