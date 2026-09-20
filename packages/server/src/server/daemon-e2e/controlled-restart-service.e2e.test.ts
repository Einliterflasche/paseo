import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, onTestFinished, test } from "vitest";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const logger = pino({ level: "silent" });

test("a running workspace service is relaunched by controlled restart recovery", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-restart-service-"));
  const paseoHome = path.join(home, ".paseo");
  const workspace = path.join(home, "workspace");
  const workspaceId = "restart-service-workspace";
  await mkdir(workspace);
  const timestamp = "2026-09-20T00:00:00.000Z";
  await new FileBackedProjectRegistry(
    path.join(paseoHome, "projects/projects.json"),
    logger,
  ).upsert(
    createPersistedProjectRecord({
      projectId: "restart-service-project",
      rootPath: workspace,
      kind: "non_git",
      displayName: "Restart service",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await new FileBackedWorkspaceRegistry(
    path.join(paseoHome, "projects/workspaces.json"),
    logger,
  ).upsert(
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "restart-service-project",
      cwd: workspace,
      kind: "directory",
      displayName: "Restart service",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await writeFile(
    path.join(workspace, "service.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('service-pid.txt', String(process.pid)); setInterval(() => {}, 60_000);\n",
  );
  await writeFile(
    path.join(workspace, "paseo.json"),
    JSON.stringify({
      scripts: {
        demo: { type: "service", command: `${process.execPath} service.mjs` },
      },
    }),
  );

  const launch = async () => {
    const daemon = await createTestPaseoDaemon({ paseoHomeRoot: home, cleanup: false });
    onTestFinished(() => daemon.close());
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      reconnect: { enabled: false },
    });
    onTestFinished(() => client.close());
    await client.connect();
    return { daemon, client };
  };

  const first = await launch();
  expect(first.client.getLastServerInfoMessage()?.restartCheckpointFormat).toBe(4);
  const started = await first.client.startWorkspaceScriptWithStatus(workspaceId, "demo");
  expect(started.error).toBeNull();
  expect(started.script?.terminalId).toBeTruthy();
  const firstTerminalId = started.script!.terminalId!;
  await expect.poll(() => readFile(path.join(workspace, "service-pid.txt"), "utf8")).toMatch(/\d+/);
  const firstPid = await readFile(path.join(workspace, "service-pid.txt"), "utf8");

  const checkpoint = await first.client.prepareRestart();
  const saved = JSON.parse(
    await readFile(
      path.join(paseoHome, "restart-checkpoints", checkpoint.generationId!, "snapshot.json"),
      "utf8",
    ),
  ) as { version: number; services: unknown };
  expect(saved).toMatchObject({
    version: 4,
    services: [{ workspaceId, scriptName: "demo" }],
  });
  await first.client.close();
  await first.daemon.close();

  const second = await launch();
  await expect
    .poll(async () => {
      const listed = await second.client.listWorkspaceScripts(workspaceId);
      return listed.scripts.find((script) => script.scriptName === "demo");
    })
    .toMatchObject({ lifecycle: "running", type: "service" });
  const restored = (await second.client.listWorkspaceScripts(workspaceId)).scripts.find(
    (script) => script.scriptName === "demo",
  );
  expect(restored?.terminalId).toBeTruthy();
  expect(restored?.terminalId).not.toBe(firstTerminalId);
  await expect
    .poll(() => readFile(path.join(workspace, "service-pid.txt"), "utf8"))
    .not.toBe(firstPid);
  expect(second.client.getLastServerInfoMessage()).toMatchObject({
    restartRecoveryState: "running",
    restartRecoveryGeneration: checkpoint.generationId,
  });
}, 30_000);
