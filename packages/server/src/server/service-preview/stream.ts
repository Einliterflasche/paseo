import { Transform, type TransformCallback } from "node:stream";
import type { PreviewAuthorizedJob } from "./broker.js";

/** Every emitted chunk belongs to the captured, still-live authorization period. */
export function guardedPreviewStream(job: PreviewAuthorizedJob) {
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        job.write(() => callback(null, chunk));
      } catch (error) {
        callback(error instanceof Error ? error : new Error("preview-stream-ended"));
      }
    },
  });
}
