import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveDaemonHeapArgs } from "./daemon-heap.js";

describe("daemon worker heap", () => {
  it("allows a 6 GiB worker heap without changing spawned Node programs", () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const probe = "console.log(require('node:v8').getHeapStatistics().heap_size_limit)";
    const ordinaryLimit = Number(execFileSync(process.execPath, ["-e", probe], { env }));
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          ...resolveDaemonHeapArgs({ PASEO_DAEMON_HEAP_MB: "6144" }, false),
          "-e",
          `console.log(JSON.stringify({
            heap: require('node:v8').getHeapStatistics().heap_size_limit,
            child: Number(require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(probe)}]))
          }))`,
        ],
        { env, encoding: "utf8" },
      ),
    );
    expect(result.heap).toBeGreaterThanOrEqual(6144 * 1024 * 1024);
    expect(result.child).toBe(ordinaryLimit);
  });

  it("preserves existing defaults and permits overriding the development heap", () => {
    expect(resolveDaemonHeapArgs({}, false)).toEqual([]);
    expect(resolveDaemonHeapArgs({}, true)).toEqual(["--max-old-space-size=3072"]);
    expect(resolveDaemonHeapArgs({ PASEO_DAEMON_HEAP_MB: "6144" }, true)).toEqual([
      "--max-old-space-size=6144",
    ]);
  });

  it.each(["", "0", "-1", "1.5", "6144 --inspect", "9007199254740992"])(
    "rejects an invalid configured heap: %s",
    (value) => {
      expect(() => resolveDaemonHeapArgs({ PASEO_DAEMON_HEAP_MB: value }, false)).toThrow(
        "PASEO_DAEMON_HEAP_MB must be a positive integer in MiB",
      );
    },
  );
});
