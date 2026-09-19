import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { buildHostServicesRoute, buildHostWorkspaceRoute } from "../../src/utils/host-routes";

// Explicit opt-in: the production bundle and ordinary runs leave the slice off.
test.skip(
  process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG === undefined,
  "Services catalog isolated opt-in run",
);

test("host and workspace catalog use existing scripts without visiting applications", async ({
  page,
}, testInfo) => {
  test.skip(process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG !== "1", "Catalog enabled run only");
  const daemon = await startIsolatedHostDaemon("services-catalog-fixture", { preserveHome: true });
  const client = await connectDaemonClient<DaemonClient>({
    port: daemon.port,
    clientIdPrefix: "services-catalog",
  });
  const fixture = await mkdtemp(path.join(tmpdir(), "paseo-services-catalog-"));
  const requests: string[] = [];
  const lifecycleRequests: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = z
        .object({ type: z.literal("session"), message: z.object({ type: z.string() }) })
        .safeParse(JSON.parse(payload));
      if (frame.success && frame.data.message.type === "workspace.script.start.request")
        lifecycleRequests.push(frame.data.message.type);
    }),
  );
  const errors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, (socket) => socket.close());
  const host = buildSeededHost({
    serverId: daemon.serverId,
    endpoint: `127.0.0.1:${daemon.port}`,
    label: "Services test host",
    nowIso: new Date().toISOString(),
  });
  await page.addInitScript((seed) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seed]));
  }, host);
  // Both script processes and every fixture HTTP listener are disposable and loopback-only.
  await writeFile(
    path.join(fixture, "app.cjs"),
    `const http = require('http'); const fs = require('fs');
http.createServer((req, res) => { fs.appendFileSync('requests.log', req.url+'\\n'); res.end('fixture'); })
.listen(Number(process.env.PASEO_PORT), '127.0.0.1', () => console.log('ready'));`,
  );
  await writeFile(
    path.join(fixture, "paseo.json"),
    JSON.stringify({
      scripts: {
        web: { type: "service", command: `${process.execPath} app.cjs` },
        docs: { type: "service", command: `${process.execPath} app.cjs` },
        tests: { type: "script", command: "echo tests" },
      },
    }),
  );
  try {
    const created = await client.createWorkspace({
      source: { kind: "directory", path: fixture },
      title: "Demo workspace",
    });
    expect(created.error).toBeNull();
    if (!created.workspace) throw new Error("Fixture workspace missing");
    const workspace = created.workspace;
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    await page.goto(origin + buildHostServicesRoute(daemon.serverId));
    const gallery = page.getByTestId("services-gallery").filter({ visible: true });
    await expect(gallery).toBeVisible();
    await expect(gallery.locator('[data-testid^="service-card-"]')).toHaveCount(2);
    await expect(gallery.getByTestId("service-start-web")).toBeEnabled();
    expect(
      (await client.listWorkspaceScripts(workspace.id)).scripts?.find(
        (script) => script.scriptName === "web",
      )?.lifecycle,
    ).toBe("stopped");
    await page.screenshot({ path: testInfo.outputPath("01-host-gallery.png") });
    await gallery.getByTestId("service-start-web").dblclick();
    await expect(gallery.getByTestId("service-stop-web")).toBeEnabled();
    const running = (await client.listWorkspaceScripts(workspace.id)).scripts?.find(
      (script) => script.scriptName === "web",
    );
    expect(running?.port).toBeTruthy();
    expect(requests.some((url) => new URL(url).port === String(running?.port))).toBe(false);
    expect(await gallery.locator("iframe").count()).toBe(0);
    // Deliberate independent probe after proving the browser did not visit it.
    await expect
      .poll(async () => {
        try {
          return await (await fetch(`http://127.0.0.1:${running?.port}`)).text();
        } catch {
          return null;
        }
      })
      .toBe("fixture");
    await gallery.getByTestId("services-list").click();
    await gallery.getByTestId("services-search").fill("web");
    await expect(gallery.locator('[data-testid^="service-card-"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("02-host-list.png") });
    await page.reload();
    await expect(gallery.getByTestId("services-list")).toHaveAttribute("aria-selected", "true");
    await expect(gallery.locator('[data-testid^="service-card-"]')).toHaveCount(2);
    await gallery.getByTestId("service-stop-web").click();
    await expect(gallery.getByTestId("service-start-web")).toBeEnabled();
    expect(
      (await client.listWorkspaceScripts(workspace.id)).scripts?.find(
        (script) => script.scriptName === "web",
      )?.lifecycle,
    ).toBe("stopped");
    await expect
      .poll(async () => {
        try {
          await fetch(`http://127.0.0.1:${running?.port}`);
          return "still listening";
        } catch {
          return "stopped";
        }
      })
      .toBe("stopped");
    await page.goto(origin + buildHostWorkspaceRoute(daemon.serverId, workspace.id));
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
    await page.getByTestId("workspace-new-tab-menu-services").click();
    await expect(page.getByTestId("services-gallery").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("services-grid").filter({ visible: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({ path: testInfo.outputPath("03-workspace-gallery.png") });
    const saved = await page.evaluate(() => localStorage.getItem("workspace-layout-state"));
    expect(saved).not.toContain('"kind":"services"');
    await page.reload();
    await expect(
      page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("workspace-layout-state")),
    ).not.toBeNull();
    await page.goto(origin + buildHostServicesRoute(daemon.serverId));
    await expect(page.getByTestId("services-gallery").filter({ visible: true })).toBeVisible();
    await daemon.close();
    await expect(
      page.getByText("Host disconnected. Showing last known state; actions are unavailable."),
    ).toBeVisible();
    await expect(page.getByTestId("service-start-web").filter({ visible: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("04-offline-gallery.png") });
    expect(lifecycleRequests).toEqual(["workspace.script.start.request"]);
    expect(errors).toEqual([]);
  } finally {
    await testInfo.attach("fixture-locations", {
      body: JSON.stringify({ home: daemon.paseoHome, fixture }),
      contentType: "application/json",
    });
    await client.close();
    await daemon.close();
    // Keep fixture files and daemon evidence for inspection.
  }
});

test("feature off keeps the existing shell and rejects the Services route", async ({ page }) => {
  test.skip(process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG !== "0", "Requires feature-off bundle");
  const daemon = await startIsolatedHostDaemon("services-off-fixture", { preserveHome: true });
  const host = buildSeededHost({
    serverId: daemon.serverId,
    endpoint: `127.0.0.1:${daemon.port}`,
    label: "Services disabled test host",
    nowIso: new Date().toISOString(),
  });
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, (socket) => socket.close());
  await page.addInitScript((seed) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seed]));
  }, host);
  try {
    await page.goto(
      `http://localhost:${process.env.E2E_METRO_PORT}${buildHostServicesRoute(daemon.serverId)}`,
    );
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByTestId("sidebar-sessions")).toBeVisible();
    await expect(page.getByTestId("sidebar-services")).toHaveCount(0);
    await expect(page.getByTestId("services-gallery")).toHaveCount(0);
  } finally {
    await daemon.close();
  }
});

