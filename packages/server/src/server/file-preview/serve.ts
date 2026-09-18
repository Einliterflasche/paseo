import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { BigIntStats } from "node:fs";
import type express from "express";
import type pino from "pino";
import { fileIdentity } from "../file-explorer/service.js";
import { fileContentDisposition } from "../file-download/content-disposition.js";
import type { PreviewGrant, PreviewGrantStore } from "./grant-store.js";

const OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

function sendJsonError(res: express.Response, status: number, error: string): void {
  res.status(status).set(NO_STORE_HEADERS).json({ error });
}

function extractToken(req: express.Request): string | null {
  return typeof req.query.token === "string" && req.query.token.trim().length > 0
    ? req.query.token.trim()
    : null;
}

function isGrantCurrent(
  previewGrantStore: PreviewGrantStore,
  token: string,
  grant: PreviewGrant,
): boolean {
  const current = previewGrantStore.getGrant(token);
  return current !== null && current.token === grant.token;
}

function matchesGrantIdentity(stats: BigIntStats, grant: PreviewGrant): boolean {
  return stats.isFile() && fileIdentity(stats) === grant.identity;
}

function formatLastModified(stats: BigIntStats): string {
  return new Date(Number(stats.mtimeNs / 1_000_000n)).toUTCString();
}

export function createFilePreviewRouteHandler({
  previewGrantStore,
  logger,
}: {
  previewGrantStore: PreviewGrantStore;
  logger: pino.Logger;
}): (req: express.Request, res: express.Response) => void {
  return function handleFilePreview(req: express.Request, res: express.Response): void {
    void servePreview(req, res, { previewGrantStore, logger });
  };
}

async function servePreview(
  req: express.Request,
  res: express.Response,
  { previewGrantStore, logger }: { previewGrantStore: PreviewGrantStore; logger: pino.Logger },
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    sendJsonError(res, 400, "Missing preview token");
    return;
  }

  const grant = previewGrantStore.getGrant(token);
  if (!grant) {
    sendJsonError(res, 403, "Invalid preview token");
    return;
  }

  // Open once and verify identity on that exact descriptor, then stream from
  // the same fd. Stat-then-reopen-by-path would leave a window where the
  // path could be swapped between the check and the read.
  let handle: FileHandle | null = null;
  try {
    handle = await open(grant.absolutePath, OPEN_FLAGS);
    const stats = await handle.stat({ bigint: true });

    // The grant may have been revoked (session disposed) or replaced (file
    // changed, fresh token issued for the same path) while the open/stat
    // above was in flight — re-check the store, not just the local variable.
    if (!isGrantCurrent(previewGrantStore, token, grant)) {
      sendJsonError(res, 403, "Invalid preview token");
      return;
    }
    if (!matchesGrantIdentity(stats, grant)) {
      sendJsonError(res, 404, "File not found");
      return;
    }
    if (res.destroyed || req.destroyed) {
      // Client disconnected while we were opening/stat'ing the file.
      return;
    }

    await respondWithVerifiedFile({
      req,
      res,
      handle,
      mimeType: grant.mimeType,
      fileName: grant.fileName,
      size: Number(stats.size),
      lastModified: formatLastModified(stats),
    });
  } catch (error) {
    if (res.destroyed) return;
    logger.error({ err: error }, "Failed to serve file preview");
    if (!res.headersSent) {
      sendJsonError(res, 404, "File not found");
    } else {
      res.end();
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

// The caller retains ownership of the verified handle until the response ends.
async function respondWithVerifiedFile({
  req,
  res,
  handle,
  mimeType,
  fileName,
  size,
  lastModified,
}: {
  req: express.Request;
  res: express.Response;
  handle: FileHandle;
  mimeType: string;
  fileName: string;
  size: number;
  lastModified: string;
}): Promise<void> {
  res.set({
    ...NO_STORE_HEADERS,
    "Content-Type": mimeType,
    "Content-Disposition": fileContentDisposition("inline", fileName),
    "Accept-Ranges": "bytes",
    "Last-Modified": lastModified,
  });

  // Range semantics apply to GET only; a HEAD response always describes the
  // full resource.
  const range = req.method === "HEAD" ? null : resolveRange(req, size, lastModified);
  if (range === "unsatisfiable") {
    res.status(416).set("Content-Range", `bytes */${size}`).end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  res.status(range ? 206 : 200);
  if (range) {
    res.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.set("Content-Length", String(size === 0 ? 0 : end - start + 1));

  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }

  const stream = handle.createReadStream({ start, end, autoClose: false });
  // pipeline handles backpressure and destroys the reader on a client abort.
  // The outer finally closes the descriptor on success, abort, or any throw.
  await pipeline(stream, res);
}

function resolveRange(
  req: express.Request,
  size: number,
  lastModified: string,
): { start: number; end: number } | "unsatisfiable" | null {
  const rangeHeader = req.header("range");
  if (!rangeHeader) return null;

  const ifRange = req.header("if-range");
  if (ifRange && ifRange !== lastModified) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    // No Range, or a multi-range request (unsupported) — serve the full body.
    return null;
  }

  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    start < 0 ||
    start >= size
  ) {
    return "unsatisfiable";
  }

  return { start, end: Math.min(end, size - 1) };
}
