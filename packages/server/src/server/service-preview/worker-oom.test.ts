// The preview gateway worker is a real forked disposable process. This
// checks its own self-adjustment, not any host memory pressure.
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPlatform } from "../../test-utils/platform.js";
import { PreviewBroker } from "./broker.js";
import { PreviewRoutes } from "./routes.js";
import { PreviewSources } from "./sources.js";
import { startPreviewGatewayWorker } from "./worker.js";

const linuxOnly = isPlatform("linux") ? it : it.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("preview gateway worker OOM score self-adjustment", () => {
  linuxOnly(
    "the real forked gateway worker raises its own score before it is ready to accept connections",
    async () => {
      const before = readFileSync("/proc/self/oom_score_adj", "utf8").trim();
      const directory = await mkdtemp(join(tmpdir(), "paseo-gw-oom-"));
      const socketPath = join(directory, "gateway.sock");
      const sources = new PreviewSources("https://control.test");
      const routes = new PreviewRoutes({ excludedPorts: [] });
      const failures: unknown[] = [];
      const broker = new PreviewBroker({
        sources,
        routes,
        onFailure: (error) => {
          failures.push(error);
        },
      });
      const worker = startPreviewGatewayWorker({
        broker,
        socketPath,
        controlCookieNames: ["paseo-control"],
        onFailure: (error) => {
          failures.push(error);
        },
      });
      cleanups.push(async () => {
        worker.close();
        await worker.closed;
        sources.close();
        routes.close();
        broker.close();
        expect(failures).toEqual([]);
      });
      await worker.ready;
      expect(worker.pid).toBeDefined();
      // preferServiceOomKill() runs as the very first statement of the
      // worker's start(), synchronously before the IPC channel, the gateway,
      // or the listening socket — by the time `ready` resolves it must
      // already be set, not merely "eventually".
      const score = readFileSync(`/proc/${worker.pid}/oom_score_adj`, "utf8").trim();
      expect(score).toBe("1000");
      // The parent daemon process (this test) must be untouched.
      const after = readFileSync("/proc/self/oom_score_adj", "utf8").trim();
      expect(after).toBe(before);
    },
  );
});