test("Services navigation retains the selected host after switching hosts", async ({
  page,
}, testInfo) => {
  test.skip(process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG !== "1", "Requires enabled catalog");
  const first = await startIsolatedHostDaemon("services-host-a", { preserveHome: true });
  const second = await startIsolatedHostDaemon("services-host-b", { preserveHome: true });
  const hosts = [first, second].map((daemon, index) =>
    buildSeededHost({
      serverId: daemon.serverId,
      endpoint: `127.0.0.1:${daemon.port}`,
      label: `Host ${index + 1}`,
      nowIso: new Date().toISOString(),
    }),
  );
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, (socket) => socket.close());
  await page.addInitScript((seeds) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify(seeds));
  }, hosts);
  try {
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const expected = origin + buildHostServicesRoute(second.serverId);
    await page.goto(expected);
    await page.getByTestId("sidebar-services").click();
    await expect(page).toHaveURL(expected);
    await expect(page.getByTestId("services-gallery").filter({ visible: true })).toBeVisible();
    await page.getByRole("button", { name: "Filter: Host 2" }).click();
    await page.getByText("Host 1", { exact: true }).click();
    await expect(page).toHaveURL(origin + buildHostServicesRoute(first.serverId));
    await page.getByRole("button", { name: "Filter: Host 1" }).click();
    await page.getByText("Host 2", { exact: true }).click();
    await expect(page).toHaveURL(expected);
    await page.getByTestId("sidebar-services").click();
    await expect(page).toHaveURL(expected);
    await expect(page.getByRole("button", { name: "Filter: Host 2" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("07-host-switch.png") });
  } finally {
    await second.close();
    await first.close();
  }
});

test("automatic directory failure ends loading and explicit refresh recovers", async ({
  page,
}, testInfo) => {
  test.skip(process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG !== "1", "Requires enabled catalog");
  const daemon = await startIsolatedHostDaemon("services-failure-fixture", { preserveHome: true });
  let rejectDirectory = true;
  const requestEnvelope = z.object({
    type: z.literal("session"),
    message: z.object({ type: z.string(), requestId: z.string().optional() }),
  });
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, (socket) => socket.close());
  await page.routeWebSocket(new RegExp(`:${daemon.port}\\b`), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        server.send(message);
        return;
      }
      const parsed = requestEnvelope.safeParse(decoded);
      const request = parsed.success ? parsed.data.message : null;
      if (rejectDirectory && request?.type === "fetch_workspaces_request" && request.requestId) {
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                error: "Synthetic directory failure",
                code: "handler_error",
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  const host = buildSeededHost({
    serverId: daemon.serverId,
    endpoint: `127.0.0.1:${daemon.port}`,
    label: "Failure fixture host",
    nowIso: new Date().toISOString(),
  });
  await page.addInitScript((seed) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seed]));
  }, host);
  try {
    await page.goto(
      `http://localhost:${process.env.E2E_METRO_PORT}${buildHostServicesRoute(daemon.serverId)}`,
    );
    const gallery = page.getByTestId("services-gallery").filter({ visible: true });
    await expect(gallery.getByTestId("services-error")).toContainText(
      "Synthetic directory failure",
    );
    await expect(gallery.getByText("Loading...", { exact: true })).toHaveCount(0);
    await expect(gallery.getByText(/No services configured/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("05-directory-failure.png") });
    rejectDirectory = false;
    await gallery.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(gallery.getByTestId("services-error")).toHaveCount(0);
    await expect(gallery.getByText(/No services configured/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("06-directory-recovered.png") });
  } finally {
    await daemon.close();
  }
});

