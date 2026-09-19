import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const MIB = 1024 * 1024;

interface MemorySample {
  stage: string;
  heapUsed: number;
  baselineHeap?: number;
  checkpointBytes?: number;
  logicalLogUnits: number;
  canonicalRows: number;
  nonPrefixChanges: number;
}

test("retains and checkpoints exact growing native subagent histories without cumulative copies", async () => {
  // A separate V8 isolate makes GC measurements independent of Vitest's own heap.
  // These are regression-workload budgets, never product history or memory caps.
  const { stdout, stderr } = await run(
    process.execPath,
    [
      "--max-old-space-size=256",
      "--expose-gc",
      "--import",
      "tsx",
      "scripts/reproduce-timeline-retention.ts",
      "--updates=300",
      "--chunk-units=128",
      "--max-retained-growth-mib=8",
    ],
    { cwd: repositoryRoot, maxBuffer: MIB, timeout: 30_000 },
  );
  expect(stderr).toBe("");
  const samples = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as MemorySample);
  function sample(stage: string): MemorySample {
    const match = samples.find((entry) => entry.stage === stage);
    if (!match) throw new Error(`Missing memory sample ${stage}: ${stdout}`);
    return match;
  }
  const baseline = sample("baseline");
  const retained = sample("retained-after-read");
  const restored = sample("checkpoint-restored");
  expect(retained.canonicalRows).toBe(609);
  expect(retained.nonPrefixChanges).toBe(3);
  expect(retained.heapUsed - baseline.heapUsed).toBeLessThan(8 * MIB);
  // Both original and restored stores are live here, plus the parsed compact
  // checkpoint. Repeated-prefix retention formerly exceeds this budget once.
  expect(restored.heapUsed - baseline.heapUsed).toBeLessThan(16 * MIB);
  expect(restored.canonicalRows).toBe(retained.canonicalRows);
  expect(restored.checkpointBytes).toBeGreaterThan(0);
  // A compact checkpoint must not serialize the expanded historical strings.
  // logicalLogUnits counts UTF-16 code units, so this allows half their raw bytes.
  expect(restored.checkpointBytes).toBeLessThan(restored.logicalLogUnits);
});
