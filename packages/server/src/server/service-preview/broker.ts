import { randomBytes, randomUUID } from "node:crypto";
import type { ManagedPreviewServices } from "./managed-services.js";
import type {
  ServicePreviewCloseRequest,
  ServicePreviewPrepareRequest,
  ServicePreviewPrepareResponseMessage,
} from "../messages.js";
import type { PreviewHttpRoute } from "./http-policy.js";
import { previewClock, PREVIEW_OPEN_EXPIRY_MS, type PreviewClock } from "./clock.js";
import { createPreviewTicket } from "./ticket.js";
import type { ExternalPreviewServices } from "./external.js";
import { PreviewRoutes, type PreviewRouteCapture } from "./routes.js";
import {
  PreviewSources,
  type PreviewPhysicalSource,
  type PreviewSourceCapture,
} from "./sources.js";

function signal() {
  const controller = new AbortController();
  let resolve = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return {
    promise,
    signal: controller.signal,
    resolve: () => {
      controller.abort();
      resolve();
    },
  };
}

interface BrowserSession {
  sequence: number;
  phase: "current" | "superseded";
  confirmed: boolean;
  cookieName: string;
  cookieValue: string;
  contributions: Set<Attempt>;
  periods: Map<string, Activation>;
}

interface Activation {
  id: string;
  active: boolean;
  route: PreviewRouteCapture;
  session: BrowserSession;
  jobs: Set<ReturnType<typeof signal>>;
}

export interface PreviewReconciliationWork {
  attempts: number;
  activations: number;
}

interface Attempt {
  attemptId: string;
  bootstrapId: string;
  socket: PreviewPhysicalSource;
  source: PreviewSourceCapture;
  route: PreviewRouteCapture;
  session: BrowserSession;
  mode: "iframe" | "tab";
  state:
    | { phase: "provisional" | "issued"; ticket: string }
    | { phase: "pending" | "active" | "closed" };
  closed: ReturnType<typeof signal>;
  expiresAt: number;
  cancelExpiry: (() => void) | null;
}

interface BrokerOptions {
  sources: PreviewSources;
  routes: PreviewRoutes;
  onFailure(error: unknown): void | Promise<void>;
  clock?: PreviewClock;
  externalServices?: ExternalPreviewServices;
  managedServices?: ManagedPreviewServices;
}

interface PrepareInput {
  socket: PreviewPhysicalSource;
  request: ServicePreviewPrepareRequest;
}

interface CloseInput {
  socket: PreviewPhysicalSource;
  request: ServicePreviewCloseRequest;
}

interface RequestAuthority {
  cookieHeader: string | undefined;
  serviceId: string;
}

export interface PreviewAuthorizedJob {
  readonly activationId: string;
  readonly route: Readonly<PreviewHttpRoute>;
  readonly signal: AbortSignal;
  wait<T>(start: () => T | PromiseLike<T>): Promise<T>;
  write<T>(action: () => T): T;
}

export class PreviewBrokerError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "invalid-bootstrap"
      | "invalid-confirmation"
      | "authorization-ended",
  ) {
    super(code);
    this.name = "PreviewBrokerError";
  }
}

/** Local authority core only. No listener, upstream requests or production bootstrap. */
export class PreviewBroker {
  readonly sources: PreviewSources;
  readonly externalServices: ExternalPreviewServices | null;
  readonly managedServices: ManagedPreviewServices | null;
  private readonly routes: PreviewRoutes;
  private readonly onFailure: BrokerOptions["onFailure"];
  private readonly clock: PreviewClock;
  private readonly attempts = new WeakMap<PreviewPhysicalSource, Map<string, Attempt | null>>();
  private readonly bootstrap = new Map<string, Attempt>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly activeActivations = new Set<Activation>();
  private readonly cookies = new Map<string, BrowserSession>();
  private readonly revisions = new Map<Promise<void>, Set<Attempt>>();
  private readonly catalogListeners = new Set<() => void>();
  private readonly stopCatalog: () => void;
  private readonly stopManagedCatalog: () => void;
  private sequence = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private failure: unknown = null;
  private readonly reconciliationVisits: PreviewReconciliationWork = {
    attempts: 0,
    activations: 0,
  };

