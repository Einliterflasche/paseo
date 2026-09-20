import { describe, expect, it, vi } from "vitest";
import { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import { WorkspaceServiceRestoration } from "./workspace-service-restoration.js";

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

    const owner = new WorkspaceServiceRestoration(
      runtime,
      vi.fn(),
      vi.fn(async () => undefined),
    );

    expect(owner.capture()).toEqual([
      { workspaceId: "workspace-a", scriptName: "api" },
      { workspaceId: "workspace-b", scriptName: "web" },
    ]);
  });

  it("rolls back partial restoration while retaining retry intent", async () => {
    const runtime = new WorkspaceScriptRuntimeStore();
    const launch = vi
      .fn()
      .mockResolvedValueOnce({ terminalId: "terminal-api" })
      .mockRejectedValueOnce(new Error("web failed"))
      .mockResolvedValueOnce({ terminalId: "terminal-api-retry" })
      .mockResolvedValueOnce({ terminalId: "terminal-web-retry" });
    const stopTerminal = vi.fn(async () => undefined);
    const owner = new WorkspaceServiceRestoration(runtime, launch, stopTerminal);
    const snapshot = [
      { workspaceId: "workspace-a", scriptName: "api" },
      { workspaceId: "workspace-b", scriptName: "web" },
    ];

    owner.install(snapshot);
    await expect(owner.resume()).rejects.toThrow("web failed");
    expect(stopTerminal).toHaveBeenCalledWith("terminal-api");
    expect(owner.capture()).toEqual(snapshot);

    await owner.resume();
    expect(launch).toHaveBeenCalledTimes(4);
    owner.finalize();
    expect(owner.capture()).toEqual([]);
  });

  it("rejects duplicate checkpoint identities before launching", () => {
    const owner = new WorkspaceServiceRestoration(
      new WorkspaceScriptRuntimeStore(),
      vi.fn(),
      vi.fn(async () => undefined),
    );

    expect(() =>
      owner.install([
        { workspaceId: "workspace-a", scriptName: "api" },
        { workspaceId: "workspace-a", scriptName: "api" },
      ]),
    ).toThrow("Duplicate workspace service");
  });
});
