import { setTimeout as delay } from "node:timers/promises";
import { withTimeout } from "./promise-timeout.js";
import {
  systemProcessTreeInspection,
  type ProcessIdentity,
  type ProcessTreeInspection,
} from "./process-tree-inspection.js";

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface PrepareProcessTreeOptions {
  timeoutMs: number;
  /** An authentic native terminal/query result, not EOF or a locally synthesized cancellation. */
  completedExecution?: boolean;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
  completedExecution?: boolean;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export class ProcessTreeOwnershipUnknownError extends Error {
  constructor(pid: number) {
    super(`Process ${pid} exited before its descendant ownership was inspected`);
    this.name = "ProcessTreeOwnershipUnknownError";
  }
}

interface OwnedProcess {
  identity: ProcessIdentity;
  depth: number;
}

/**
 * The OS refused the signal for a process the daemon did not create with its
 * own identity: a setuid transition (sudo, pkexec) inside the tree changed the
 * owner. The daemon can never stop it, so it is not part of the certified tree.
 */
function isForeignProcessSignal(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EPERM";
}

class ProcessTreeOwner {
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly foreign = new Set<string>();
  private initialized = false;
  private certified = false;
  private preparing: Promise<void> | undefined;
  private terminating: Promise<TerminateWithTreeKillResult> | undefined;

  private readonly child: TreeKillTarget;
  private readonly inspection: ProcessTreeInspection;
  constructor(child: TreeKillTarget, inspection: ProcessTreeInspection) {
    this.child = child;
    this.inspection = inspection;
  }

  prepare(options: PrepareProcessTreeOptions): Promise<void> {
    if (this.certified) return Promise.resolve();
    if (this.initialized)
      return this.snapshot(options.timeoutMs).then((snapshot) => {
        this.extend(snapshot);
        return undefined;
      });
    if (!this.preparing) {
      const attempt = this.acquire(options);
      this.preparing = attempt;
      void attempt.catch(() => {
        if (this.preparing === attempt) this.preparing = undefined;
      });
    }
    return this.preparing;
  }

  private async acquire(options: PrepareProcessTreeOptions): Promise<void> {
    const pid = this.child.pid;
    // No pid means the OS never created a process (for example ENOENT at spawn).
    if (pid === undefined) {
      this.child.kill();
      this.certified = true;
      return;
    }
    if (isProcessExited(this.child)) {
      if (options.completedExecution) {
        this.certified = true;
        return;
      }
      throw new ProcessTreeOwnershipUnknownError(pid);
    }
    const snapshot = await this.snapshot(options.timeoutMs);
    const root = snapshot.find((entry) => entry.pid === pid && !entry.stopped);
    if (!root || isProcessExited(this.child)) {
      if (options.completedExecution) {
        this.certified = true;
        return;
      }
      throw new ProcessTreeOwnershipUnknownError(pid);
    }
    assertCreationIdentity(root);
    this.owned.set(identityKey(root), { identity: root, depth: 0 });
    this.extend(snapshot);
    this.initialized = true;
  }

  terminate(options: TerminateWithTreeKillOptions): Promise<TerminateWithTreeKillResult> {
    if (this.terminating) return this.terminating;
    const attempt = this.stop(options);
    this.terminating = attempt;
    void attempt.then(
      (result) => {
        if (result === "kill-timeout" && this.terminating === attempt) this.terminating = undefined;
        return undefined;
      },
      () => {
        if (this.terminating === attempt) this.terminating = undefined;
      },
    );
    return attempt;
  }

  private async stop(options: TerminateWithTreeKillOptions): Promise<TerminateWithTreeKillResult> {
    const inspectionTimeout = Math.max(options.gracefulTimeoutMs, options.forceTimeoutMs ?? 0);
    await this.prepare({
      timeoutMs: inspectionTimeout,
      completedExecution: options.completedExecution,
    });
    if (this.certified) return "already-exited";
    if (
      await this.phase(
        options.gracefulSignal ?? "SIGTERM",
        options.gracefulTimeoutMs,
        inspectionTimeout,
      )
    )
      return "terminated";
    options.onForceSignal?.();
    return (await this.phase(
      options.forceSignal ?? "SIGKILL",
      options.forceTimeoutMs ?? options.gracefulTimeoutMs,
      inspectionTimeout,
    ))
      ? "killed"
      : "kill-timeout";
  }

  private async phase(
    signal: NodeJS.Signals,
    timeoutMs: number,
    inspectionTimeout: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const signaled = new Set<string>();
    while (true) {
      const snapshot = await this.snapshot(inspectionTimeout);
      this.extend(snapshot);
      const live = this.stoppable(snapshot);
      if (live.length === 0) {
        this.certified = true;
        return true;
      }
      const candidates = live
        .sort((a, b) => b.depth - a.depth)
        .filter((entry) => !signaled.has(identityKey(entry.identity)));
      // Validate identities before a tight descendants-first signal broadcast.
      // Separate reads and signals cannot provide atomic pidfd/Job Object semantics.
      const current = await Promise.all(
        candidates.map((entry) =>
          withTimeout(
            this.inspection.read(entry.identity.pid, inspectionTimeout),
            inspectionTimeout,
            "Inspect process before signaling",
          ),
        ),
      );
      await Promise.all(
        candidates.map(async (entry, index) => {
          const identity = current[index];
          const key = identityKey(entry.identity);
          signaled.add(key);
          if (!identity || identity.stopped || identityKey(identity) !== key) return;
          try {
            await this.inspection.signal(identity.pid, signal);
          } catch (error) {
            if (!isForeignProcessSignal(error)) throw error;
            this.foreign.add(key);
          }
        }),
      );
      if (Date.now() >= deadline) {
        const final = await this.snapshot(inspectionTimeout);
        this.extend(final);
        if (this.stoppable(final).length === 0) {
          this.certified = true;
          return true;
        }
        return false;
      }
      await delay(Math.min(50, deadline - Date.now()));
    }
  }

  private snapshot(timeoutMs: number): Promise<ProcessIdentity[]> {
    let roots: Array<{ pid: number; created?: string }> = [];
    if (this.owned.size) roots = Array.from(this.owned.values(), (entry) => entry.identity);
    else if (this.child.pid !== undefined) roots = [{ pid: this.child.pid }];
    return withTimeout(
      this.inspection.snapshot(roots, timeoutMs),
      timeoutMs,
      "Inspect owned process tree",
    );
  }

  private live(snapshot: ProcessIdentity[]): OwnedProcess[] {
    const ownedPids = new Set(Array.from(this.owned.values(), (entry) => entry.identity.pid));
    return snapshot.flatMap((identity) => {
      if (ownedPids.has(identity.pid)) assertCreationIdentity(identity);
      const entry = this.owned.get(identityKey(identity));
      return entry && !identity.stopped && identityKey(identity) === identityKey(entry.identity)
        ? [entry]
        : [];
    });
  }

  /**
   * Live processes whose cessation certifies teardown. A foreign-owned process
   * stays in the traversal so its own descendants are still discovered and
   * signaled, but it can neither be stopped nor emit through the provider pipe
   * the daemon owns, so it never blocks certification.
   */
  private stoppable(snapshot: ProcessIdentity[]): OwnedProcess[] {
    return this.live(snapshot).filter((entry) => !this.foreign.has(identityKey(entry.identity)));
  }

  private extend(snapshot: ProcessIdentity[]): void {
    const parents = new Map(this.live(snapshot).map((entry) => [entry.identity.pid, entry]));
    let extended = true;
    while (extended) {
      extended = false;
      for (const identity of snapshot) {
        if (identity.stopped || this.owned.has(identityKey(identity))) continue;
        const parent = parents.get(identity.parentPid);
        if (!parent) continue;
        assertCreationIdentity(identity);
        const entry = { identity, depth: parent.depth + 1 };
        this.owned.set(identityKey(identity), entry);
        parents.set(identity.pid, entry);
        extended = true;
      }
    }
  }
}

function assertCreationIdentity(identity: ProcessIdentity): void {
  if (!identity.created)
    throw new Error(`Creation identity unavailable for owned process ${identity.pid}`);
}
function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.created}`;
}
function isProcessExited(child: TreeKillTarget): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** One retained owner per ChildProcess, shared by preparation, stop, and retry. */
export function createProcessTreeTerminator(inspection: ProcessTreeInspection) {
  const owners = new WeakMap<TreeKillTarget, ProcessTreeOwner>();
  const owner = (child: TreeKillTarget) => {
    let retained = owners.get(child);
    if (!retained) {
      retained = new ProcessTreeOwner(child, inspection);
      owners.set(child, retained);
    }
    return retained;
  };
  return {
    prepare: (child: TreeKillTarget, options: PrepareProcessTreeOptions) =>
      owner(child).prepare(options),
    terminate: (child: TreeKillTarget, options: TerminateWithTreeKillOptions) =>
      owner(child).terminate(options),
  };
}

const processTrees = createProcessTreeTerminator(systemProcessTreeInspection);
export const prepareProcessTreeTermination = processTrees.prepare;
export const terminateWithTreeKill: ProcessTerminator = processTrees.terminate;
