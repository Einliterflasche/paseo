import { randomUUID } from "node:crypto";
import { assertPreviewHttpRoute, type PreviewHttpRoute } from "./http-policy.js";

interface RegisteredRoute {
  revision: string;
  route: Readonly<PreviewHttpRoute>;
  description: PreviewRouteDescription;
  available: boolean;
  listed: boolean;
  invalidation: { promise: Promise<void>; resolve(): void };
}

interface PreviewRouteDescription {
  kind?: "external";
  name?: string;
  workspaceId?: string;
  scriptName?: string;
}

type Registration = PreviewHttpRoute & PreviewRouteDescription;

export interface PreviewRouteCapture {
  readonly route: Readonly<PreviewHttpRoute>;
  readonly invalidated: Promise<void>;
  isCurrent(): boolean;
}

export class PreviewRouteError extends Error {
  constructor(
    readonly code:
      | "infrastructure-port"
      | "route-already-registered"
      | "route-not-registered"
      | "routes-closed",
  ) {
    super(code);
    this.name = "PreviewRouteError";
  }
}

/** Registered endpoints only; process lifetime and private exposure need their own owners. */
export class PreviewRoutes {
  private readonly excludedPorts: ReadonlySet<number>;
  private readonly routes = new Map<string, RegisteredRoute>();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor({ excludedPorts }: { excludedPorts: readonly number[] }) {
    this.excludedPorts = new Set(excludedPorts);
  }

  register(route: Registration, acquired?: () => void): void {
    this.add({ route, available: true, acquired });
  }

  registerUnavailable(route: Registration, acquired?: () => void): void {
    this.add({ route, available: false, acquired });
  }

  private add({
    route,
    available,
    acquired,
  }: {
    route: Registration;
    available: boolean;
    acquired?: () => void;
  }): void {
    if (available) this.validate(route);
    else {
      if (this.closed) throw new PreviewRouteError("routes-closed");
      // A stale saved definition can remain visible and removable. Activation
      // through replace() still checks infrastructure exclusions.
      assertPreviewHttpRoute(route);
    }
    if (this.routes.has(route.serviceId)) throw new PreviewRouteError("route-already-registered");
    const record = this.createRecord(route);
    record.available = available;
    this.routes.set(route.serviceId, record);
    acquired?.();
    this.publish();
  }

  replace(route: Registration): void {
    this.validate(route);
    const previous = this.routes.get(route.serviceId);
    if (!previous) throw new PreviewRouteError("route-not-registered");
    this.invalidate(previous);
    this.routes.set(route.serviceId, this.createRecord(route));
    this.publish();
  }

  markUnavailable(serviceId: string): void {
    const route = this.routes.get(serviceId);
    if (route) this.invalidate(route);
    this.publish();
  }

  archive(serviceId: string): void {
    const record = this.routes.get(serviceId);
    if (!record) return;
    record.listed = false;
    this.invalidate(record);
    this.publish();
  }

  capture(serviceId: string): PreviewRouteCapture | null {
    const record = this.routes.get(serviceId);
    if (this.closed || !record?.available) return null;
    return Object.freeze({
      route: record.route,
      invalidated: record.invalidation.promise,
      isCurrent: () => !this.closed && record.available && this.routes.get(serviceId) === record,
    });
  }

  describe() {
    const listed = [...this.routes.values()].filter((record) => record.listed);
    return listed.map(({ route, description, available, revision }) => ({
      serviceId: route.serviceId,
      name: description.name ?? route.serviceId,
      workspaceId: description.workspaceId ?? null,
      scriptName: description.scriptName ?? null,
      port: route.port,
      available: !this.closed && available,
      revision,
      kind: description.kind,
    }));
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }

  close(): void {
    this.closed = true;
    for (const record of this.routes.values()) this.invalidate(record);
    this.publish();
    this.listeners.clear();
  }

  validate(route: PreviewHttpRoute): void {
    if (this.closed) throw new PreviewRouteError("routes-closed");
    assertPreviewHttpRoute(route);
    if (this.excludedPorts.has(route.port)) throw new PreviewRouteError("infrastructure-port");
  }

  private createRecord(route: Registration): RegisteredRoute {
    let resolve = () => {};
    const promise = new Promise<void>((finish) => {
      resolve = finish;
    });
    return {
      revision: randomUUID(),
      route: Object.freeze({ serviceId: route.serviceId, port: route.port, mount: route.mount }),
      description: Object.freeze({
        kind: route.kind,
        name: route.name,
        workspaceId: route.workspaceId,
        scriptName: route.scriptName,
      }),
      available: true,
      listed: true,
      invalidation: { promise, resolve },
    };
  }

  private invalidate(record: RegisteredRoute): void {
    record.available = false;
    record.invalidation.resolve();
  }
}
