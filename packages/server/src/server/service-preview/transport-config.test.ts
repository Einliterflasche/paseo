import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { resolvePreviewTransportEnvironment } from "./transport-config.js";

const controlOrigin = "https://control.test:9443";

describe("optional preview transport environment", () => {
  it("remains absent when none of its settings are supplied", () => {
    expect(resolvePreviewTransportEnvironment({})).toBeUndefined();
  });

  it.each([
    { PASEO_SERVICES_FRONT_PORT: "8443" },
    { PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/preview.sock" },
    { PASEO_SERVICES_FRONT_PORT: "0", PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/preview.sock" },
    { PASEO_SERVICES_FRONT_PORT: "65536", PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/preview.sock" },
    { PASEO_SERVICES_FRONT_PORT: "8e3", PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/preview.sock" },
    { PASEO_SERVICES_FRONT_PORT: "8443", PASEO_SERVICES_GATEWAY_SOCKET: "preview.sock" },
    { PASEO_SERVICES_FRONT_PORT: "8443", PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/{preview}.sock" },
    { PASEO_SERVICES_FRONT_PORT: "8443", PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/preview\0.sock" },
  ])("retains explicit invalid configuration as a closed feature marker: %j", (env) => {
    expect(
      resolvePreviewTransportEnvironment({ PASEO_SERVICES_CONTROL_ORIGIN: controlOrigin, ...env }),
    ).toEqual({ status: "invalid" });
  });

  it("retains an origin-only or missing-origin opt-in as invalid instead of dropping the control guard", () => {
    expect(
      resolvePreviewTransportEnvironment({ PASEO_SERVICES_CONTROL_ORIGIN: controlOrigin }),
    ).toEqual({ status: "invalid" });
    expect(
      resolvePreviewTransportEnvironment({
        PASEO_SERVICES_FRONT_PORT: "8443",
        PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/preview.sock",
      }),
    ).toEqual({ status: "invalid" });
  });

  it.each([
    "http://control.test",
    "https://control.test/",
    "https://control.test/path",
    "https://control.test?query=1",
    "https://control.test#fragment",
    "https://user:secret@control.test",
    "https://control.test:443",
    "not-an-origin",
  ])("refuses noncanonical or non-HTTPS startup authority %s", (value) => {
    expect(
      resolvePreviewTransportEnvironment({
        PASEO_SERVICES_FRONT_PORT: "8443",
        PASEO_SERVICES_GATEWAY_SOCKET: "/tmp/preview.sock",
        PASEO_SERVICES_CONTROL_ORIGIN: value,
      }),
    ).toEqual({ status: "invalid" });
  });

  it("uses the complete explicit environment without persisting feature fields into core config", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-preview-transport-"));
    const file = path.join(paseoHome, "config.json");
    const content = `${JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:7000", relay: { enabled: false } } })}\n`;
    await writeFile(file, content);
    const env = {
      PASEO_SERVICES_FRONT_PORT: "8443",
      PASEO_SERVICES_GATEWAY_SOCKET: path.join(paseoHome, "gateway.sock"),
      PASEO_SERVICES_CONTROL_ORIGIN: controlOrigin,
    };
    const configured = loadConfig(paseoHome, { env });
    expect(configured.servicePreviewTransport).toEqual({
      status: "configured",
      frontPort: 8443,
      gatewaySocketPath: env.PASEO_SERVICES_GATEWAY_SOCKET,
      controlOrigin,
    });
    expect(configured.listen).toBe("127.0.0.1:7000");
    expect(configured.configReload?.env).toEqual(env);
    expect(configured.configReload?.startupPersisted).not.toHaveProperty("servicePreviewTransport");
    expect(loadConfig(paseoHome, { env: {} }).servicePreviewTransport).toBeUndefined();
    expect(
      loadConfig(paseoHome, { env: { PASEO_SERVICES_FRONT_PORT: "bad" } }).servicePreviewTransport,
    ).toEqual({ status: "invalid" });
    expect(await readFile(file, "utf8")).toBe(content);
    expect(await readdir(paseoHome)).toEqual(["config.json"]);
  });
});
