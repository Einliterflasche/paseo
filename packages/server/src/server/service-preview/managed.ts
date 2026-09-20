import type { ServiceProxySubsystem } from "../service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "../workspace-script-runtime-store.js";
import { PreviewRoutes, PreviewRouteError } from "./routes.js";
import { PreviewHttpPolicyError, type PreviewHttpRoute } from "./http-policy.js";
import { managedPreviewServiceId } from "./policy.js";

export interface ManagedPreviewEnrollment {
  serviceId: string;
  workspaceId: string;
  scriptName: string;
  mount: PreviewHttpRoute["mount"];
  name: string;
}

interface ManagedPreviewRecord {
  enrollment: ManagedPreviewEnrollment;
  enabled: boolean;
  binding: { port: number; terminalId: string } | null;
  registered: boolean;
  qualification: AbortController | null;
}

interface ManagedPreviewOptions {
  routes: PreviewRoutes;
  runtime: WorkspaceScriptRuntimeStore;
  endpoints: Pick<
    ServiceProxySubsystem,
    "getWorkspaceHealthTargets" | "subscribeWorkspaceServices"
  >;
  qualifyHttp(port: number, signal: AbortSignal): boolean | Promise<boolean>;
  onFailure(error: unknown): void | Promise<void>;
}

export class ManagedPreviewError extends Error {
  constructor(readonly code: "unavailable" | "already-enrolled" | "not-running") {
    super(code);
    this.name = "ManagedPreviewError";
  }
}

/** Explicit mount enrollment; existing runtime and endpoint owners supply every binding. */
export class ManagedPreviewRoutes {
  private readonly records = new Map<string, ManagedPreviewRecord>();
  private readonly blockedWorkspaces = new Set<string>();
  private readonly unsubscribe: Array<() => void>;
  private closed = false;
  private failure: unknown = null;

  constructor(private readonly options: ManagedPreviewOptions) {
    const changed = (workspaceId: string) => this.refresh(workspaceId);
    this.unsubscribe = [
      options.runtime.subscribe(changed),
      options.endpoints.subscribeWorkspaceServices(changed),
    ];
  }

  get diagnostic(): unknown {
    return this.failure;
  }

  enroll(enrollment: ManagedPreviewEnrollment): void {
    const binding = this.resolve(enrollment);
    if (binding) this.options.routes.validate({ ...enrollment, port: binding.port });
    this.add(enrollment, true);
  }

  /** Saved mount policy may outlive a stopped script; it never starts that script. */
  restore(enrollment: ManagedPreviewEnrollment): void {
    this.add(enrollment, false);
  }

  /** Every managed service is previewable without a separate enrollment step. */
  restoreDefaults(workspaceId: string): void {
    if (this.closed || this.blockedWorkspaces.has(workspaceId)) return;
    for (const runtime of this.options.runtime.listForWorkspace(workspaceId)) {
      if (runtime.type !== "service") continue;
      this.restoreDefault(workspaceId, runtime.scriptName);
    }
  }

  restoreDefault(workspaceId: string, scriptName: string): void {
    if (this.closed || this.blockedWorkspaces.has(workspaceId)) return;
    const duplicate = [...this.records.values()].some(
      ({ enrollment }) =>
        enrollment.workspaceId === workspaceId && enrollment.scriptName === scriptName,
    );
    if (duplicate) return;
    this.add(
      {
        serviceId: managedPreviewServiceId({ workspaceId, scriptName }),
        workspaceId,
        scriptName,
        mount: "strip",
        name: scriptName,
      },
      false,
    );
  }

