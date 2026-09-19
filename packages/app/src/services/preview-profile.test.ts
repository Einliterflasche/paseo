import { describe, expect, it } from "vitest";
import {
  createPreviewProfile,
  PreviewProfileError,
  type PreviewProfilePort,
} from "./preview-profile";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

class MemoryProfile implements PreviewProfilePort {
  value: string | null = null;
  readonly writes: string[] = [];
  creations = 0;
  reads = 0;
  readError: Error | null = null;
  writeError: Error | null = null;
  lockError: Error | null = null;
  private tail: Promise<void> = Promise.resolve();

  read(): string | null {
    this.reads += 1;
    if (this.readError) throw this.readError;
    return this.value;
  }

  write(value: string): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(value);
    this.value = value;
  }

  createId(): string {
    const value = [FIRST, SECOND, THIRD][this.creations++];
    if (!value) throw new Error("Test exhausted deterministic handles");
    return value;
  }

  lock<T>(work: () => T): Promise<T> {
    if (this.lockError) return Promise.reject(this.lockError);
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

describe("preview browser profile", () => {
  it("initializes one missing handle for concurrent control pages", async () => {
    const storage = new MemoryProfile();
    const firstPage = createPreviewProfile(storage);
    const secondPage = createPreviewProfile(storage);

    expect(await Promise.all([firstPage.read(), secondPage.read()])).toEqual([FIRST, FIRST]);
    expect(storage.writes).toEqual([FIRST]);
    expect(storage.creations).toBe(1);

    storage.value = SECOND;
    expect(await firstPage.read()).toBe(SECOND);
    expect(storage.writes).toEqual([FIRST]);
  });

  it("leaves invalid stored data untouched until explicit recovery", async () => {
    const storage = new MemoryProfile();
    storage.value = "damaged-profile";
    const profile = createPreviewProfile(storage);

    await expect(profile.read()).rejects.toEqual(new PreviewProfileError("damaged-profile"));
    expect(storage.value).toBe("damaged-profile");
    expect(storage.writes).toEqual([]);
    expect(storage.creations).toBe(0);

    expect(await profile.recover("damaged-profile")).toBe(FIRST);
    expect(await profile.read()).toBe(FIRST);
    expect(storage.writes).toEqual([FIRST]);
  });

  it("shares one fresh handle when two pages recover the same observation", async () => {
    const storage = new MemoryProfile();
    storage.value = "damaged-profile";
    const firstPage = createPreviewProfile(storage);
    const secondPage = createPreviewProfile(storage);

    expect(
      await Promise.all([
        firstPage.recover("damaged-profile"),
        secondPage.recover("damaged-profile"),
      ]),
    ).toEqual([FIRST, FIRST]);
    expect(storage.writes).toEqual([FIRST]);
    expect(storage.creations).toBe(1);
  });

  it("does not overwrite another page's replacement during delayed recovery", async () => {
    const storage = new MemoryProfile();
    storage.value = SECOND;
    const profile = createPreviewProfile(storage);

    expect(await profile.recover(FIRST)).toBe(SECOND);
    expect(storage.value).toBe(SECOND);
    expect(storage.writes).toEqual([]);
    expect(storage.creations).toBe(0);

    storage.value = "new-invalid-value";
    await expect(profile.recover(FIRST)).rejects.toEqual(
      new PreviewProfileError("new-invalid-value"),
    );
    expect(storage.value).toBe("new-invalid-value");
    expect(storage.writes).toEqual([]);
  });

  it("rejects unavailable reads without creating or replacing a handle", async () => {
    const storage = new MemoryProfile();
    storage.value = SECOND;
    storage.readError = new Error("storage blocked");
    const profile = createPreviewProfile(storage);

    await expect(profile.read()).rejects.toBe(storage.readError);
    await expect(profile.recover(SECOND)).rejects.toBe(storage.readError);
    expect(storage.value).toBe(SECOND);
    expect(storage.writes).toEqual([]);
    expect(storage.creations).toBe(0);

    storage.readError = null;
    expect(await profile.read()).toBe(SECOND);
  });

  it("does not report an unpersisted handle after a write fails", async () => {
    const storage = new MemoryProfile();
    storage.writeError = new Error("storage full");
    const profile = createPreviewProfile(storage);

    await expect(profile.read()).rejects.toBe(storage.writeError);
    expect(storage.value).toBeNull();
    expect(storage.writes).toEqual([]);

    storage.value = "damaged-profile";
    await expect(profile.recover("damaged-profile")).rejects.toBe(storage.writeError);
    expect(storage.value).toBe("damaged-profile");

    storage.writeError = null;
    expect(await profile.recover("damaged-profile")).toBe(THIRD);
    expect(storage.writes).toEqual([THIRD]);
  });

  it("does not access storage when exclusive browser coordination is unavailable", async () => {
    const storage = new MemoryProfile();
    storage.lockError = new PreviewProfileError(null);
    const profile = createPreviewProfile(storage);

    await expect(profile.read()).rejects.toBe(storage.lockError);
    await expect(profile.recover(null)).rejects.toBe(storage.lockError);
    expect(storage.reads).toBe(0);
    expect(storage.writes).toEqual([]);
    expect(storage.creations).toBe(0);
  });
});
