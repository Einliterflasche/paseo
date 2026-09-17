import { test as base, expect, type Page } from "@playwright/test";
import {
  startOnboardingDaemon,
  startStandaloneWebUi,
  type OnboardingServer,
} from "../support/helpers/daemon-web-onboarding";

const PASSWORD = "isolated-onboarding-test-password";

const test = base.extend<
  {},
  {
    protectedHost: OnboardingServer;
    openHost: OnboardingServer;
    standalone: Awaited<ReturnType<typeof startStandaloneWebUi>>;
  }
>({
  protectedHost: [
    // Playwright requires destructuring even for a fixture without dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const host = await startOnboardingDaemon({ password: PASSWORD, tls: true });
      try {
        await provide(host);
      } finally {
        await host.close();
      }
    },
    { scope: "worker" },
  ],
  openHost: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const host = await startOnboardingDaemon({ tls: false });
      try {
        await provide(host);
      } finally {
        await host.close();
      }
    },
    { scope: "worker" },
  ],
  standalone: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const host = await startStandaloneWebUi();
      try {
        await provide(host);
      } finally {
        await host.close();
      }
    },
    { scope: "worker" },
  ],
});

const browserLogs = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  // A standalone browser may probe localhost. Never let a test touch a live daemon.
  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767)\b/, (socket) =>
    socket.close({ code: 1008, reason: "Live daemon blocked in test" }),
  );
  const messages: string[] = [];
  browserLogs.set(page, messages);
  page.on("console", (message) => messages.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => messages.push(error.stack ?? error.message));
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach("browser-console", {
      body: (browserLogs.get(page) ?? []).join("\n"),
      contentType: "text/plain",
    });
  }
});

async function expectOpenProject(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/open-project(?:\?.*)?$/);
  await expect(page.getByTestId("same-origin-login")).toHaveCount(0);
}

async function expectHighlightTheme(page: Page, origin: string, label: string): Promise<void> {
  await page.goto(`${origin}/settings/appearance`);
  await expect(page.getByLabel(`Highlight theme: ${label}`, { exact: true })).toBeVisible();
}

