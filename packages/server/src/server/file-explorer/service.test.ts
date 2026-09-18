import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGitCommand } from "../../utils/run-git-command.js";
import {
  createExplorerEntry,
  deleteExplorerEntry,
  duplicateExplorerEntry,
  getExplorerFileVersion,
  getFileAccessInfo,
  readExplorerFile,
  renameExplorerEntry,
  streamExplorerFile,
  writeExplorerFile,
} from "./service.js";

async function createHomeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.homedir(), prefix));
}

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("file explorer service", () => {
  it("atomically writes an existing text file at the expected revision", async () => {
    const root = await createTempDir("paseo-file-write-");
    try {
      const filePath = path.join(root, "notes.txt");
      await writeFile(filePath, "before", "utf8");
      const current = await getExplorerFileVersion({ root, relativePath: "notes.txt" });
      expect(current.status).toBe("ready");
      if (current.status !== "ready") return;

      const result = await writeExplorerFile({
        root,
        relativePath: "notes.txt",
        content: "after",
        expectedModifiedAt: current.modifiedAt,
        expectedRevision: current.revision,
      });

      expect(result.status).toBe("written");
      expect((await readExplorerFile({ root, relativePath: "notes.txt" })).content).toBe("after");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves the original file permissions across atomic replacement",
    async () => {
      const root = await createTempDir("paseo-file-mode-");
      try {
        const filePath = path.join(root, "script.sh");
        await writeFile(filePath, "before", "utf8");
        await chmod(filePath, 0o764);
        const current = await getExplorerFileVersion({ root, relativePath: "script.sh" });
        expect(current.status).toBe("ready");
        if (current.status !== "ready") return;

        const result = await writeExplorerFile({
          root,
          relativePath: "script.sh",
          content: "after",
          expectedModifiedAt: current.modifiedAt,
          expectedRevision: current.revision,
        });

        expect(result.status).toBe("written");
        expect((await stat(filePath)).mode & 0o7777).toBe(0o764);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves a newer disk revision instead of overwriting it", async () => {
    const root = await createTempDir("paseo-file-conflict-");
    try {
      const filePath = path.join(root, "notes.txt");
      await writeFile(filePath, "newer on disk", "utf8");

      const result = await writeExplorerFile({
        root,
        relativePath: "notes.txt",
        content: "stale local edit",
        expectedModifiedAt: "2020-01-01T00:00:00.000Z",
      });

      expect(result).toMatchObject({ status: "conflict", version: { status: "ready" } });
      expect((await readExplorerFile({ root, relativePath: "notes.txt" })).content).toBe(
        "newer on disk",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers the high-precision revision token over the display timestamp", async () => {
    const root = await createTempDir("paseo-file-revision-");
    try {
      const filePath = path.join(root, "notes.txt");
      await writeFile(filePath, "on disk", "utf8");
      const current = await getExplorerFileVersion({ root, relativePath: "notes.txt" });
      expect(current.status).toBe("ready");
      if (current.status !== "ready") return;

      const result = await writeExplorerFile({
        root,
        relativePath: "notes.txt",
        content: "stale local edit",
        expectedModifiedAt: current.modifiedAt,
        expectedRevision: `${current.revision}-stale`,
      });

      expect(result.status).toBe("conflict");
      expect((await readExplorerFile({ root, relativePath: "notes.txt" })).content).toBe("on disk");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never creates a missing file through the write API", async () => {
    const root = await createTempDir("paseo-file-missing-");
    try {
      const result = await writeExplorerFile({
        root,
        relativePath: "missing.txt",
        content: "new file",
        expectedModifiedAt: "2020-01-01T00:00:00.000Z",
      });

      expect(result).toMatchObject({ status: "conflict", version: { status: "missing" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads .ex files as text", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "sample.ex");
      const content = "defmodule Sample do\nend\n";
      await writeFile(filePath, content, "utf-8");

      const result = await readExplorerFile({
        root,
        relativePath: "sample.ex",
      });

      expect(result.kind).toBe("text");
      expect(result.encoding).toBe("utf-8");
      expect(result.mimeType).toBe("text/plain");
      expect(result.content).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads unknown extension text files as text", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "notes.customext");
      const content = "hello from a custom text file\n";
      await writeFile(filePath, content, "utf-8");

      const result = await readExplorerFile({
        root,
        relativePath: "notes.customext",
      });

      expect(result.kind).toBe("text");
      expect(result.encoding).toBe("utf-8");
      expect(result.mimeType).toBe("text/plain");
      expect(result.content).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies files with null bytes as binary", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "blob.weird");
      await writeFile(filePath, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]));

      const result = await readExplorerFile({
        root,
        relativePath: "blob.weird",
      });

      expect(result.kind).toBe("binary");
      expect(result.encoding).toBe("none");
      expect(result.content).toBeUndefined();
      expect(result.mimeType).toBe("application/octet-stream");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a stream when the file grows after its revision is advertised", async () => {
    const root = await createTempDir("paseo-file-stream-growth-");

    try {
      const filePath = path.join(root, "growing.log");
      const initial = Buffer.alloc(300 * 1024, 0x61);
      await writeFile(filePath, initial);
      await expect(
        streamExplorerFile({ root, relativePath: "growing.log" }, async (file) => {
          await appendFile(filePath, Buffer.alloc(300 * 1024, 0x62));
          for await (const _chunk of file.chunks) {
            // Consume through the advertised prefix before validating the revision.
          }
        }),
      ).rejects.toThrow("File changed during transfer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a stream when the file shrinks below its advertised size", async () => {
    const root = await createTempDir("paseo-file-stream-truncate-");

    try {
      const filePath = path.join(root, "shrinking.log");
      await writeFile(filePath, Buffer.alloc(300 * 1024, 0x61));

      await expect(
        streamExplorerFile({ root, relativePath: "shrinking.log" }, async (file) => {
          await truncate(filePath, 100 * 1024);
          for await (const _chunk of file.chunks) {
            // Consume until the stream detects the premature EOF.
          }
        }),
      ).rejects.toThrow("File changed during transfer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a stream when the file is overwritten in place", async () => {
    const root = await createTempDir("paseo-file-stream-overwrite-");

    try {
      const filePath = path.join(root, "changing.log");
      const initial = Buffer.alloc(600 * 1024, 0x61);
      await writeFile(filePath, initial);

      await expect(
        streamExplorerFile({ root, relativePath: "changing.log" }, async (file) => {
          let chunkIndex = 0;
          for await (const _chunk of file.chunks) {
            chunkIndex += 1;
            if (chunkIndex === 1) {
              const replacement = Buffer.alloc(initial.byteLength, 0x62);
              await writeFile(filePath, replacement);
            }
          }
        }),
      ).rejects.toThrow("File changed during transfer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies sampled text when UTF-8 crosses the sample boundary", async () => {
    const root = await createTempDir("paseo-file-stream-utf8-");

    try {
      const content = Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from("€"), Buffer.from("z")]);
      await writeFile(path.join(root, "sample.txt"), content);
      let kind: string | undefined;
      let encoding: string | undefined;

      await streamExplorerFile({ root, relativePath: "sample.txt" }, async (file) => {
        kind = file.kind;
        encoding = file.encoding;
      });

      expect(kind).toBe("text");
      expect(encoding).toBe("utf-8");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete UTF-8 when the whole file was sampled", async () => {
    const root = await createTempDir("paseo-file-stream-invalid-utf8-");

    try {
      await writeFile(path.join(root, "invalid.txt"), Buffer.from([0x61, 0xe2, 0x82]));
      let kind: string | undefined;

      await streamExplorerFile({ root, relativePath: "invalid.txt" }, async (file) => {
        kind = file.kind;
      });

      expect(kind).toBe("binary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects binary bytes beyond the initial classification block", async () => {
    const root = await createTempDir("paseo-file-stream-late-binary-");

    try {
      const content = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0xff])]);
      await writeFile(path.join(root, "late-binary.unknown"), content);
      let kind: string | undefined;

      await streamExplorerFile({ root, relativePath: "late-binary.unknown" }, async (file) => {
        kind = file.kind;
      });

      expect(kind).toBe("binary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands a ~ prefix in relative paths against the user home directory", async () => {
    const root = await createHomeTempDir(".paseo-file-explorer-home-");

    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello from home\n", "utf-8");

      const tildePath = `~/${path.relative(os.homedir(), filePath)}`;
      const result = await readExplorerFile({
        root,
        relativePath: tildePath,
      });

      expect(result.kind).toBe("text");
      expect(result.content).toBe("hello from home\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows home to be the scoped root for tilde file previews", async () => {
    const root = await createHomeTempDir(".paseo-file-explorer-home-root-");

    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello from home root\n", "utf-8");

      const tildePath = `~/${path.relative(os.homedir(), filePath)}`;
      const result = await readExplorerFile({
        root: "~",
        relativePath: tildePath,
      });

      expect(result.kind).toBe("text");
      expect(result.path).toBe(path.relative(os.homedir(), filePath).split(path.sep).join("/"));
      expect(result.content).toBe("hello from home root\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ~-prefixed paths that resolve outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-file-explorer-outside-home-"));

    try {
      await expect(
        readExplorerFile({
          root,
          relativePath: "~/some/file.txt",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates files and directories, refusing duplicates and separator names", async () => {
    const root = await createTempDir("paseo-entry-create-");
    try {
      const file = await createExplorerEntry({
        root,
        parentPath: ".",
        name: "notes.txt",
        kind: "file",
      });
      expect(file).toEqual({ status: "ok", path: "notes.txt" });
      expect((await stat(path.join(root, "notes.txt"))).isFile()).toBe(true);

      const dir = await createExplorerEntry({
        root,
        parentPath: ".",
        name: "docs",
        kind: "directory",
      });
      expect(dir).toEqual({ status: "ok", path: "docs" });
      const nested = await createExplorerEntry({
        root,
        parentPath: "docs",
        name: "guide.md",
        kind: "file",
      });
      expect(nested).toEqual({ status: "ok", path: "docs/guide.md" });

      const duplicate = await createExplorerEntry({
        root,
        parentPath: ".",
        name: "notes.txt",
        kind: "file",
      });
      expect(duplicate.status).toBe("error");

      const traversal = await createExplorerEntry({
        root,
        parentPath: ".",
        name: "../escape",
        kind: "directory",
      });
      expect(traversal.status).toBe("error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("duplicates files and folders with collision-free sibling names", async () => {
    const root = await createTempDir("paseo-entry-duplicate-");
    try {
      await writeFile(path.join(root, "notes.txt"), "original", "utf8");
      const firstFileCopy = await duplicateExplorerEntry({
        root,
        relativePath: "notes.txt",
      });
      expect(firstFileCopy).toEqual({ status: "ok", path: "notes copy.txt" });
      expect(await readFile(path.join(root, "notes copy.txt"), "utf8")).toBe("original");

      const secondFileCopy = await duplicateExplorerEntry({
        root,
        relativePath: "notes.txt",
      });
      expect(secondFileCopy).toEqual({ status: "ok", path: "notes copy 2.txt" });

      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "guide.md"), "guide", "utf8");
      const folderCopy = await duplicateExplorerEntry({ root, relativePath: "docs" });
      expect(folderCopy).toEqual({ status: "ok", path: "docs copy" });
      expect(await readFile(path.join(root, "docs copy", "guide.md"), "utf8")).toBe("guide");

      await expect(duplicateExplorerEntry({ root, relativePath: "." })).resolves.toMatchObject({
        status: "error",
      });
      await expect(duplicateExplorerEntry({ root, relativePath: "missing.txt" })).resolves.toEqual({
        status: "error",
        error: "File or folder no longer exists",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renames tracked entries with Git and untracked entries on the filesystem", async () => {
    const root = await createTempDir("paseo-entry-rename-");
    try {
      await runGitCommand(["init"], { cwd: root });
      await writeFile(path.join(root, "tracked.txt"), "tracked", "utf8");
      await mkdir(path.join(root, "tracked-folder"));
      await writeFile(path.join(root, "tracked-folder", "inside.txt"), "tracked", "utf8");
      await runGitCommand(["add", "."], { cwd: root });
      await runGitCommand(
        ["-c", "user.name=Paseo Test", "-c", "user.email=test@paseo.local", "commit", "-m", "base"],
        { cwd: root },
      );

      const tracked = await renameExplorerEntry({
        root,
        relativePath: "tracked.txt",
        name: "renamed.txt",
      });
      expect(tracked).toEqual({ status: "ok", path: "renamed.txt" });
      expect((await runGitCommand(["status", "--short"], { cwd: root })).stdout.trim()).toBe(
        "R  tracked.txt -> renamed.txt",
      );

      const trackedFolder = await renameExplorerEntry({
        root,
        relativePath: "tracked-folder",
        name: "renamed-folder",
      });
      expect(trackedFolder).toEqual({ status: "ok", path: "renamed-folder" });
      const gitStatus = (await runGitCommand(["status", "--short"], { cwd: root })).stdout;
      expect(gitStatus).toContain("tracked-folder/inside.txt -> renamed-folder/inside.txt");

      await writeFile(path.join(root, "untracked.txt"), "untracked", "utf8");
      const untracked = await renameExplorerEntry({
        root,
        relativePath: "untracked.txt",
        name: "moved.txt",
      });
      expect(untracked).toEqual({ status: "ok", path: "moved.txt" });
      expect((await stat(path.join(root, "moved.txt"))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports case-only renames for tracked and untracked files", async () => {
    const root = await createTempDir("paseo-entry-case-rename-");
    try {
      await runGitCommand(["init"], { cwd: root });
      await writeFile(path.join(root, "Tracked.txt"), "tracked", "utf8");
      await writeFile(path.join(root, "Loose.txt"), "untracked", "utf8");
      await runGitCommand(["add", "Tracked.txt"], { cwd: root });
      await runGitCommand(
        ["-c", "user.name=Paseo Test", "-c", "user.email=test@paseo.local", "commit", "-m", "base"],
        { cwd: root },
      );

      await expect(
        renameExplorerEntry({ root, relativePath: "Tracked.txt", name: "tracked.txt" }),
      ).resolves.toEqual({ status: "ok", path: "tracked.txt" });
      expect((await stat(path.join(root, "tracked.txt"))).isFile()).toBe(true);

      await expect(
        renameExplorerEntry({ root, relativePath: "Loose.txt", name: "loose.txt" }),
      ).resolves.toEqual({ status: "ok", path: "loose.txt" });
      expect((await stat(path.join(root, "loose.txt"))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses invalid renames, existing targets, and the workspace root", async () => {
    const root = await createTempDir("paseo-entry-rename-errors-");
    try {
      await writeFile(path.join(root, "source.txt"), "source", "utf8");
      await writeFile(path.join(root, "existing.txt"), "existing", "utf8");
      await link(path.join(root, "source.txt"), path.join(root, "source-link.txt"));

      await expect(
        renameExplorerEntry({ root, relativePath: "source.txt", name: "existing.txt" }),
      ).resolves.toEqual({ status: "error", error: '"existing.txt" already exists' });
      await expect(
        renameExplorerEntry({ root, relativePath: "source.txt", name: "source-link.txt" }),
      ).resolves.toEqual({ status: "error", error: '"source-link.txt" already exists' });
      await expect(
        renameExplorerEntry({ root, relativePath: "source.txt", name: "../outside.txt" }),
      ).resolves.toEqual({ status: "error", error: "Name cannot contain path separators" });
      await expect(
        renameExplorerEntry({ root, relativePath: ".", name: "renamed-root" }),
      ).resolves.toEqual({ status: "error", error: "Cannot rename the workspace root" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes files and directories but never the workspace root or outside paths", async () => {
    const root = await createTempDir("paseo-entry-delete-");
    try {
      await writeFile(path.join(root, "doomed.txt"), "bye", "utf8");
      const removedFile = await deleteExplorerEntry({ root, relativePath: "doomed.txt" });
      expect(removedFile).toEqual({ status: "ok", path: "doomed.txt" });
      await expect(stat(path.join(root, "doomed.txt"))).rejects.toThrow();

      await createExplorerEntry({ root, parentPath: ".", name: "nested", kind: "directory" });
      await writeFile(path.join(root, "nested", "inner.txt"), "hi", "utf8");
      const removedDir = await deleteExplorerEntry({ root, relativePath: "nested" });
      expect(removedDir).toEqual({ status: "ok", path: "nested" });
      await expect(stat(path.join(root, "nested"))).rejects.toThrow();

      const rootDelete = await deleteExplorerEntry({ root, relativePath: "." });
      expect(rootDelete.status).toBe("error");

      await expect(
        deleteExplorerEntry({ root, relativePath: "../outside" }),
      ).resolves.toMatchObject({ status: "error" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("getFileAccessInfo", () => {
  it.each([
    ["ts", "video/mp2t"],
    ["mts", "model/vnd.mts"],
  ])(
    "distinguishes TypeScript from binary transport streams for .%s",
    async (ext, binaryMimeType) => {
      const root = await createTempDir("paseo-file-access-");
      try {
        await writeFile(path.join(root, `source.${ext}`), "export const ready = true;", "utf8");
        expect(await getFileAccessInfo({ root, relativePath: `source.${ext}` })).toMatchObject({
          kind: "text",
          mimeType: "text/plain",
        });
        await writeFile(path.join(root, `video.${ext}`), Buffer.from([0x47, 0, 0, 1]));
        expect(await getFileAccessInfo({ root, relativePath: `video.${ext}` })).toMatchObject({
          kind: "binary",
          mimeType: binaryMimeType,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("classifies a PDF as binary with the real MIME type even though its header looks like UTF-8", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "doc.pdf"), "%PDF-1.4\nharmless printable header\n", "utf8");
      const info = await getFileAccessInfo({ root, relativePath: "doc.pdf" });
      expect(info.kind).toBe("binary");
      expect(info.mimeType).toBe("application/pdf");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an MP4 as binary with the real MIME type regardless of its content", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "clip.mp4"), Buffer.from([0, 1, 2, 3, 4]));
      const info = await getFileAccessInfo({ root, relativePath: "clip.mp4" });
      expect(info.kind).toBe("binary");
      expect(info.mimeType).toBe("video/mp4");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a plain text file as text", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "notes.txt"), "hello world", "utf8");
      const info = await getFileAccessInfo({ root, relativePath: "notes.txt" });
      expect(info).toMatchObject({ kind: "text", mimeType: "text/plain", size: 11 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a PNG as image", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const info = await getFileAccessInfo({ root, relativePath: "pic.png" });
      expect(info).toMatchObject({ kind: "image", mimeType: "image/png" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies non-null-byte, invalid-UTF-8 content as binary instead of text", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      // Lone continuation byte: no NUL, no control-char run, but not valid UTF-8.
      await writeFile(path.join(root, "garbled.dat"), Buffer.from([0x41, 0x42, 0x80, 0x43, 0x44]));
      const info = await getFileAccessInfo({ root, relativePath: "garbled.dat" });
      expect(info.kind).toBe("binary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an unknown binary extension as binary with a generic MIME fallback", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "blob.unknownext"), Buffer.from([0, 1, 2, 3]));
      const info = await getFileAccessInfo({ root, relativePath: "blob.unknownext" });
      expect(info).toMatchObject({ kind: "binary", mimeType: "application/octet-stream" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives a zero-byte file a stable identity and empty text classification", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "empty.txt"), "");
      const info = await getFileAccessInfo({ root, relativePath: "empty.txt" });
      expect(info).toMatchObject({ kind: "text", size: 0 });
      expect(info.identity).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("changes identity when the file is replaced at the same path", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      const filePath = path.join(root, "clip.mp4");
      await writeFile(filePath, Buffer.from([1, 2, 3]));
      const before = await getFileAccessInfo({ root, relativePath: "clip.mp4" });

      await rm(filePath);
      await writeFile(filePath, Buffer.from([4, 5, 6, 7]));
      const after = await getFileAccessInfo({ root, relativePath: "clip.mp4" });

      expect(after.identity).not.toBe(before.identity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("changes identity while a file grows in place so ranges cannot mix revisions", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      const filePath = path.join(root, "clip.mp4");
      await writeFile(filePath, Buffer.from([1, 2, 3]));
      const before = await getFileAccessInfo({ root, relativePath: "clip.mp4" });

      await appendFile(filePath, Buffer.from([4, 5]));
      const after = await getFileAccessInfo({ root, relativePath: "clip.mp4" });

      expect(after.identity).not.toBe(before.identity);
      expect(after.size).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts UTF-8 text when the metadata sample ends inside a multibyte character", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "notes.txt"), "a".repeat(8191) + "✅ continuation", "utf8");
      expect(await getFileAccessInfo({ root, relativePath: "notes.txt" })).toMatchObject({
        kind: "text",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete UTF-8 when the sample includes the entire file", async () => {
    const root = await createTempDir("paseo-file-access-");
    try {
      await writeFile(path.join(root, "notes.txt"), Buffer.from([0x61, 0xe2, 0x9c]));
      expect(await getFileAccessInfo({ root, relativePath: "notes.txt" })).toMatchObject({
        kind: "binary",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