  private add(enrollment: ManagedPreviewEnrollment, requireRunning: boolean): void {
    if (this.closed || this.blockedWorkspaces.has(enrollment.workspaceId))
      throw new ManagedPreviewError("unavailable");
    const retained = this.records.get(enrollment.serviceId);
    if (
      retained &&
      !retained.enabled &&
      retained.enrollment.workspaceId === enrollment.workspaceId &&
      retained.enrollment.scriptName === enrollment.scriptName
    ) {
      retained.enrollment = { ...enrollment };
      retained.enabled = true;
      this.refresh(enrollment.workspaceId);
      return;
    }
    const duplicate = [...this.records.values()].some(
      ({ enrollment: existing }) =>
        existing.serviceId === enrollment.serviceId ||
        (existing.workspaceId === enrollment.workspaceId &&
          existing.scriptName === enrollment.scriptName),
    );
    const existingRoute = this.options.routes
      .describe()
      .some((route) => route.serviceId === enrollment.serviceId);
    if (duplicate || existingRoute) throw new ManagedPreviewError("already-enrolled");
    const binding = this.resolve(enrollment);
    if (!binding && requireRunning) throw new ManagedPreviewError("not-running");
    const record: ManagedPreviewRecord = {
      enrollment: { ...enrollment },
      enabled: true,
      binding: null,
      registered: false,
      qualification: null,
    };
    this.records.set(enrollment.serviceId, record);
    if (!binding) return;
    try {
      this.qualify(record, binding);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Preview enrollment owns routing only; the supervised script keeps running. */
  disable(serviceId: string): void {
    const record = this.records.get(serviceId);
    if (!record) return;
    record.enabled = false;
    this.invalidate(record);
    if (record.registered) this.options.routes.archive(serviceId);
  }

  /** Called before archive visibility changes; clearing never restores old authority. */
  blockWorkspace(workspaceId: string): void {
    this.blockedWorkspaces.add(workspaceId);
    this.refresh(workspaceId);
  }

  unblockWorkspace(workspaceId: string): void {
    this.blockedWorkspaces.delete(workspaceId);
    this.refresh(workspaceId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.unsubscribe) {
      try {
        stop();
      } catch (error) {
        this.report(error);
      }
    }
    for (const record of this.records.values()) {
      try {
        this.invalidate(record);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private resolve(enrollment: ManagedPreviewEnrollment) {
    const runtime = this.options.runtime.get(enrollment);
    if (!runtime || runtime.type !== "service" || runtime.lifecycle !== "running") return null;
    const target = this.options.endpoints
      .getWorkspaceHealthTargets(enrollment.workspaceId)
      .find((candidate) => candidate.scriptName === enrollment.scriptName);
    if (!target) return null;
    return { port: target.port, terminalId: runtime.terminalId };
  }

  private synchronize(workspaceId: string): void {
    if (this.closed) return;
    for (const record of this.records.values()) {
      if (!record.enabled || record.enrollment.workspaceId !== workspaceId) continue;
      const binding = this.blockedWorkspaces.has(workspaceId)
        ? null
        : this.resolve(record.enrollment);
      if (!binding) {
        this.invalidate(record);
        continue;
      }
      const unchanged =
        record.binding?.port === binding.port && record.binding.terminalId === binding.terminalId;
      if (unchanged) continue;
      this.qualify(record, binding);
    }
  }

  private refresh(workspaceId: string): void {
    try {
      this.synchronize(workspaceId);
    } catch (error) {
      this.fail(error);
    }
  }

  private invalidate(record: ManagedPreviewRecord): void {
    record.qualification?.abort();
    record.qualification = null;
    record.binding = null;
    if (record.registered) this.options.routes.markUnavailable(record.enrollment.serviceId);
  }

  private qualify(
    record: ManagedPreviewRecord,
    binding: { port: number; terminalId: string },
  ): void {
    this.invalidate(record);
    record.binding = binding;
    const qualification = new AbortController();
    record.qualification = qualification;
    const result = this.options.qualifyHttp(binding.port, qualification.signal);
    if (typeof result === "boolean") {
      record.qualification = null;
      if (result) this.activate(record, binding);
      return;
    }
    void result.then(
      (supported) => {
        if (
          this.closed ||
          qualification.signal.aborted ||
          record.qualification !== qualification ||
          record.binding?.port !== binding.port ||
          record.binding.terminalId !== binding.terminalId
        )
          return undefined;
        record.qualification = null;
        if (!supported) return undefined;
        try {
          this.activate(record, binding);
        } catch (error) {
          this.fail(error);
        }
        return undefined;
      },
      (error) => {
        if (qualification.signal.aborted) return undefined;
        this.fail(error);
        return undefined;
      },
    );
  }

  private activate(
    record: ManagedPreviewRecord,
    binding: { port: number; terminalId: string },
  ): void {
    const route = { ...record.enrollment, port: binding.port };
    try {
      if (record.registered) this.options.routes.replace(route);
      else
        this.options.routes.register(route, () => {
          record.registered = true;
        });
    } catch (error) {
      if (
        (error instanceof PreviewRouteError && error.code === "infrastructure-port") ||
        (error instanceof PreviewHttpPolicyError && error.code === "invalid-route")
      ) {
        // An invalid endpoint is local to this enrollment. Other live services
        // remain available, and a later valid binding can recover this one.
        this.invalidate(record);
        this.report(error);
        return;
      }
      throw error;
    }
    record.binding = binding;
  }

  private fail(error: unknown): void {
    this.report(error);
    this.close();
  }

  private report(error: unknown): void {
    if (this.failure !== null) return;
    this.failure = error;
    void this.deliverDiagnostic(error);
  }

  private async deliverDiagnostic(error: unknown): Promise<void> {
    try {
      await this.options.onFailure(error);
    } catch {
      /* The original failure remains available. */
    }
  }
}
