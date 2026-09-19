import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { serviceProcessCommand } from "./service-process.js";

const linuxOnly = isPlatform("linux") ? it : it.skip;

describe("serviceProcessCommand", () => {
  linuxOnly("wraps the command in a self-adjusting /bin/sh -c on Linux", () => {
    const wrapped = serviceProcessCommand({ command: "npm", args: ["run", "dev"] });
    expect(wrapped.command).toBe("/bin/sh");
    expect(wrapped.args[0]).toBe("-c");
    expect(wrapped.args[1]).toContain("oom_score_adj");
    expect(wrapped.args[1]).toContain("1000");
    // "$@" is expanded by the shell from argv beyond the script itself, so the
    // literal original command/args must survive positionally, unaltered.
    expect(wrapped.args.slice(2)).toEqual(["paseo-service", "npm", "run", "dev"]);
  });

  linuxOnly("rejects a string args form it cannot safely position after $0", () => {
    expect(() => serviceProcessCommand({ command: "npm", args: "run dev" })).toThrow(
      "Linux service arguments must be an array",
    );
  });

  it.skipIf(isPlatform("linux"))("passes the command through unchanged off Linux", () => {
    const input = { command: "npm", args: ["run", "dev"] };
    expect(serviceProcessCommand(input)).toEqual(input);
  });
});

// A real disposable child, loaded through the same tsx loader the preview
// gateway worker uses to run its TypeScript entrypoint directly — never the
// vitest worker's own process, and never anything touching this repo's
// actual runtime or a live daemon.
const tsxLoader = import.meta.resolve("tsx");
const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function runChildScript(body: string): { status: number | null; stdout: string } {
  const directory = mkdtempSync(join(tmpdir(), "paseo-service-process-"));
  directories.push(directory);
  const scriptPath = join(directory, "child.mts");
  const modulePath = new URL("./service-process.ts", import.meta.url).href;
  writeFileSync(
    scriptPath,
    `import { preferServiceOomKill } from ${JSON.stringify(modulePath)};\n${body}\n`,
  );
  const result = spawnSync(process.execPath, ["--import", tsxLoader, scriptPath], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

describe("preferServiceOomKill (real disposable child processes only)", () => {
  linuxOnly(
    "raises the disposable child's own score to the Linux maximum victim preference, never the caller's",
    () => {
      const before = readFileSync("/proc/self/oom_score_adj", "utf8").trim();
      const child = runChildScript(
        `import { readFileSync } from "node:fs";
         preferServiceOomKill();
         process.stdout.write(readFileSync("/proc/self/oom_score_adj", "utf8").trim());`,
      );
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe("1000");
      const after = readFileSync("/proc/self/oom_score_adj", "utf8").trim();
      expect(after).toBe(before);
    },
  );

  linuxOnly(
    "raised score survives exec/fork, so a grandchild spawned after self-adjusting still inherits it",
    () => {
      const child = runChildScript(
        `import { execSync } from "node:child_process";
         preferServiceOomKill();
         process.stdout.write(execSync("cat /proc/self/oom_score_adj").toString().trim());`,
      );
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe("1000");
    },
  );

  linuxOnly("leaves an ordinary child that never opts in at the default, unraised score", () => {
    const child = runChildScript(
      `import { readFileSync } from "node:fs";
       process.stdout.write(readFileSync("/proc/self/oom_score_adj", "utf8").trim());`,
    );
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).not.toBe("1000");
  });
});