  constructor({
    sources,
    routes,
    onFailure,
    clock = previewClock,
    externalServices,
    managedServices,
  }: BrokerOptions) {
    if (externalServices && externalServices.routes !== routes) {
      throw new Error("External previews must share the broker route registry");
    }
    this.sources = sources;
    this.externalServices = externalServices ?? null;
    this.managedServices = managedServices ?? null;
    this.routes = routes;
    this.onFailure = onFailure;
    this.clock = clock;
    this.stopManagedCatalog = managedServices?.subscribe(() => this.publishCatalog()) ?? (() => {});
    this.stopCatalog = routes.subscribe(() => {
      // A lifecycle owner can await remote cancellation after changing a route.
      // End local authority before that owner's synchronous mutation returns.
      this.reconcile();
      this.publishCatalog();
    });
  }

  get diagnostic(): unknown {
    return this.failure;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Terminal feature failure also retires its independently running gateway. */
  get closedSignal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** Cumulative work for capacity measurements, without exposing credentials. */
  get reconciliationWork(): Readonly<PreviewReconciliationWork> {
    return Object.freeze({ ...this.reconciliationVisits });
  }

  describe() {
    const services = this.routes.describe();
    if (this.closed) for (const service of services) service.available = false;
    return {
      version: 1 as const,
      origin: this.sources.controlOrigin,
      ...(this.externalServices && !this.closed ? { externalRegistration: 1 as const } : {}),
      ...(this.managedServices && !this.closed ? { managedRegistration: 1 as const } : {}),
      ...(this.managedServices ? { managedEnrollments: this.managedServices.describe() } : {}),
      services,
    };
  }

  subscribeCatalog(listener: () => void) {
    this.catalogListeners.add(listener);
    return () => {
      this.catalogListeners.delete(listener);
    };
  }

  private publishCatalog() {
    for (const listener of this.catalogListeners) listener();
  }

  async prepare({ socket, request }: PrepareInput): Promise<void> {
    const source = this.sources.capture(socket);
    if (this.closed || !source) throw new PreviewBrokerError("unavailable");
    const reply = (result: ServicePreviewPrepareResponseMessage["payload"]["result"]) =>
      source.send({
        type: "session",
        message: {
          type: "service.preview.prepare.response",
          payload: { requestId: request.requestId, result },
        },
      });
    const sourceAttempts = this.attempts.get(socket) ?? new Map<string, Attempt | null>();
    this.attempts.set(socket, sourceAttempts);
    if (sourceAttempts.has(request.attemptId)) {
      await reply({ status: "error", code: "duplicate-attempt" });
      return;
    }
    sourceAttempts.set(request.attemptId, null);
    const route = this.routes.capture(request.serviceId);
    if (!route) {
      await reply({ status: "error", code: "unavailable" });
      return;
    }
    const key = JSON.stringify([this.sources.epoch, source.principalId, request.browserHandle]);
    let session = this.sessions.get(key);
    if (session?.phase === "superseded") {
      await reply({ status: "error", code: "browser-session-replaced" });
      return;
    }
    if (!session) {
      session = {
        sequence: ++this.sequence,
        phase: "current",
        confirmed: false,
        cookieName: `__Secure-PaseoPreview-${this.sources.epoch}-${randomUUID()}`,
        cookieValue: randomBytes(32).toString("base64url"),
        contributions: new Set(),
        periods: new Map(),
      };
      this.sessions.set(key, session);
      this.cookies.set(session.cookieName, session);
    }
    const ticket = createPreviewTicket();
    const attempt: Attempt = {
      attemptId: request.attemptId,
      bootstrapId: randomUUID(),
      socket,
      source,
      route,
      session,
      mode: request.mode,
      state: { phase: "provisional", ticket },
      closed: signal(),
      expiresAt: this.clock.now() + PREVIEW_OPEN_EXPIRY_MS,
      cancelExpiry: null,
    };
    // Reservation precedes send, so a Close arriving during delivery can name it.
    sourceAttempts.set(request.attemptId, attempt);
    this.bootstrap.set(attempt.bootstrapId, attempt);
    this.observeRevision(source.invalidated, attempt);
    this.observeRevision(route.invalidated, attempt);
    this.armExpiry(attempt);
    const delivery = reply({
      status: "prepared",
      expiresInMs: Math.max(0, attempt.expiresAt - this.clock.now()),
      attemptId: request.attemptId,
      bootstrapId: attempt.bootstrapId,
      ticket,
      serviceId: request.serviceId,
      mode: request.mode,
    });
    const outcome = await Promise.race([delivery, attempt.closed.promise.then(() => "closed")]);
    if (outcome === "queued" && attempt.state.phase === "provisional" && this.isCurrent(attempt)) {
      attempt.state = { phase: "issued", ticket };
    } else {
      this.endAttempt(attempt);
      this.reconcile();
    }
  }

  async closeAttempt({ socket, request }: CloseInput): Promise<void> {
    const source = this.sources.capture(socket);
    if (this.closed || !source) throw new PreviewBrokerError("unavailable");
    const sourceAttempts = this.attempts.get(socket) ?? new Map<string, Attempt | null>();
    this.attempts.set(socket, sourceAttempts);
    const attempt = sourceAttempts.get(request.attemptId);
    if (attempt) this.endAttempt(attempt);
    else sourceAttempts.set(request.attemptId, null);
    this.reconcile();
    await source.send({
      type: "session",
      message: {
        type: "service.preview.close.response",
        payload: {
          requestId: request.requestId,
          result: { status: "closed", attemptId: request.attemptId },
        },
      },
    });
  }

  redeem({
    bootstrapId,
    ticket,
    mode,
  }: {
    bootstrapId: string;
    ticket: string;
    mode: "iframe" | "tab";
  }) {
    const attempt = this.bootstrap.get(bootstrapId);
    if (
      !attempt ||
      attempt.state.phase !== "issued" ||
      attempt.state.ticket !== ticket ||
      attempt.mode !== mode ||
      !this.isCurrent(attempt)
    ) {
      throw new PreviewBrokerError("invalid-bootstrap");
    }
    attempt.state = { phase: "pending" };
    return {
      cookieName: attempt.session.cookieName,
      cookieValue: attempt.session.cookieValue,
      bootstrapId,
      serviceId: attempt.route.route.serviceId,
      mode: attempt.mode,
    };
  }

  confirm({
    bootstrapId,
    cookieHeader,
    mode,
  }: {
    bootstrapId: string;
    cookieHeader: string | undefined;
    mode: "iframe" | "tab";
  }) {
    const candidates = this.cookieCandidates(cookieHeader);
    this.retireEarlier(candidates);
    const attempt = this.bootstrap.get(bootstrapId);
    if (
      !attempt ||
      attempt.state.phase !== "pending" ||
      attempt.mode !== mode ||
      !this.isCurrent(attempt) ||
      candidates[0] !== attempt.session
    ) {
      throw new PreviewBrokerError("invalid-confirmation");
    }
    for (const old of candidates.slice(1)) old.phase = "superseded";
    // Reconcile before adding authority, including invalidations whose promise
    // callbacks have not run. A fresh contribution cannot keep an ended period alive.
    this.reconcile();
    if (attempt.state.phase !== "pending" || !this.isCurrent(attempt)) {
      throw new PreviewBrokerError("invalid-confirmation");
    }
    attempt.session.confirmed = true;
    attempt.state = { phase: "active" };
    attempt.cancelExpiry?.();
    attempt.cancelExpiry = null;
    attempt.session.contributions.add(attempt);
    const serviceId = attempt.route.route.serviceId;
    if (!attempt.session.periods.get(serviceId)?.active) {
      const activation: Activation = {
        id: randomUUID(),
        active: true,
        route: attempt.route,
        session: attempt.session,
        jobs: new Set(),
      };
      attempt.session.periods.set(serviceId, activation);
      this.activeActivations.add(activation);
    }
    return { serviceId, attemptId: attempt.attemptId, mode: attempt.mode };
  }

  async run<T>(
    authority: RequestAuthority,
    work: (job: PreviewAuthorizedJob) => T | PromiseLike<T>,
  ): Promise<T> {
    const activation = this.selectActivation(authority);
    if (!activation) throw new PreviewBrokerError("authorization-ended");
    const ended = signal();
    let terminal = false;
    activation.jobs.add(ended);
    const current = () => {
      this.reconcile();
      if (terminal || !activation.active) throw new PreviewBrokerError("authorization-ended");
    };
    const cancelled = ended.promise.then<never>(() => {
      throw new PreviewBrokerError("authorization-ended");
    });
    cancelled.catch(() => {});
    const job: PreviewAuthorizedJob = Object.freeze({
      activationId: activation.id,
      route: activation.route.route,
      signal: ended.signal,
      wait: async <V>(start: () => V | PromiseLike<V>): Promise<V> => {
        current();
        const pending = Promise.resolve().then(() => {
          current();
          return start();
        });
        const value = await Promise.race([pending, cancelled]);
        current();
        return value;
      },
      write: <V>(action: () => V): V => {
        current();
        return action();
      },
    });
    try {
      return await job.wait(() => work(job));
    } finally {
      terminal = true;
      ended.resolve();
      activation.jobs.delete(ended);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const attempt of this.bootstrap.values()) this.endAttempt(attempt);
    this.reconcile();
    // A closed broker can never admit again. No replay/replacement records or
    // empty revision groups are needed beyond this owner's terminal lifetime.
    this.sessions.clear();
    this.cookies.clear();
    this.revisions.clear();
    this.stopCatalog();
    this.stopManagedCatalog();
    try {
      this.managedServices?.close();
    } catch (error) {
      void this.reportFailure(error);
    }
    try {
      this.externalServices?.close();
    } catch (error) {
      void this.reportFailure(error);
    }
    try {
      this.publishCatalog();
    } finally {
      this.catalogListeners.clear();
    }
  }

  /** Persistence belongs to the feature lifetime even after routing is revoked. */
  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.externalServices?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.managedServices?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Preview broker shutdown failed");
    }
  }

  private isCurrent(attempt: Attempt): boolean {
    return (
      !this.closed &&
      attempt.state.phase !== "closed" &&
      (attempt.state.phase === "active" || this.clock.now() < attempt.expiresAt) &&
      attempt.session.phase === "current" &&
      attempt.source.authorityEpoch === this.sources.epoch &&
      attempt.source.isCurrent() &&
      attempt.route.isCurrent()
    );
  }

  private endAttempt(attempt: Attempt): void {
    if (attempt.state.phase === "closed") return;
    attempt.state = { phase: "closed" };
    attempt.cancelExpiry?.();
    attempt.cancelExpiry = null;
    // Keep only a replay tombstone for this physical connection. Ended Open
    // attempts must not keep sockets alive or join every later chunk's authority
    // reconciliation; neither their ticket nor their full capture is needed.
    this.attempts.get(attempt.socket)?.set(attempt.attemptId, null);
    this.bootstrap.delete(attempt.bootstrapId);
    attempt.closed.resolve();
    attempt.session.contributions.delete(attempt);
    this.revisions.get(attempt.source.invalidated)?.delete(attempt);
    this.revisions.get(attempt.route.invalidated)?.delete(attempt);
  }

  private armExpiry(attempt: Attempt): void {
    if (attempt.state.phase === "closed" || attempt.state.phase === "active") return;
    const remaining = attempt.expiresAt - this.clock.now();
    if (remaining <= 0) {
      this.endAttempt(attempt);
      this.reconcile();
      return;
    }
    attempt.cancelExpiry = this.clock.schedule({
      delayMs: remaining,
      callback: () => {
        attempt.cancelExpiry = null;
        try {
          // Timers may run early or late. The deadline, also checked by every
          // admission transition, owns expiry rather than callback scheduling.
          this.armExpiry(attempt);
        } catch (error) {
          void this.reportFailure(error);
        }
      },
    });
  }

  private async reportFailure(error: unknown): Promise<void> {
    this.failure = error;
    try {
      this.close();
    } catch {
      // close marks the broker and every attempt terminal before notifying UI.
    }
    try {
      await this.onFailure(error);
    } catch {
      /* Preserve the diagnostic without rejecting an observer continuation. */
    }
  }

  private observeRevision(notification: Promise<void>, attempt: Attempt): void {
    let group = this.revisions.get(notification);
    if (!group) {
      group = new Set();
      this.revisions.set(notification, group);
      const owned = group;
      void notification
        .then(() => {
          for (const item of owned) this.endAttempt(item);
          this.revisions.delete(notification);
          this.reconcile();
          return undefined;
        })
        .catch((error) => {
          // The consumer continuation is contained even though the notification
          // itself never rejects. End owned work before reporting the failure.
          return this.reportFailure(error);
        });
    }
    group.add(attempt);
  }

  private cookieCandidates(header: string | undefined): BrowserSession[] {
    const values = new Map<string, string>();
    for (const pair of (header ?? "").split(";")) {
      const separator = pair.indexOf("=");
      if (separator < 0) continue;
      const name = pair.slice(0, separator).trim();
      const session = this.cookies.get(name);
      if (!session || session.phase !== "current") continue;
      if (values.has(name)) return [];
      values.set(name, pair.slice(separator + 1).trim());
    }
    const candidates: BrowserSession[] = [];
    for (const [name, value] of values) {
      const session = this.cookies.get(name);
      if (session?.cookieValue === value) candidates.push(session);
    }
    return candidates.sort((a, b) => b.sequence - a.sequence);
  }

  private retireEarlier(candidates: BrowserSession[]): void {
    const confirmed = candidates.find((session) => session.confirmed);
    if (confirmed)
      for (const old of candidates) {
        if (old.sequence < confirmed.sequence) old.phase = "superseded";
      }
    this.reconcile();
  }

  private hasAuthority(session: BrowserSession, serviceId: string): boolean {
    return (
      !this.closed &&
      session.phase === "current" &&
      [...session.contributions].some(
        (attempt) =>
          attempt.route.route.serviceId === serviceId &&
          attempt.state.phase === "active" &&
          this.isCurrent(attempt),
      )
    );
  }

  private selectActivation({ cookieHeader, serviceId }: RequestAuthority): Activation | null {
    const candidates = this.cookieCandidates(cookieHeader);
    this.retireEarlier(candidates);
    const session = candidates[0];
    if (!session || !this.hasAuthority(session, serviceId)) return null;
    const activation = session.periods.get(serviceId);
    return activation?.active ? activation : null;
  }

  private endActivation(activation: Activation): void {
    if (!activation.active) return;
    activation.active = false;
    // Cancellation can synchronously confirm fresh authority. Remove this exact
    // lifetime before callbacks; the old guards keep their terminal object.
    this.activeActivations.delete(activation);
    const serviceId = activation.route.route.serviceId;
    if (activation.session.periods.get(serviceId) === activation) {
      activation.session.periods.delete(serviceId);
    }
    for (const job of activation.jobs) job.resolve();
    activation.jobs.clear();
  }

  private reconcile(): void {
    for (const attempt of this.bootstrap.values()) {
      this.reconciliationVisits.attempts += 1;
      if (attempt.state.phase !== "closed" && !this.isCurrent(attempt)) this.endAttempt(attempt);
    }
    for (const activation of this.activeActivations) {
      this.reconciliationVisits.activations += 1;
      if (!this.hasAuthority(activation.session, activation.route.route.serviceId))
        this.endActivation(activation);
    }
  }
}
