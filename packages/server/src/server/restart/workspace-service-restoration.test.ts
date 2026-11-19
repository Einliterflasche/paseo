import { describe, expect, it, vi } from "vitest";
import { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import type { WorkspaceServiceIdentity } from "./workspace-service-checkpoint.js";
import {
  WorkspaceServiceRelaunchError,
  WorkspaceServiceRestoration,
} from "./workspace-service-restoration.js";

describe("WorkspaceServiceRestoration", () => {
  it("captures only running services with stable ordering", () => {
    const runtime = new WorkspaceScriptRuntimeStore();
    runtime.set({
      workspaceId: "workspace-b",
      scriptName: "web",
      type: "service",
      lifecycle: "running",
      terminalId: "terminal-b",
      exitCode: null,
    });
    runtime.set({
      workspaceId: "workspace-a",
      scriptName: "task",
      type: "script",
      lifecycle: "running",
      terminalId: "terminal-task",
      exitCode: null,
    });
    runtime.set({
      workspaceId: "workspace-a",
      scriptName: "api",
      type: "service",
      lifecycle: "running",
      terminalId: "terminal-a",
      exitCode: null,
    });

    const owner = new WorkspaceServiceRestoration(runtime, vi.fn(), vi.fn());

    expect(owner.capture()).toEqual([
      { workspaceId: "workspace-a", scriptName: "api" },
      { workspaceId: "workspace-b", scriptName: "web" },
    ]);
  });

  it("reports a failed launch as step service, skips it, and launches the other services", async () => {
    const launchFailure = new Error("web failed");
    const launch = vi.fn(async (identity: WorkspaceServiceIdentity) => {
      if (identity.scriptName === "web") throw launchFailure;
      return { terminalId: `terminal-${identity.scriptName}` };
    });
    const failures: { step: string; error: unknown }[] = [];
    const owner = new WorkspaceServiceRestoration(
      new WorkspaceScriptRuntimeStore(),
      launch,
      (step, error) => {
        failures.push({ step, error });
      },
    );
    const snapshot = [
      { workspaceId: "workspace-a", scriptName: "api" },
      { workspaceId: "workspace-b", scriptName: "web" },
      { workspaceId: "workspace-c", scriptName: "worker" },
    ];

    owner.install(snapshot);
    await expect(owner.resume()).resolves.toBeUndefined();

    expect(launch.mock.calls).toEqual(snapshot.map((identity) => [identity]));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.step).toBe("service");
    expect(failures[0]!.error).toBeInstanceOf(WorkspaceServiceRelaunchError);
    expect(failures[0]!.error).toMatchObject({
      identity: { workspaceId: "workspace-b", scriptName: "web" },
      cause: launchFailure,
    });
  });

  it("captures the installed services until resume ends, then the running services", async () => {
    const launched = Promise.withResolvers<{ terminalId: string }>();
    const owner = new WorkspaceServiceRestoration(
      new WorkspaceScriptRuntimeStore(),
      () => launched.promise,
      vi.fn(),
    );
    const snapshot = [{ workspaceId: "workspace-a", scriptName: "api" }];

    owner.install(snapshot);
    const resuming = owner.resume();
    expect(owner.capture()).toEqual(snapshot);
    launched.resolve({ terminalId: "terminal-api" });
    await resuming;

    expect(owner.capture()).toEqual([]);
  });

  it("rejects duplicate checkpoint identities before launching", () => {
    const owner = new WorkspaceServiceRestoration(
      new WorkspaceScriptRuntimeStore(),
      vi.fn(),
      vi.fn(),
    );

    expect(() =>
      owner.install([
        { workspaceId: "workspace-a", scriptName: "api" },
        { workspaceId: "workspace-a", scriptName: "api" },
      ]),
    ).toThrow("Duplicate workspace service");
  });
});
