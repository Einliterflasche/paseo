import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const MIB = 1024 * 1024;
interface Sample {
  stage: string;
  heapUsed: number;
  logicalLogUnits: number;
  longestLogUnits: number;
  finished: boolean;
  exactReturnedRows?: number;
  canonicalRows?: number;
  runCount?: number;
}

test.each(["direct", "schedule"])(
  "%s run retains canonical logs during execution and returns exact versions",
  async (mode) => {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--max-old-space-size=256",
        "--expose-gc",
        "--import",
        "tsx",
        "scripts/reproduce-manager-retention.mts",
        `--mode=${mode}`,
        "--updates=600",
        "--chunk-units=256",
        "--max-retained-growth-mib=24",
      ],
      { cwd: repositoryRoot, maxBuffer: MIB, timeout: 60_000 },
    );
    expect(stderr).toBe("");
    const samples = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Sample);
    function sample(stage: string): Sample {
      const found = samples.find((value) => value.stage === stage);
      if (!found) throw new Error(`Missing ${stage}: ${stdout}`);
      return found;
    }
    const baseline = sample("active-baseline");
    const active = sample("active-retained");
    expect(active.finished).toBe(false);
    expect(active.logicalLogUnits).toBeGreaterThan(40 * MIB);
    expect(active.longestLogUnits).toBeLessThan(MIB);
    expect(active.heapUsed - baseline.heapUsed).toBeLessThan(24 * MIB);
    const verified = sample("verified");
    expect(verified.runCount).toBe(1);
    expect(verified.exactReturnedRows).toBe(602);
    expect(verified.canonicalRows).toBe(602);
  },
);
