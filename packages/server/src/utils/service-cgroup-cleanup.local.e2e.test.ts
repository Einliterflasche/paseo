import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { cleanupServiceCgroup, openServiceCgroup } from "./service-cgroup-cleanup.js";
import { systemProcessTreeInspection } from "./process-tree-inspection.js";
import { CheckpointStore } from "../server/restart/checkpoint-store.js";
import { spawnDeployActivation } from "../../../cli/src/commands/daemon/deploy.js";
import { DaemonCheckpointSchema } from "../server/restart/daemon-checkpoint.js";

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

test("a privileged prepared transition removes root-owned survivors before stopping an old supervisor", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-old-unit-proof-"));
  const unit = `paseo-old-shutdown-proof-${process.pid}.service`;
  const keeper = `paseo-old-shutdown-keeper-${process.pid}.service`;
  const store = new CheckpointStore(home, (value) => DaemonCheckpointSchema.parse(value));
  const { generationId } = await store.commit({
    version: 4,
    agents: { agents: [], timelines: {}, children: [] },
    notifications: [],
    schedules: { runs: [] },
    services: [],
  });
  const worker = path.join(home, "worker.mjs");
  const supervisor = path.join(home, "supervisor.mjs");
  const cleanup = path.join(home, "cleanup.mjs");
  const rootPidFile = path.join(home, "root-pid");
  const rootSource = `
    const fs=require("node:fs");
    process.on("SIGTERM",()=>fs.writeFileSync(${JSON.stringify(path.join(home, "root-term"))}, "received"));
    fs.writeFileSync(${JSON.stringify(rootPidFile)},String(process.pid));
    setInterval(()=>{},1000);
  `;
  await writeFile(
    worker,
    `
    import {spawn} from "node:child_process";
    import {writeFileSync} from "node:fs";
    import {openServiceCgroup} from ${JSON.stringify(new URL("../../dist/src/utils/service-cgroup-cleanup.js", import.meta.url).href)};
    try { await openServiceCgroup(${JSON.stringify(`/system.slice/${unit}`)},[],true); throw new Error("Executor refusal missing"); }
    catch(error) {if(!error.message.includes("must be outside")) throw error; writeFileSync(${JSON.stringify(path.join(home, "inside-refusal"))},"refused");}
    const root = spawn("sudo",["-n",process.execPath,"-e",${JSON.stringify(rootSource)}],{stdio:"ignore",detached:true});
    root.unref();
    process.on("message",message=>{if(message.type==="paseo:graceful-shutdown") process.exit(0);});
    process.send({type:"paseo:ready",listen:"fixture",serverId:"fixture"});
    setInterval(()=>{},1000);
  `,
  );
  await writeFile(
    supervisor,
    `
    import {writeFileSync} from "node:fs";
    import {hostname} from "node:os";
    import {runSupervisor} from ${JSON.stringify(new URL("../../dist/scripts/supervisor.js", import.meta.url).href)};
    writeFileSync(${JSON.stringify(path.join(home, "paseo.pid"))}, JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),hostname:hostname(),uid:process.getuid(),listen:"fixture"}));
    runSupervisor({name:"OldPackage",startupMessage:"old package fixture",resolveWorkerEntry:()=>${JSON.stringify(worker)},workerArgs:[],workerExecArgv:[],
      onWorkerReady:()=>writeFileSync(${JSON.stringify(path.join(home, "ready"))},"ready")});
  `,
  );
  try {
    await execFileAsync(
      "sudo",
      [
        "systemd-run",
        `--unit=${unit}`,
        "--uid=agent",
        `--setenv=PATH=${process.env.PATH}`,
        `--working-directory=${process.cwd()}`,
        "--property=Type=exec",
        "--property=KillMode=mixed",
        "--property=SendSIGKILL=no",
        "--property=TimeoutStopSec=infinity",
        "--",
        process.execPath,
        supervisor,
      ],
      { cwd: process.cwd() },
    );
    await expect.poll(async () => readFile(path.join(home, "ready"), "utf8")).toBe("ready");
    await expect.poll(async () => readFile(rootPidFile, "utf8")).not.toBe("");
    const ownedRootPid = Number(await readFile(rootPidFile, "utf8"));
    expect(await readFile(`/proc/${ownedRootPid}/status`, "utf8")).toMatch(/Uid:\s+0\s+0\s+0\s+0/);
    expect(await readFile(path.join(home, "inside-refusal"), "utf8")).toBe("refused");
    // A live Wants reference retains the transient unit's old exit metadata.
    await execFileAsync("sudo", [
      "systemd-run",
      `--unit=${keeper}`,
      "--uid=agent",
      `--property=Wants=${unit}`,
      "--",
      process.execPath,
      "-e",
      "setInterval(()=>{},1000)",
    ]);
    const { stdout: invocation } = await execFileAsync("systemctl", [
      "show",
      unit,
      "-p",
      "InvocationID",
      "--value",
    ]);
    await writeFile(
      cleanup,
      `
      import {writeFile} from "node:fs/promises";
      import {cleanupPreparedService,certifyStoppedService,inspectPreparedService} from ${JSON.stringify(new URL("../../dist/scripts/cleanup-prepared-service.js", import.meta.url).href)};
      await cleanupPreparedService(${JSON.stringify(home)},${JSON.stringify(generationId)},${JSON.stringify(invocation.trim())},inspectPreparedService(${JSON.stringify(unit)}));
      await writeFile(${JSON.stringify(path.join(home, "cleaned"))},"cleaned");
      const {execFileSync}=await import("node:child_process");
      const {access}=await import("node:fs/promises");
      while(true) { try {await access(${JSON.stringify(path.join(home, "stop-request"))});break;}catch{await new Promise(resolve=>setTimeout(resolve,25));} }
      execFileSync("systemctl",["stop",${JSON.stringify(unit)}],{timeout:10000});
      await certifyStoppedService(${JSON.stringify(home)},${JSON.stringify(generationId)},${JSON.stringify(invocation.trim())},inspectPreparedService(${JSON.stringify(unit)}));
      await writeFile(${JSON.stringify(path.join(home, "certified"))},"certified");
    `,
    );
    await execFileAsync("sudo", [
      "systemd-run",
      `--unit=paseo-old-cleanup-proof-${process.pid}`,
      "--collect",
      `--setenv=PATH=${process.env.PATH}`,
      `--working-directory=${process.cwd()}`,
      "--",
      process.execPath,
      cleanup,
    ]);
    await expect
      .poll(async () => readFile(path.join(home, "cleaned"), "utf8"), { timeout: 20_000 })
      .toBe("cleaned");
    expect(await readFile(path.join(home, "root-term"), "utf8")).toBe("received");
    const group = await openServiceCgroup(`/system.slice/${unit}`, []);
    expect((await group.members()).length).toBe(2);
    await writeFile(path.join(home, "stop-request"), "");
    await expect
      .poll(async () => readFile(path.join(home, "certified"), "utf8"), { timeout: 15000 })
      .toBe("certified");
    expect(await group.members()).toEqual([]);
    expect((await store.peekStatus())?.claimed).toBe(false);
  } finally {
    await execFileAsync("sudo", ["systemctl", "stop", keeper]).catch(() => {});
    await execFileAsync("sudo", [
      "systemctl",
      "stop",
      `paseo-old-cleanup-proof-${process.pid}.service`,
    ]).catch(() => {});
    await execFileAsync("sudo", ["systemctl", "kill", "--signal=SIGKILL", unit]).catch(() => {});
    await execFileAsync("sudo", ["systemctl", "stop", unit]).catch(() => {});
  }
}, 35_000);

test("the default activation passes exact proof through the real NixOS sudo boundary", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-sudo-proof-"));
  const output = path.join(home, "proof.json");
  const proof = { home, generationId: "exact-prepared-generation" };
  expect(
    await spawnDeployActivation(
      [
        "/run/wrappers/bin/sudo",
        "--preserve-env=PASEO_DEPLOY_HOME,PASEO_DEPLOY_GENERATION",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({home:process.env.PASEO_DEPLOY_HOME,generationId:process.env.PASEO_DEPLOY_GENERATION}))",
        output,
      ],
      proof,
    ),
  ).toEqual({ code: 0, signal: null });
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual(proof);
});
