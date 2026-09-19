import { randomUUID } from "node:crypto";
import { OWNER_PERMISSIONS, type DaemonPermission } from "../authorization/index.js";
import type { WSOutboundMessage } from "../messages.js";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";

// Development-only negotiation until a reviewed preview protocol is advertised.
export const PREVIEW_SOURCE_CAPABILITY = CLIENT_CAPS.servicePreview;

export interface PreviewPhysicalSource {
  readonly readyState: number;
}

interface DirectSourceAdmission {
  socket: PreviewPhysicalSource;
  connectionId: string;
  principalId: string;
  origin: string | undefined;
  permissions: readonly DaemonPermission[];
  send: (frame: string) => Promise<boolean>;
}

interface SourceRecord {
  admission: DirectSourceAdmission;
  permissionCeiling: ReadonlySet<DaemonPermission>;
  revision: number;
  negotiated: boolean;
  deliveries: Set<(outcome: PreviewReplyOutcome) => void>;
  invalidation: SourceInvalidation;
}

interface SourceInvalidation {
  promise: Promise<void>;
  resolve(): void;
}

function createInvalidation(): SourceInvalidation {
  let resolve = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

interface SourceReply {
  source: SourceRecord;
  isCurrent: () => boolean;
  message: WSOutboundMessage;
}

export type PreviewReplyOutcome = "queued" | "failed" | "invalidated";

export interface PreviewSourceCapture {
  readonly connectionId: string;
  readonly principalId: string;
  readonly controlOrigin: string;
  readonly authorityEpoch: string;
  /** Resolves on observed invalidation; callers still check currentness at commit. */
  readonly invalidated: Promise<void>;
  isCurrent(): boolean;
  send(message: WSOutboundMessage): Promise<PreviewReplyOutcome>;
}

export class PreviewSourceError extends Error {
  constructor(readonly code: "invalid-control-origin" | "source-already-admitted") {
    super(code);
    this.name = "PreviewSourceError";
  }
}

/**
 * Owns verified direct-owner inputs and exact-source replies. No grants or gateway traffic.
 * The daemon's password is captured at startup; changing it requires a new owner.
 */
export class PreviewSources {
  private readonly authorityEpoch = randomUUID();
  private readonly sources = new Map<PreviewPhysicalSource, SourceRecord>();
  private readonly principalPermissions = new Map<string, ReadonlySet<DaemonPermission>>([
    ["owner", new Set(OWNER_PERMISSIONS)],
  ]);
  private enabled = true;
  private closed = false;

  constructor(readonly controlOrigin: string) {
    const url = new URL(controlOrigin);
    if (url.protocol !== "https:" || url.origin !== controlOrigin) {
      throw new PreviewSourceError("invalid-control-origin");
    }
  }

  get epoch(): string {
    return this.authorityEpoch;
  }

  // Only the verified-password branch of the direct transport calls this.
  admitDirectOwner(admission: DirectSourceAdmission): void {
    if (this.closed || admission.origin !== this.controlOrigin) return;
    if (admission.principalId !== "owner") return;
    if (this.sources.has(admission.socket)) {
      throw new PreviewSourceError("source-already-admitted");
    }
    this.sources.set(admission.socket, {
      admission: { ...admission, permissions: [...admission.permissions] },
      permissionCeiling: new Set(admission.permissions),
      revision: 0,
      negotiated: false,
      deliveries: new Set(),
      invalidation: createInvalidation(),
    });
  }

  negotiate(socket: PreviewPhysicalSource, capabilities: Record<string, unknown> | null): void {
    const source = this.sources.get(socket);
    if (!source) return;
    const negotiated = capabilities?.[PREVIEW_SOURCE_CAPABILITY] === 1;
    if (source.negotiated !== negotiated) this.invalidate(source);
    source.negotiated = negotiated;
  }

  capture(socket: PreviewPhysicalSource): PreviewSourceCapture | null {
    const source = this.sources.get(socket);
    if (!source || !this.isEligible(source)) return null;
    const revision = source.revision;
    const isCurrent = () => source.revision === revision && this.isEligible(source);
    return Object.freeze({
      connectionId: source.admission.connectionId,
      principalId: source.admission.principalId,
      controlOrigin: this.controlOrigin,
      authorityEpoch: this.authorityEpoch,
      invalidated: source.invalidation.promise,
      isCurrent,
      send: (message: WSOutboundMessage) => this.send({ source, isCurrent, message }),
    });
  }

  replacePrincipalPermissions(principalId: string, permissions: readonly DaemonPermission[]): void {
    this.principalPermissions.set(principalId, new Set(permissions));
    for (const source of this.sources.values()) {
      if (source.admission.principalId === principalId) this.invalidate(source);
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const source of this.sources.values()) this.invalidate(source);
  }

  detach(socket: PreviewPhysicalSource): void {
    const source = this.sources.get(socket);
    if (source) this.invalidate(source);
    this.sources.delete(socket);
  }

  close(): void {
    this.closed = true;
    for (const source of this.sources.values()) this.invalidate(source);
    this.sources.clear();
  }

  private invalidate(source: SourceRecord): void {
    source.revision += 1;
    source.invalidation.resolve();
    source.invalidation = createInvalidation();
    for (const finish of source.deliveries) finish("invalidated");
  }

  private send({ source, isCurrent, message }: SourceReply): Promise<PreviewReplyOutcome> {
    if (!isCurrent()) return Promise.resolve("invalidated");
    let frame: string;
    try {
      frame = JSON.stringify(message);
    } catch {
      return Promise.resolve("failed");
    }
    if (!isCurrent()) return Promise.resolve("invalidated");
    return new Promise((resolve) => {
      let finished = false;
      const finish = (outcome: PreviewReplyOutcome) => {
        if (finished) return;
        finished = true;
        source.deliveries.delete(finish);
        resolve(outcome);
      };
      source.deliveries.add(finish);
      // The transport may synchronously cause detach while creating its promise.
      // Always observe that promise, including a rejection after invalidation.
      let delivery: Promise<boolean>;
      try {
        delivery = source.admission.send(frame);
      } catch {
        finish("failed");
        return;
      }
      delivery.then(
        (queued) => {
          if (!isCurrent()) {
            return finish("invalidated");
          }
          return finish(queued ? "queued" : "failed");
        },
        () => finish("failed"),
      );
    });
  }

  private isEligible(source: SourceRecord): boolean {
    const { socket, principalId } = source.admission;
    const attached = this.sources.get(socket) === source;
    const permitted = this.principalPermissions.get(principalId)?.has("daemon.manage") === true;
    return (
      !this.closed &&
      this.enabled &&
      attached &&
      socket.readyState === 1 &&
      source.negotiated &&
      source.permissionCeiling.has("daemon.manage") &&
      permitted
    );
  }
}
