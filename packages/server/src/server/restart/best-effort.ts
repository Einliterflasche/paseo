export type RestartFailureReporter = (step: string, error: unknown) => void;

export class RestartStepTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number,
  ) {
    super(`Restart step '${step}' did not finish within ${timeoutMs} ms`);
    this.name = "RestartStepTimeoutError";
  }
}

function reportSafely(report: RestartFailureReporter, step: string, error: unknown): void {
  try {
    report(step, error);
  } catch {
    // A broken reporter must not turn a skipped step into a blocked restart.
  }
}

/** Runs `operation`. On a throw or a rejection it calls `report(step, error)` and returns
 *  `fallback`. Never throws and never rejects. A throwing `report` is swallowed. */
export async function attempt<T>(
  report: RestartFailureReporter,
  step: string,
  operation: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    reportSafely(report, step, error);
    return fallback;
  }
}

/** Like `attempt`, with a deadline. After `timeoutMs` it reports a `RestartStepTimeoutError` and
 *  returns `fallback`. It does not cancel the operation: the operation keeps running, its late
 *  result is ignored, and a late rejection is reported, never thrown. Clears its timer when the
 *  operation settles first. */
export async function attemptWithin<T>(
  report: RestartFailureReporter,
  step: string,
  timeoutMs: number,
  operation: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  let running: Promise<T>;
  try {
    running = Promise.resolve(operation());
  } catch (error) {
    reportSafely(report, step, error);
    return fallback;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      reportSafely(report, step, new RestartStepTimeoutError(step, timeoutMs));
      resolve(fallback);
    }, timeoutMs);
  });
  const settled = running.catch((error: unknown) => {
    reportSafely(report, step, error);
    return fallback;
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
