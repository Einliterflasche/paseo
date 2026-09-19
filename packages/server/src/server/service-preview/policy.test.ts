import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { managedPreviewServiceId, readPreviewFeaturePolicy } from "./policy.js";

const service = {
  workspaceId: "workspace-a",
  scriptName: "web",
  name: "React page",
  mount: "preserve" as const,
};
const enabled = {
  version: 1,
  enabled: true,
  controlOrigin: "https://control.test",
  managedServices: [service],
};

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-preview-policy-"));
  const directory = path.join(home, "services");
  const file = path.join(directory, "policy-v1.json");
  return {
    home,
    directory,
    file,
    async write(content: string) {
      await mkdir(directory, { recursive: true });
      await writeFile(file, content, "utf8");
    },
  };
}

describe("preview feature policy", () => {
  it("keeps missing policy disabled without creating files or directories", async () => {
    const f = await fixture();
    expect(await readPreviewFeaturePolicy(f.home)).toEqual({ version: 1, enabled: false });
    expect(await readdir(f.home)).toEqual([]);
  });

  it("reads disabled policy verbatim without rewriting it", async () => {
    const f = await fixture();
    const content = '{ "version": 1, "enabled": false }\n';
    await f.write(content);
    expect(await readPreviewFeaturePolicy(f.home)).toEqual({ version: 1, enabled: false });
    expect(await readFile(f.file, "utf8")).toBe(content);
  });

  it("returns fresh parsed enrollment snapshots and preserves the stored source", async () => {
    const f = await fixture();
    const stored = {
      ...enabled,
      managedServices: [
        { ...service, name: "  React page  " },
        { ...service, scriptName: "docs" },
        { ...service, workspaceId: "workspace-b" },
      ],
    };
    const content = `${JSON.stringify(stored, null, 2)}\n`;
    await f.write(content);
    const first = await readPreviewFeaturePolicy(f.home);
    if (!first.enabled) throw new Error("Expected enabled policy");
    expect(first.managedServices[0].name).toBe("React page");
    first.managedServices[0].name = "Changed local copy";
    first.managedServices.splice(1);
    const next = await readPreviewFeaturePolicy(f.home);
    expect(next).toEqual({
      ...enabled,
      managedServices: [
        service,
        { ...service, scriptName: "docs" },
        { ...service, workspaceId: "workspace-b" },
      ],
    });
    expect(await readFile(f.file, "utf8")).toBe(content);
  });

  it.each(["https://control.test", "https://control.test:8443", "https://[::1]:9443"])(
    "accepts exact HTTPS origin %s",
    async (controlOrigin) => {
      const f = await fixture();
      await f.write(JSON.stringify({ ...enabled, controlOrigin }));
      expect(await readPreviewFeaturePolicy(f.home)).toMatchObject({
        enabled: true,
        controlOrigin,
      });
    },
  );

  it.each([
    "http://control.test",
    "https://control.test/",
    "https://control.test/services",
    "https://control.test?preview=1",
    "https://control.test#preview",
    "https://fixture:credential@control.test",
    "https://control.test:443",
    "https://CONTROL.test",
    " control.test ",
  ])(
    "rejects an inexact or unsupported origin without touching its file: %s",
    async (controlOrigin) => {
      const f = await fixture();
      const content = JSON.stringify({ ...enabled, controlOrigin });
      await f.write(content);
      await expect(readPreviewFeaturePolicy(f.home)).rejects.toMatchObject({
        code: "invalid-policy",
      });
      expect(await readFile(f.file, "utf8")).toBe(content);
    },
  );

  it.each([
    ["unknown version", { ...enabled, version: 2 }],
    ["unknown enabled field", { ...enabled, autoConnect: true }],
    [
      "unknown disabled field",
      { version: 1, enabled: false, controlOrigin: "https://control.test" },
    ],
    ["missing origin", { version: 1, enabled: true, managedServices: [] }],
    ["unknown enrollment field", { ...enabled, managedServices: [{ ...service, port: 5173 }] }],
    ["invalid mount", { ...enabled, managedServices: [{ ...service, mount: "automatic" }] }],
    ["blank workspace", { ...enabled, managedServices: [{ ...service, workspaceId: "" }] }],
    ["blank display name", { ...enabled, managedServices: [{ ...service, name: "  " }] }],
    [
      "duplicate identity",
      { ...enabled, managedServices: [service, { ...service, name: "Other" }] },
    ],
    ["null root", null],
  ])("preserves rejected %s data byte-for-byte", async (_name, policy) => {
    const f = await fixture();
    const content = `${JSON.stringify(policy, null, 2)}\n`;
    await f.write(content);
    await expect(readPreviewFeaturePolicy(f.home)).rejects.toMatchObject({
      code: "invalid-policy",
    });
    expect(await readFile(f.file, "utf8")).toBe(content);
  });

  it("distinguishes malformed JSON from a storage error and preserves both paths", async () => {
    const invalid = await fixture();
    const content = '{ "version": 1, '; // Deliberately interrupted input.
    await invalid.write(content);
    await expect(readPreviewFeaturePolicy(invalid.home)).rejects.toMatchObject({
      code: "invalid-policy",
    });
    expect(await readFile(invalid.file, "utf8")).toBe(content);
    const obstructed = await fixture();
    await mkdir(obstructed.file, { recursive: true });
    await expect(readPreviewFeaturePolicy(obstructed.home)).rejects.toMatchObject({
      code: "storage-error",
    });
    expect(await readdir(obstructed.file)).toEqual([]);
  });

  it("keeps routing identity tied to the workspace/script tuple rather than presentation or mount settings", () => {
    const renamed = { ...service, name: "Renamed page", mount: "strip" as const };
    const id = managedPreviewServiceId(service);
    expect(managedPreviewServiceId(renamed)).toBe(id);
    expect(managedPreviewServiceId({ ...service, workspaceId: "workspace-b" })).not.toBe(id);
    expect(managedPreviewServiceId({ ...service, scriptName: "docs" })).not.toBe(id);
    expect(managedPreviewServiceId({ workspaceId: "a:b", scriptName: "c" })).not.toBe(
      managedPreviewServiceId({ workspaceId: "a", scriptName: "b:c" }),
    );
    expect(id).toMatch(/^managed-[a-f0-9]+$/);
  });
});
