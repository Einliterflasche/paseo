/** Node options for the daemon worker only, never NODE_OPTIONS inherited by agents. */
export function resolveDaemonHeapArgs(env: NodeJS.ProcessEnv, devMode: boolean): string[] {
  const configured = env.PASEO_DAEMON_HEAP_MB;
  if (configured === undefined) {
    return devMode ? ["--max-old-space-size=3072"] : [];
  }
  if (!/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(Number(configured))) {
    throw new Error("PASEO_DAEMON_HEAP_MB must be a positive integer in MiB");
  }
  return [`--max-old-space-size=${configured}`];
}
