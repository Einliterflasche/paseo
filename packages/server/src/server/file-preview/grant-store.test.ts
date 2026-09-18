import { describe, expect, test } from "vitest";
import { PreviewGrantStore } from "./grant-store.js";

const BASE_INPUT = {
  sessionId: "session-1",
  absolutePath: "/tmp/clip.mp4",
  fileName: "clip.mp4",
  mimeType: "video/mp4",
  identity: "1:100",
};

describe("PreviewGrantStore", () => {
  test("reuses the same token for the same session and file", () => {
    const store = new PreviewGrantStore();
    const first = store.issueGrant(BASE_INPUT);
    const second = store.issueGrant(BASE_INPUT);
    expect(second.token).toBe(first.token);
  });

  test("issues independent tokens per session even for the same file", () => {
    const store = new PreviewGrantStore();
    const a = store.issueGrant({ ...BASE_INPUT, sessionId: "session-a" });
    const b = store.issueGrant({ ...BASE_INPUT, sessionId: "session-b" });
    expect(a.token).not.toBe(b.token);
  });

  test("mints a fresh token and drops the stale one when the file's identity changes", () => {
    const store = new PreviewGrantStore();
    const original = store.issueGrant(BASE_INPUT);
    const replaced = store.issueGrant({ ...BASE_INPUT, identity: "1:200" });

    expect(replaced.token).not.toBe(original.token);
    expect(store.getGrant(original.token)).toBeNull();
    expect(store.getGrant(replaced.token)).toEqual(replaced);
  });

  test("mints a fresh token and drops the stale one when the MIME type changes", () => {
    const store = new PreviewGrantStore();
    const original = store.issueGrant(BASE_INPUT);
    const replaced = store.issueGrant({ ...BASE_INPUT, mimeType: "video/webm" });

    expect(replaced.token).not.toBe(original.token);
    expect(store.getGrant(original.token)).toBeNull();
  });

  test("revoking a session deletes every grant it holds and forgets the session", () => {
    const store = new PreviewGrantStore();
    const grant = store.issueGrant(BASE_INPUT);
    store.issueGrant({ ...BASE_INPUT, absolutePath: "/tmp/other.mp4" });

    store.revokeSession(BASE_INPUT.sessionId);

    expect(store.getGrant(grant.token)).toBeNull();
    expect(store.hasSessionGrants(BASE_INPUT.sessionId)).toBe(false);
  });

  test("revoking one session leaves another session's grants intact", () => {
    const store = new PreviewGrantStore();
    const a = store.issueGrant({ ...BASE_INPUT, sessionId: "session-a" });
    const b = store.issueGrant({ ...BASE_INPUT, sessionId: "session-b" });

    store.revokeSession("session-a");

    expect(store.getGrant(a.token)).toBeNull();
    expect(store.getGrant(b.token)).toEqual(b);
  });

  test("returns null for an unknown token", () => {
    const store = new PreviewGrantStore();
    expect(store.getGrant("unknown-token")).toBeNull();
  });

  test("revoking a session with no grants is a no-op", () => {
    const store = new PreviewGrantStore();
    expect(() => store.revokeSession("never-issued")).not.toThrow();
  });
});
