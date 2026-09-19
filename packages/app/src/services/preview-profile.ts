import { z } from "zod";

export interface PreviewProfilePort {
  read(): string | null;
  write(value: string): void;
  createId(): string;
  lock<T>(work: () => T): Promise<T>;
}

export class PreviewProfileError extends Error {
  constructor(readonly observed: string | null) {
    super("Preview browser storage is unavailable or invalid");
    this.name = "PreviewProfileError";
  }
}

const handleSchema = z.string().uuid();

/** Profile handles correlate browser sessions and contain no authority or secrets. */
export function createPreviewProfile(port: PreviewProfilePort) {
  function readCurrent(): string {
    const value = port.read();
    if (value !== null) {
      if (!handleSchema.safeParse(value).success) throw new PreviewProfileError(value);
      return value;
    }
    const next = port.createId();
    port.write(next);
    return next;
  }
  return {
    read(): Promise<string> {
      return port.lock(readCurrent);
    },
    recover(observed: string | null): Promise<string> {
      return port.lock(() => {
        // Another mounted control page may already have replaced the handle.
        if (port.read() === observed) port.write(port.createId());
        return readCurrent();
      });
    },
  };
}
