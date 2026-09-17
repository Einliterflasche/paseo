import { describe, expect, it } from "vitest";
import { createInMemoryKeyValueStorage } from "./fakes";
import { APP_SETTINGS_KEY, SETTINGS_MIGRATIONS_KEY } from "./keys";
import { migrateAppSettings } from "./migrations";
import { DEFAULT_CLIENT_SETTINGS, type AppSettings, type SendBehavior } from "./storage";

function settingsWith(sendBehavior: SendBehavior): AppSettings {
  return { ...DEFAULT_CLIENT_SETTINGS, sendBehavior };
}

type Storage = ReturnType<typeof createInMemoryKeyValueStorage>;

function appliedIds(storage: Storage): string[] {
  const raw = storage.entries.get(SETTINGS_MIGRATIONS_KEY);
  return raw === undefined ? [] : JSON.parse(raw).applied;
}

function storedSendBehavior(storage: Storage): SendBehavior | undefined {
  const raw = storage.entries.get(APP_SETTINGS_KEY);
  return raw === undefined ? undefined : JSON.parse(raw).sendBehavior;
}

function storedContentFontSize(storage: Storage): number | undefined {
  const raw = storage.entries.get(APP_SETTINGS_KEY);
  return raw === undefined ? undefined : JSON.parse(raw).contentFontSize;
}

/** An in-memory storage whose write to `failingKey` always throws, as a full disk would. */
function createFailingWriteStorage(failingKey: string): Storage {
  const storage = createInMemoryKeyValueStorage();
  const setItem = storage.setItem.bind(storage);
  return Object.assign(storage, {
    async setItem(key: string, value: string) {
      if (key === failingKey) throw new Error(`write to ${key} failed`);
      await setItem(key, value);
    },
  });
}

