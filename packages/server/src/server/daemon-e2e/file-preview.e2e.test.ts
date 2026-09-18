import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-preview-"));
}

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("file access and preview grants", () => {
    test("classifies a text file with no preview grant even when requested", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "notes.txt"), "hello world", "utf-8");

      const access = await ctx.client.getFileAccess({ cwd, path: "notes.txt", preview: true });

      expect(access.error).toBeNull();
      expect(access.file).toEqual({
        path: "notes.txt",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 11,
        kind: "text",
      });
      expect(access.previewToken).toBeNull();

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("classifies an MP4 with an accurate MIME type and a usable preview grant", async () => {
      const cwd = tmpCwd();
      const bytes = Buffer.from("fake-mp4-payload-0123456789");
      writeFileSync(path.join(cwd, "clip.mp4"), bytes);

      const access = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });

      expect(access.error).toBeNull();
      expect(access.file?.kind).toBe("binary");
      expect(access.file?.mimeType).toBe("video/mp4");
      expect(access.previewToken).toBeTruthy();

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${access.previewToken}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("content-disposition")).toBe(
        "inline; filename=\"clip.mp4\"; filename*=UTF-8''clip.mp4",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(bytes)).toBe(true);

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("supports HEAD, byte ranges, and repeated seeks on the same reusable token", async () => {
      const cwd = tmpCwd();
      const bytes = Buffer.from([...Array(100).keys()]);
      writeFileSync(path.join(cwd, "clip.mp4"), bytes);

      const access = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      const url = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${access.previewToken}`;

      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("100");

      const firstRange = await fetch(url, { headers: { Range: "bytes=10-19" } });
      expect(firstRange.status).toBe(206);
      expect(firstRange.headers.get("content-range")).toBe("bytes 10-19/100");
      expect(firstRange.headers.get("content-length")).toBe("10");
      expect(Buffer.from(await firstRange.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);

      // Same token, a different range: proves the grant is reusable, not one-shot.
      const secondRange = await fetch(url, { headers: { Range: "bytes=90-" } });
      expect(secondRange.status).toBe(206);
      expect(secondRange.headers.get("content-range")).toBe("bytes 90-99/100");
      expect(Buffer.from(await secondRange.arrayBuffer()).equals(bytes.subarray(90))).toBe(true);

      const suffixRange = await fetch(url, { headers: { Range: "bytes=-5" } });
      expect(suffixRange.status).toBe(206);
      expect(suffixRange.headers.get("content-range")).toBe("bytes 95-99/100");

      const thirdTime = await fetch(url, { headers: { Range: "bytes=10-19" } });
      expect(thirdTime.status).toBe(206);
      expect(Buffer.from(await thirdTime.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("rejects an unsatisfiable range with 416 and a Content-Range of the full size", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "clip.mp4"), Buffer.alloc(10, 1));

      const access = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      const url = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${access.previewToken}`;

      const beyondEnd = await fetch(url, { headers: { Range: "bytes=100-200" } });
      expect(beyondEnd.status).toBe(416);
      expect(beyondEnd.headers.get("content-range")).toBe("bytes */10");
      expect(beyondEnd.headers.get("cache-control")).toBe("no-store");

      const zeroSuffix = await fetch(url, { headers: { Range: "bytes=-0" } });
      expect(zeroSuffix.status).toBe(416);

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("HEAD ignores Range and always describes the full resource", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "clip.mp4"), Buffer.alloc(50, 7));

      const access = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      const url = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${access.previewToken}`;

      const head = await fetch(url, { method: "HEAD", headers: { Range: "bytes=0-9" } });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("50");
      expect(head.headers.get("content-range")).toBeNull();

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("serves a zero-byte media file with an empty body instead of erroring", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "empty.mp4"), Buffer.alloc(0));

      const access = await ctx.client.getFileAccess({ cwd, path: "empty.mp4", preview: true });
      expect(access.file?.size).toBe(0);
      const url = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${access.previewToken}`;

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("0");
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.length).toBe(0);

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("aborting a request does not hang the endpoint for a later request", async () => {
      const cwd = tmpCwd();
      const bytes = Buffer.alloc(5_000_000, 5);
      writeFileSync(path.join(cwd, "big.mp4"), bytes);

      const access = await ctx.client.getFileAccess({ cwd, path: "big.mp4", preview: true });
      const url = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${access.previewToken}`;

      const controller = new AbortController();
      const responseToAbort = await fetch(url, { signal: controller.signal });
      const reader = responseToAbort.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // The aborted response may already have errored its reader.
      }

      // A canceled transfer must not interfere with subsequent requests.
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.length).toBe(bytes.length);

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("reuses one grant per (session, file) across repeat get_access calls", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "clip.mp4"), Buffer.alloc(20, 3));

      const first = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      const second = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });

      expect(second.previewToken).toBe(first.previewToken);

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("replacing the file invalidates the old token and get_access mints a fresh one", async () => {
      const cwd = tmpCwd();
      const filePath = path.join(cwd, "clip.mp4");
      writeFileSync(filePath, Buffer.alloc(20, 3));

      const first = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      const firstUrl = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${first.previewToken}`;
      expect((await fetch(firstUrl)).status).toBe(200);

      // Replace at the same path (new inode), simulating a downstream rewrite.
      rmSync(filePath);
      writeFileSync(filePath, Buffer.alloc(30, 9));

      const staleAfterReplace = await fetch(firstUrl);
      expect(staleAfterReplace.status).toBe(404);

      const second = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      expect(second.previewToken).not.toBe(first.previewToken);
      const secondUrl = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${second.previewToken}`;
      const retried = await fetch(secondUrl);
      expect(retried.status).toBe(200);
      expect(Buffer.from(await retried.arrayBuffer()).equals(Buffer.alloc(30, 9))).toBe(true);

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("rejects a missing preview token", async () => {
      const response = await fetch(`http://127.0.0.1:${ctx.daemon.port}/api/files/preview`);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }, 15000);

    test("rejects an in-place rewrite and refreshes access to its new revision", async () => {
      const cwd = tmpCwd();
      const file = path.join(cwd, "clip.mp4");
      writeFileSync(file, "original");
      const first = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      writeFileSync(file, "rewritten revision");
      const stale = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${first.previewToken}`,
      );
      expect(stale.status).toBe(404);
      const second = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      expect(second.previewToken).not.toBe(first.previewToken);
      const fresh = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${second.previewToken}`,
      );
      expect(await fresh.text()).toBe("rewritten revision");
      rmSync(cwd, { recursive: true, force: true });
    });

    test("If-Range falls back to the full file when the validator differs", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "clip.mp4"), "0123456789");
      const access = await ctx.client.getFileAccess({ cwd, path: "clip.mp4", preview: true });
      const url = `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=${access.previewToken}`;
      const head = await fetch(url, { method: "HEAD" });
      const match = await fetch(url, {
        headers: { Range: "bytes=2-4", "If-Range": head.headers.get("last-modified")! },
      });
      expect(match.status).toBe(206);
      expect(await match.text()).toBe("234");
      const mismatch = await fetch(url, {
        headers: { Range: "bytes=2-4", "If-Range": "Thu, 01 Jan 1970 00:00:00 GMT" },
      });
      expect(mismatch.status).toBe(200);
      expect(await mismatch.text()).toBe("0123456789");
      rmSync(cwd, { recursive: true, force: true });
    });

    test("rejects an unknown preview token", async () => {
      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/preview?token=does-not-exist`,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }, 15000);

    test("never grants a preview token for HTML, only downloadable metadata", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "page.html"), "<html><body>hi</body></html>", "utf-8");

      const access = await ctx.client.getFileAccess({ cwd, path: "page.html", preview: true });

      expect(access.error).toBeNull();
      expect(access.file).not.toBeNull();
      expect(access.previewToken).toBeNull();

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);

    test("reports a metadata error for a missing file without throwing", async () => {
      const cwd = tmpCwd();

      const access = await ctx.client.getFileAccess({ cwd, path: "missing.mp4" });

      expect(access.file).toBeNull();
      expect(access.previewToken).toBeNull();
      expect(access.error).toBeTruthy();

      rmSync(cwd, { recursive: true, force: true });
    }, 30000);
  });
});
