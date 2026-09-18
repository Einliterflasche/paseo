import path from "node:path";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { seedWorkspace, type SeedDaemonClient } from "./seed-client";

export interface FileLinkAgentWorkspace {
  agentId: string;
  workspaceId: string;
  cwd: string;
  client: SeedDaemonClient;
  cleanup(): Promise<void>;
}

/** Static binary fixtures used by the file-link/media e2e specs. */
export const FILE_LINK_MEDIA_DIR = path.resolve(__dirname, "../../fixtures/media");
export const SAMPLE_MP4_FIXTURE = path.join(FILE_LINK_MEDIA_DIR, "sample.mp4");
export const SAMPLE_PDF_FIXTURE = path.join(FILE_LINK_MEDIA_DIR, "sample.pdf");
export const SAMPLE_PNG_FIXTURE = path.join(FILE_LINK_MEDIA_DIR, "logo.png");

/**
 * Copies a fixture file into a seeded repo at `relativePath`, creating parent
 * directories as needed. Returns the absolute path on disk.
 */
export async function copyFixtureIntoRepo(
  repoPath: string,
  relativePath: string,
  sourceFixture: string,
): Promise<string> {
  const dest = path.join(repoPath, relativePath);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(sourceFixture, dest);
  return dest;
}

/** Writes raw bytes into a seeded repo at `relativePath`. Returns the absolute path. */
export async function writeBinaryFixture(
  repoPath: string,
  relativePath: string,
  content: Buffer,
): Promise<string> {
  const dest = path.join(repoPath, relativePath);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
  return dest;
}

/**
 * Percent-encodes each path segment (not the separators), so a markdown link
 * href survives literal spaces/parens/non-ASCII characters in the path while
 * still round-tripping through the app's URL-based absolute-path decoding.
 */
export function encodePathForMarkdownLink(absolutePath: string): string {
  const posix = absolutePath.replace(/\\/g, "/");
  const leadingSlash = posix.startsWith("/") ? "/" : "";
  return (
    leadingSlash +
    posix
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/")
  );
}

/**
 * Builds a mock-provider message that makes the deterministic "mock" agent
 * (see `mock-load-test-agent.ts`'s "emit settled assistant link markdown:"
 * trigger) emit a single-line markdown link pointing at an absolute file
 * path, so tests can drive the real assistant-file-link click dispatcher
 * without a paid real agent.
 */
export function respondWithFileLinkPrompt(label: string, absolutePath: string): string {
  return `emit settled assistant link markdown: [${label}](${encodePathForMarkdownLink(absolutePath)})`;
}

/** A binary fixture with no recognizable extension and non-text bytes. */
export function unknownBinaryFixtureBytes(): Buffer {
  // Null bytes make this unambiguously binary to the server's content sniffing
  // (isLikelyBinary), regardless of extension-based MIME guessing.
  return Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f, 0x80, 0x00, 0x10, 0x20, 0x30]);
}

/**
 * Seeds a temp git repo + workspace, lets the caller place fixture files at
 * their real absolute paths (only known once the repo exists), then creates
 * a ready "mock" provider agent whose first turn emits a markdown link to
 * one of those paths via the "emit settled assistant link markdown:"
 * trigger. This is `seedMockAgentWorkspace` (mock-agent.ts) with the
 * link-building step inlined, since the link's target path isn't known until
 * after the repo is on disk.
 */
export async function seedFileLinkAgentWorkspace(options: {
  repoPrefix: string;
  title: string;
  placeFixture: (repoPath: string) => Promise<{ label: string; absolutePath: string }>;
  port?: number;
}): Promise<FileLinkAgentWorkspace> {
  const workspace = await seedWorkspace({ repoPrefix: options.repoPrefix, port: options.port });
  try {
    const { label, absolutePath } = await options.placeFixture(workspace.repoPath);
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: options.title,
      modeId: "load-test",
      model: "e2e-fast-stream",
      initialPrompt: respondWithFileLinkPrompt(label, absolutePath),
    });
    return {
      agentId: agent.id,
      workspaceId: workspace.workspaceId,
      cwd: workspace.repoPath,
      client: workspace.client,
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}
