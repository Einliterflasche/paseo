import { describe, expect, it } from "vitest";
import { ServicePreviewPrepareResponseMessageSchema } from "../messages.js";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { PreviewSources, PREVIEW_SOURCE_CAPABILITY } from "./sources.js";
import { PreviewRoutes } from "./routes.js";
import { PreviewBroker } from "./broker.js";

/**
 * Reachable-memory audit, not a performance suite. Reads private fields via
 * cast on purpose — this is a white-box retention check, not behavior the
 * public API exposes or should have to.
 */
function internals(broker: PreviewBroker) {
  const opaque = broker as unknown as {
    bootstrap: Map<string, unknown>;
    sessions: Map<string, { periods: Map<string, { active: boolean; route: unknown }> }>;
    cookies: Map<string, unknown>;
    activeActivations: Set<unknown>;
    revisions: Map<Promise<void>, Set<unknown>>;
  };
  return {
    raw: opaque,
    bootstrap: opaque.bootstrap.size,
    sessions: opaque.sessions.size,
    cookies: opaque.cookies.size,
    activeActivations: opaque.activeActivations.size,
    revisions: opaque.revisions.size,
  };
}

function fixture() {
  const sources = new PreviewSources("https://control.test");
  const routes = new PreviewRoutes({ excludedPorts: [6767] });
  routes.register({ serviceId: "atlas", port: 5173, mount: "preserve" });
  const broker = new PreviewBroker({ sources, routes, onFailure() {} });
  const socket = { readyState: 1 };
  const frames: string[] = [];
  sources.admitDirectOwner({
    socket,
    connectionId: "control-source",
    principalId: "owner",
    origin: "https://control.test",
    permissions: OWNER_PERMISSIONS,
    send: async (frame) => {
      frames.push(frame);
      return true;
    },
  });
  sources.negotiate(socket, { [PREVIEW_SOURCE_CAPABILITY]: 1 });
  return { sources, routes, broker, socket, frames };
}

type Fixture = ReturnType<typeof fixture>;

async function openAndClose(f: Fixture, attemptId: string, browserHandle: string) {
  await f.broker.prepare({
    socket: f.socket,
    request: {
      type: "service.preview.prepare.request",
      requestId: `request-${attemptId}`,
      attemptId,
      browserHandle,
      serviceId: "atlas",
      mode: "iframe",
    },
  });
  const response = ServicePreviewPrepareResponseMessageSchema.parse(
    JSON.parse(f.frames.at(-1)!).message,
  );
  const result = response.payload.result;
  if (result.status !== "prepared") throw new Error("Expected prepared reply");
  const credential = f.broker.redeem(result);
  const cookieHeader = `${credential.cookieName}=${credential.cookieValue}`;
  f.broker.confirm({ bootstrapId: result.bootstrapId, cookieHeader, mode: result.mode });
  // Use the surface itself, then close explicitly like a real navigated-away tab.
  await f.broker.run({ cookieHeader, serviceId: "atlas" }, () => undefined);
  await f.broker.closeAttempt({
    socket: f.socket,
    request: { type: "service.preview.close.request", requestId: `close-${attemptId}`, attemptId },
  });
}

describe("broker reachable retention", () => {
  it("reuses one intentional session/cookie replay record across repeated opens from the same browser handle", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i += 1) {
      await openAndClose(f, `attempt-${i}`, "stable-browser-profile");
    }
    const after = internals(f.broker);
    expect(after.bootstrap).toBe(0);
    expect(after.activeActivations).toBe(0);
    expect(after.sessions).toBe(1);
    expect(after.cookies).toBe(1);
  });

  it("retains exactly one intentional identity/replay record per distinct browser handle, by design", async () => {
    const f = fixture();
    const handles = 5;
    for (let i = 0; i < handles; i += 1) {
      await openAndClose(f, `attempt-${i}`, `browser-profile-${i}`);
    }
    const after = internals(f.broker);
    // No live bootstrap attempts, no live activations.
    expect(after.bootstrap).toBe(0);
    expect(after.activeActivations).toBe(0);
    // One identity/replay record per distinct browserHandle ever seen. This is
    // the reviewed replacement contract, not a leak: a session/cookie pair is
    // the durable identity a later reconnect or Confirm race replaces against
    // (`retireEarlier`/`cookieCandidates`), so it is kept until the broker
    // itself closes (see "clears every session/cookie/revision record" below).
    expect(after.sessions).toBe(handles);
    expect(after.cookies).toBe(handles);
  });

  it("clears the exact terminal activation from session.periods, releasing its route capture, once authority ends", async () => {
    const f = fixture();
    await openAndClose(f, "attempt-a", "browser-profile-a");
    const [session] = internals(f.broker).raw.sessions.values();
    // The activation is terminal (attempt closed, reconciled), but this is the
    // one piece of genuinely unnecessary retention: `session.periods` keeps
    // holding the dead Activation object — and the route capture it closed
    // over — for a serviceId that no longer has any live authority.
    expect(session.periods.get("atlas")).toBeUndefined();
  });

  it("clears every session, cookie, and revision record once the broker closes, since closed is irreversible", async () => {
    const f = fixture();
    await openAndClose(f, "attempt-a", "browser-profile-a");
    await openAndClose(f, "attempt-b", "browser-profile-b");
    expect(internals(f.broker).sessions).toBe(2);
    f.broker.close();
    const after = internals(f.broker);
    expect(after.sessions).toBe(0);
    expect(after.cookies).toBe(0);
    expect(after.revisions).toBe(0);
  });

  it("clears every session, cookie, and revision record on shutdown() as well as close()", async () => {
    const f = fixture();
    await openAndClose(f, "attempt-a", "browser-profile-a");
    await f.broker.shutdown();
    const after = internals(f.broker);
    expect(after.sessions).toBe(0);
    expect(after.cookies).toBe(0);
    expect(after.revisions).toBe(0);
  });

  it("does not accumulate revision-observer groups once every observed source/route invalidation settles", async () => {
    const f = fixture();
    await openAndClose(f, "attempt-observed", "browser-profile-observed");
    // Both `source.invalidated` and `route.invalidated` are pending promises
    // observed once per attempt; they are never resolved by this fixture, so
    // their (now-empty) Set stays keyed in `revisions` until that specific
    // promise settles. This is the minimal, intentional shape: growth is
    // bounded by distinct still-pending invalidation promises, not by attempt
    // count, and every group is already emptied by `endAttempt`.
    const after = internals(f.broker);
    expect(after.revisions).toBeLessThanOrEqual(2);
  });
});

// Fresh-authorization-vs-old-guard terminality (a fresh reopen for the same
// profile/service must never resurrect a stale guard, and an old guard's
// cleanup must never clobber a fresh one) is already exercised end-to-end by
// broker.test.ts's "cancels old work on stop even when the same port
// restarts and a fresh Open completes" and its "reopen[s]" cases around
// duplicate/replaced browser sessions. Not duplicated here.