test("HTTPS daemon asks only for its password, permits retry, and remembers the connection", async ({
  page,
  protectedHost,
}, testInfo) => {
  const webSocketOrigins: string[] = [];
  page.on("websocket", (socket) => webSocketOrigins.push(new URL(socket.url()).origin));
  await page.goto(protectedHost.origin);
  await expect(page.getByTestId("same-origin-login")).toBeVisible();
  await expect(page.getByTestId("same-origin-login")).toContainText(protectedHost.origin);
  await expect(page.getByTestId("welcome-direct-connection")).toHaveCount(0);
  await expect(page.getByTestId("welcome-paste-pairing-link")).toHaveCount(0);
  await expect(page.getByTestId("same-origin-password-input")).toHaveAttribute("type", "password");
  await page.screenshot({ path: testInfo.outputPath("password-prompt-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("same-origin-connect")).toBeVisible();
  await expect(page.getByTestId("same-origin-other-host")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("password-prompt-mobile.png") });

  await page.getByTestId("same-origin-password-input").fill("incorrect-password");
  await page.getByTestId("same-origin-connect").click();
  await expect(page.getByTestId("same-origin-error")).toBeVisible();
  await expect(page.getByTestId("same-origin-error")).toContainText(
    /password|authentication|unauthorized/i,
  );
  await expect(page.getByTestId("same-origin-password-input")).toBeEnabled();
  await expect(page.getByTestId("same-origin-connect")).toBeEnabled();

  await page.getByTestId("same-origin-password-input").fill(PASSWORD);
  await page.getByTestId("same-origin-connect").click();
  await expectOpenProject(page);
  await page.reload();
  await expectOpenProject(page);
  expect([...new Set(webSocketOrigins)]).toEqual([protectedHost.origin.replace("https:", "wss:")]);
  await expectHighlightTheme(page, protectedHost.origin, "Catppuccin");
  await testInfo.attach("isolated-daemon-home", {
    body: protectedHost.home,
    contentType: "text/plain",
  });
});

test("password prompt retains the option to connect to another host", async ({
  page,
  protectedHost,
}) => {
  await page.goto(protectedHost.origin);
  await page.getByTestId("same-origin-other-host").click();
  await expect(page.getByTestId("welcome-direct-connection")).toBeVisible();
  await expect(page.getByTestId("welcome-paste-pairing-link")).toBeVisible();
  await page.getByTestId("welcome-this-server").click();
  await expect(page.getByTestId("same-origin-password-input")).toBeVisible();
  await expect(page.getByTestId("same-origin-address")).toHaveText(protectedHost.origin);
});

test("a connection failure keeps the server address and allows retry", async ({
  page,
  protectedHost,
}) => {
  await page.goto(protectedHost.origin);
  await expect(page.getByTestId("same-origin-login")).toBeVisible();
  await page.getByTestId("same-origin-password-input").fill(PASSWORD);
  protectedHost.setAvailable(false);
  try {
    await page.getByTestId("same-origin-connect").click();
    await expect(page.getByTestId("same-origin-error")).toBeVisible();
    await expect(page.getByTestId("same-origin-error")).toContainText(
      /connect|connection|timed out/i,
    );
    await expect(page.getByTestId("same-origin-error")).not.toContainText(/incorrect password/i);
    await expect(page.getByTestId("same-origin-address")).toHaveText(protectedHost.origin);
    await expect(page.getByTestId("same-origin-connect")).toBeEnabled();
  } finally {
    protectedHost.setAvailable(true);
  }
  await page.getByTestId("same-origin-connect").click();
  await expectOpenProject(page);
});

test("HTTP daemon without a password connects automatically", async ({ page, openHost }) => {
  const webSocketOrigins: string[] = [];
  page.on("websocket", (socket) => webSocketOrigins.push(new URL(socket.url()).origin));
  await page.goto(openHost.origin);
  await expectOpenProject(page);
  expect([...new Set(webSocketOrigins)]).toEqual([openHost.origin.replace("http:", "ws:")]);
});

test("standalone web UI retains manual connection setup", async ({ page, standalone }) => {
  await page.goto(standalone.origin);
  await expect(page.getByTestId("welcome-direct-connection")).toBeVisible();
  await expect(page.getByTestId("welcome-paste-pairing-link")).toBeVisible();
  await expect(page.getByTestId("same-origin-login")).toHaveCount(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`fresh ${colorScheme} browser defaults to Catppuccin highlighting`, async ({
    page,
    openHost,
  }) => {
    await page.emulateMedia({ colorScheme });
    await expectHighlightTheme(page, openHost.origin, "Catppuccin");
    await expect(page.getByLabel("Theme: System", { exact: true })).toBeVisible();
    const preview = page.getByRole("img", {
      name: "Live preview of content typography, syntax theme, and code font",
    });
    await expect(preview.getByText("const", { exact: true }).first()).toHaveCSS(
      "color",
      colorScheme === "light" ? "rgb(136, 57, 239)" : "rgb(203, 166, 247)",
    );
  });
}

test("stored One highlighting migrates once and later choices survive reload", async ({
  page,
  openHost,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("onboarding-settings-seeded")) return;
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ theme: "pureBlack", syntaxTheme: "one" }),
    );
    sessionStorage.setItem("onboarding-settings-seeded", "1");
  });
  await expectHighlightTheme(page, openHost.origin, "Catppuccin");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}").theme,
    ),
  ).toBe("pureBlack");
  await page.getByLabel("Highlight theme: Catppuccin", { exact: true }).click();
  await page.getByRole("menuitem", { name: "One", exact: true }).click();
  await expect(page.getByLabel("Highlight theme: One", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Highlight theme: One", { exact: true })).toBeVisible();
});

test("a saved highlighting choice other than One is preserved", async ({ page, openHost }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ theme: "light", syntaxTheme: "dracula" }),
    );
  });
  await expectHighlightTheme(page, openHost.origin, "Dracula");
});
