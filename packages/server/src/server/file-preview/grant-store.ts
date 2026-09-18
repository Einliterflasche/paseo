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
}

/**
 * Reusable, session-owned grants backing `/api/files/preview`. One grant per
 * (session, absolute path): a session re-requesting preview access to the
 * same file reuses its existing token instead of minting another, bounding
 * how many live grants one session can accumulate. Grants carry no TTL — they
 * live exactly as long as the issuing WS session and are revoked in bulk when
 * that session disposes. The store itself is in-memory and per daemon
 * process, so a restart invalidates every grant for free.
 */
export class PreviewGrantStore {
  private readonly grants = new Map<string, PreviewGrant>();
  private readonly bySession = new Map<string, Map<string, string>>();

  /**
   * Reuses the session's existing grant for this path only while its pinned
   * identity and MIME still match what was just classified. A changed file
   * (replaced at the same path) mints a fresh token and drops the stale one,
   * so a client that retries after the file changed gets a servable grant
   * instead of repeating the same now-mismatched token forever.
   */
  issueGrant(input: IssuePreviewGrantInput): PreviewGrant {
    const sessionGrants = this.bySession.get(input.sessionId) ?? new Map<string, string>();
    this.bySession.set(input.sessionId, sessionGrants);

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
      this.grants.delete(existingGrant.token);
    }

    const grant: PreviewGrant = { token: randomUUID(), ...input };
    this.grants.set(grant.token, grant);
    sessionGrants.set(input.absolutePath, grant.token);
    return grant;
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
    for (const token of sessionGrants.values()) {
      this.grants.delete(token);
    }
    this.bySession.delete(sessionId);
  }
}