test("invalid service preferences remain stored and explicit Retry recovers", async ({
  page,
}, testInfo) => {
  test.skip(process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG !== "1", "Requires enabled catalog");
  const daemon = await startIsolatedHostDaemon("services-preferences-fixture", {
    preserveHome: true,
  });
  const host = buildSeededHost({
    serverId: daemon.serverId,
    endpoint: `127.0.0.1:${daemon.port}`,
    label: "Preferences fixture host",
    nowIso: new Date().toISOString(),
  });
  const key = `@paseo:services-preferences:v1:${JSON.stringify([daemon.serverId, null])}`;
  const invalid = JSON.stringify({ view: "future-view", preserve: true });
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, (socket) => socket.close());
  await page.addInitScript(
    (seed) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seed.host]));
      localStorage.setItem(seed.key, seed.invalid);
    },
    { host, key, invalid },
  );
  try {
    await page.goto(
      `http://localhost:${process.env.E2E_METRO_PORT}${buildHostServicesRoute(daemon.serverId)}`,
    );
    const gallery = page.getByTestId("services-gallery").filter({ visible: true });
    const error = gallery.getByTestId("services-preference-error");
    await expect(error).toContainText("Could not load the saved view.");
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBe(
      invalid,
    );
    await page.screenshot({ path: testInfo.outputPath("08-preference-error.png") });
    await page.evaluate(
      (storageKey) => localStorage.setItem(storageKey, JSON.stringify({ view: "list" })),
      key,
    );
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(error).toHaveCount(0);
    await expect(gallery.getByTestId("services-list")).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: testInfo.outputPath("09-preference-recovered.png") });
  } finally {
    await daemon.close();
  }
});

test("service preference save failure is visible and an explicit choice recovers", async ({
  page,
}, testInfo) => {
  test.skip(process.env.EXPO_PUBLIC_PASEO_SERVICES_CATALOG !== "1", "Requires enabled catalog");
  const daemon = await startIsolatedHostDaemon("services-preference-quota", { preserveHome: true });
  const host = buildSeededHost({
    serverId: daemon.serverId,
    endpoint: `127.0.0.1:${daemon.port}`,
    label: "Preferences storage fixture",
    nowIso: new Date().toISOString(),
  });
  const key = `@paseo:services-preferences:v1:${JSON.stringify([daemon.serverId, null])}`;
  await page.route(/:6767\b/, (route) => route.abort());
  await page.routeWebSocket(/:6767\b/, (socket) => socket.close());
  await page.addInitScript((seed) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seed]));
  }, host);
  try {
    await page.goto(
      `http://localhost:${process.env.E2E_METRO_PORT}${buildHostServicesRoute(daemon.serverId)}`,
    );
    const gallery = page.getByTestId("services-gallery").filter({ visible: true });
    await expect(gallery.getByTestId("services-list")).toBeEnabled();
    // Exhaust this disposable browser origin's actual quota; no Storage methods
    // or application modules are patched. The platform determines its limit.
    const quotaError = await page.evaluate(() => {
      let value = "";
      let step = 1024 * 1024;
      let name = "";
      while (step > 0) {
        try {
          const next = value + "x".repeat(step);
          localStorage.setItem("services-test-quota", next);
          value = next;
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
          name = error.name;
          step = Math.floor(step / 2);
        }
      }
      return name;
    });
    expect(quotaError).toBe("QuotaExceededError");
    await gallery.getByTestId("services-list").click();
    const error = gallery.getByTestId("services-preference-error");
    await expect(error).toContainText("Could not save the view. Choose it again to retry.");
    await expect(gallery.getByTestId("services-grid")).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBeNull();
    await page.screenshot({ path: testInfo.outputPath("10-preference-save-error.png") });
    // Replace only the synthetic quota filler, retaining the key and all app data.
    await page.evaluate(() => localStorage.setItem("services-test-quota", ""));
    await gallery.getByTestId("services-list").click();
    await expect(error).toHaveCount(0);
    await expect(gallery.getByTestId("services-list")).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBe(
      '{"view":"list"}',
    );
    await page.reload();
    await expect(gallery.getByTestId("services-list")).toHaveAttribute("aria-selected", "true");
    await expect(error).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("11-preference-save-recovered.png") });
  } finally {
    await daemon.close();
  }
});
