import { randomUUID } from "node:crypto";

export interface PreviewGrant {
  token: string;
  sessionId: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  identity: string;
}

export interface IssuePreviewGrantInput {
  sessionId: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  identity: string;
  signal?: AbortSignal;
}

/**
 * Reusable grants backing `/api/files/preview`. Each connection owns its grants
 * through the source cancellation signal. A logical session can have several
 * sources, so disconnecting one must not revoke another source's token.
 * Legacy callers without a source signal retain session-owned lifetime.
 */
export class PreviewGrantStore {
  private readonly grants = new Map<string, PreviewGrant>();
  private readonly bySession = new Map<string, Map<AbortSignal | undefined, Map<string, string>>>();
  private readonly owners = new Map<string, { signal?: AbortSignal; stop?: () => void }>();

  /**
   * Reuses the session's existing grant for this path only while its pinned
   * identity and MIME still match what was just classified. A changed file
   * (replaced at the same path) mints a fresh token and drops the stale one,
   * so a client that retries after the file changed gets a servable grant
   * instead of repeating the same now-mismatched token forever.
   */
  issueGrant(input: IssuePreviewGrantInput): PreviewGrant {
    const { signal, ...grantInput } = input;
    signal?.throwIfAborted();
    const sourceGrants = this.bySession.get(input.sessionId) ?? new Map();
    this.bySession.set(input.sessionId, sourceGrants);
    const sessionGrants = sourceGrants.get(signal) ?? new Map<string, string>();
    sourceGrants.set(signal, sessionGrants);

    const existingToken = sessionGrants.get(input.absolutePath);
    const existingGrant = existingToken ? this.grants.get(existingToken) : undefined;
    if (
      existingGrant &&
      existingGrant.identity === input.identity &&
      existingGrant.mimeType === input.mimeType
    ) {
      return existingGrant;
    }
    if (existingGrant) {
      this.revokeGrant(existingGrant.token);
      this.bySession.set(input.sessionId, sourceGrants);
      sourceGrants.set(signal, sessionGrants);
    }

    const grant: PreviewGrant = { token: randomUUID(), ...grantInput };
    this.grants.set(grant.token, grant);
    sessionGrants.set(input.absolutePath, grant.token);
    const stop = signal ? () => this.revokeGrant(grant.token) : undefined;
    this.owners.set(grant.token, { signal, stop });
    if (stop) signal!.addEventListener("abort", stop, { once: true });
    return grant;
  }

  private revokeGrant(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    const owner = this.owners.get(token);
    if (owner?.stop) owner.signal!.removeEventListener("abort", owner.stop);
    this.owners.delete(token);
    this.grants.delete(token);
    const sources = this.bySession.get(grant.sessionId);
    const paths = sources?.get(owner?.signal);
    paths?.delete(grant.absolutePath);
    if (!paths?.size) sources?.delete(owner?.signal);
    if (!sources?.size) this.bySession.delete(grant.sessionId);
  }

  getGrant(token: string): PreviewGrant | null {
    return this.grants.get(token) ?? null;
  }

  hasSessionGrants(sessionId: string): boolean {
    return (this.bySession.get(sessionId)?.size ?? 0) > 0;
  }

  revokeSession(sessionId: string): void {
    const sessionGrants = this.bySession.get(sessionId);
    if (!sessionGrants) return;
    for (const paths of sessionGrants.values()) {
      for (const token of paths.values()) this.revokeGrant(token);
    }
    this.bySession.delete(sessionId);
  }
}