describe("migrateAppSettings", () => {
  it("migrates One syntax to Catppuccin without changing the app theme", async () => {
    const storage = createInMemoryKeyValueStorage();
    const settings: AppSettings = {
      ...settingsWith("steer"),
      theme: "pureBlack",
      syntaxTheme: "one",
    };

    const result = await migrateAppSettings(settings, storage);

    expect(result).toEqual({ ...settings, syntaxTheme: "catppuccin" });
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY) ?? "null")).toEqual(result);
    expect(appliedIds(storage)).toEqual(["steer-default", "catppuccin-syntax-default"]);
  });

  it("lets users select One again after the syntax migration", async () => {
    const storage = createInMemoryKeyValueStorage();
    const settings: AppSettings = { ...settingsWith("steer"), syntaxTheme: "one" };
    await migrateAppSettings(settings, storage);

    const result = await migrateAppSettings(settings, storage);

    expect(result.syntaxTheme).toBe("one");
  });

  it("preserves another syntax selection when marking the migration applied", async () => {
    const storage = createInMemoryKeyValueStorage();
    const settings: AppSettings = { ...settingsWith("steer"), syntaxTheme: "dracula" };

    const result = await migrateAppSettings(settings, storage);

    expect(result).toEqual(settings);
    expect(storage.entries.has(APP_SETTINGS_KEY)).toBe(false);
    expect(appliedIds(storage)).toEqual(["steer-default", "catppuccin-syntax-default"]);
    expect(
      (await migrateAppSettings({ ...settings, syntaxTheme: "one" }, storage)).syntaxTheme,
    ).toBe("one");
  });

  it("retries the syntax migration when its settings write fails", async () => {
    const storage = createFailingWriteStorage(APP_SETTINGS_KEY);
    const settings: AppSettings = { ...settingsWith("steer"), syntaxTheme: "one" };

    await expect(migrateAppSettings(settings, storage)).rejects.toThrow();

    expect(appliedIds(storage)).toEqual([]);
    const recovered = createInMemoryKeyValueStorage(Object.fromEntries(storage.entries));
    expect((await migrateAppSettings(settings, recovered)).syntaxTheme).toBe("catppuccin");
  });

  it("flips a stored interrupt to steer and marks itself applied", async () => {
    const storage = createInMemoryKeyValueStorage();

    const result = await migrateAppSettings(settingsWith("interrupt"), storage);

    expect(result.sendBehavior).toBe("steer");
    expect(storedSendBehavior(storage)).toBe("steer");
    expect(appliedIds(storage)).toEqual(["steer-default", "catppuccin-syntax-default"]);
  });

  it("leaves interrupt alone once the migration has run", async () => {
    const storage = createInMemoryKeyValueStorage();
    await migrateAppSettings(settingsWith("interrupt"), storage);

    const result = await migrateAppSettings(settingsWith("interrupt"), storage);

    expect(result.sendBehavior).toBe("interrupt");
  });

  it("leaves queue alone", async () => {
    const storage = createInMemoryKeyValueStorage();

    const result = await migrateAppSettings(settingsWith("queue"), storage);

    expect(result.sendBehavior).toBe("queue");
    expect(storage.entries.has(APP_SETTINGS_KEY)).toBe(false);
    expect(appliedIds(storage)).toEqual(["steer-default", "catppuccin-syntax-default"]);
  });

  it("marks itself applied on a fresh install without rewriting settings", async () => {
    const storage = createInMemoryKeyValueStorage();

    await migrateAppSettings(settingsWith("steer"), storage);

    expect(storage.entries.has(APP_SETTINGS_KEY)).toBe(false);
    expect(appliedIds(storage)).toEqual(["steer-default", "catppuccin-syntax-default"]);
  });

  it("keeps unknown migration ids written by a newer client", async () => {
    const storage = createInMemoryKeyValueStorage({
      [SETTINGS_MIGRATIONS_KEY]: JSON.stringify({ applied: ["some-later-migration"] }),
    });

    await migrateAppSettings(settingsWith("interrupt"), storage);

    expect(appliedIds(storage)).toEqual([
      "some-later-migration",
      "steer-default",
      "catppuccin-syntax-default",
    ]);
  });

  it("migrates every mobile 15px content preference to 16px", async () => {
    const storage = createInMemoryKeyValueStorage();
    const settings = { ...settingsWith("steer"), contentFontSize: 15 };

    const result = await migrateAppSettings(settings, storage, undefined, { native: true });

    expect(result.contentFontSize).toBe(16);
    expect(storedContentFontSize(storage)).toBe(16);
    expect(appliedIds(storage)).toEqual([
      "steer-default",
      "mobile-content-16",
      "catppuccin-syntax-default",
    ]);
  });

  it("leaves a 15px web content preference unchanged", async () => {
    const storage = createInMemoryKeyValueStorage();
    const settings = { ...settingsWith("steer"), contentFontSize: 15 };

    const result = await migrateAppSettings(settings, storage, undefined, { native: false });

    expect(result.contentFontSize).toBe(15);
    expect(storedContentFontSize(storage)).toBeUndefined();
    expect(appliedIds(storage)).toEqual(["steer-default", "catppuccin-syntax-default"]);
  });

  it("lets a mobile user choose 15px after the default migration ran", async () => {
    const storage = createInMemoryKeyValueStorage();
    await migrateAppSettings(
      { ...settingsWith("steer"), contentFontSize: 15 },
      storage,
      undefined,
      { native: true },
    );

    const result = await migrateAppSettings(
      { ...settingsWith("steer"), contentFontSize: 15 },
      storage,
      undefined,
      { native: true },
    );

    expect(result.contentFontSize).toBe(15);
  });

  it("stays unmarked when the settings write fails, so a later launch retries", async () => {
    const storage = createFailingWriteStorage(APP_SETTINGS_KEY);

    await expect(migrateAppSettings(settingsWith("interrupt"), storage)).rejects.toThrow();

    expect(appliedIds(storage)).toEqual([]);
  });

  it("re-runs harmlessly when the marker write fails after settings landed", async () => {
    const failing = createFailingWriteStorage(SETTINGS_MIGRATIONS_KEY);
    await expect(migrateAppSettings(settingsWith("interrupt"), failing)).rejects.toThrow();
    expect(storedSendBehavior(failing)).toBe("steer");

    const recovered = createInMemoryKeyValueStorage(Object.fromEntries(failing.entries));
    const result = await migrateAppSettings(settingsWith("steer"), recovered);

    expect(result.sendBehavior).toBe("steer");
    expect(appliedIds(recovered)).toEqual(["steer-default", "catppuccin-syntax-default"]);
  });
});
