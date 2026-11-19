import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { cleanupServiceCgroup, openServiceCgroup } from "./service-cgroup-cleanup.js";
import { systemProcessTreeInspection } from "./process-tree-inspection.js";

const execFileAsync = promisify(execFile);

test("a real service cgroup cleans reparented and stuck children without touching another unit", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-cgroup-proof-"));
  const unit = `paseo-shutdown-proof-${process.pid}.service`;
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  const worker = path.join(home, "worker.mjs");
  const childSource = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        fs.writeFileSync(process.argv[1]+".term", "received");
        if (process.argv[2] === "false") process.exit(0);
      });
      fs.writeFileSync(process.argv[1], String(process.pid));
      process.send("ready");
      setInterval(()=>{},1000);
  `;
  await writeFile(
    worker,
    `
    import { spawn } from "node:child_process";
    const children = [false, true].map(stuck => spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}, ${JSON.stringify(home)}+(stuck?"/stuck":"/graceful"), String(stuck)], { stdio:["ignore","ignore","ignore","ipc"], detached:true }));
    children.forEach(child=>child.unref());
    // Exit before cleanup so both children have already lost their launch parent.
    Promise.all(children.map(child=>new Promise(resolve=>child.once("message",resolve)))).then(()=>process.exit(0));
  `,
  );
  try {
    await execFileAsync("sudo", [
      "systemd-run",
      `--unit=${unit}`,
      "--uid=agent",
      "--property=Type=exec",
      "--property=KillMode=mixed",
      "--property=SendSIGKILL=no",
      "--property=TimeoutStopSec=infinity",
      "--",
      process.execPath,
      worker,
    ]);
    await expect
      .poll(async () =>
        (
          await execFileAsync("systemctl", ["show", unit, "-p", "MainPID", "--value"])
        ).stdout.trim(),
      )
      .toBe("0");
    const graceful = Number(await readFile(path.join(home, "graceful"), "utf8"));
    const stuck = Number(await readFile(path.join(home, "stuck"), "utf8"));
    const group = await openServiceCgroup(`/system.slice/${unit}`, []);
    expect((await group.members()).map((identity) => identity.pid).sort()).toEqual(
      [graceful, stuck].sort(),
    );
    expect((await systemProcessTreeInspection.read(stuck, 1000))?.parentPid).toBe(1);
    const unrelatedIdentity = await systemProcessTreeInspection.read(unrelated.pid!, 1000);
    expect(unrelatedIdentity?.stopped).toBe(false);
    await group.signal(unrelatedIdentity!, "SIGKILL");
    const stuckIdentity = (await group.members()).find((identity) => identity.pid === stuck)!;
    await group.signal({ ...stuckIdentity, created: "reused-pid" }, "SIGKILL");
    const excluded = await openServiceCgroup(`/system.slice/${unit}`, [stuck]);
    expect((await excluded.members()).map((identity) => identity.pid)).toEqual([graceful]);
    await excluded.signal(stuckIdentity, "SIGKILL");
    expect((await systemProcessTreeInspection.read(stuck, 1000))?.stopped).toBe(false);
    await cleanupServiceCgroup(group, 300);
    expect(await group.members()).toEqual([]);
    expect(await readFile(path.join(home, "graceful.term"), "utf8")).toBe("received");
    expect(await readFile(path.join(home, "stuck.term"), "utf8")).toBe("received");
    expect((await systemProcessTreeInspection.read(unrelated.pid!, 1000))?.stopped).toBe(false);
  } finally {
    unrelated.kill("SIGKILL");
    // This cleanup targets only the isolated test unit, including on an assertion failure.
    await execFileAsync("sudo", ["systemctl", "kill", "--signal=SIGKILL", unit]).catch(() => {});
    await execFileAsync("sudo", ["systemctl", "stop", unit]).catch(() => {});
  }
}, 15_000);
