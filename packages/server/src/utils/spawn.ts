import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import { terminateWithTreeKill } from "./tree-kill.js";
import { withTimeout } from "./promise-timeout.js";

import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./windows-command.js";

const execFileAsync = promisify(execFile);

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface CommandProbeOwner {
  readonly signal: AbortSignal;
  own(cleanup: { close(): Promise<void> }): () => void;
}

interface ExecCommandOptions extends ExternalEnvOptions {
  probe?: CommandProbeOwner;
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shouldUseWindowsShell(
  command: string,
  requestedShell?: boolean | string,
): boolean | string {
  if (isWindowsCommandScript(command)) {
    return true;
  }
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  return process.platform === "win32" && !hasPathSeparator(command) && !extname(command);
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, spawnOptions.shell);

  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return spawn(resolvedCommand, resolvedArgs, {
    ...spawnOptions,
    env: childEnv,
    shell,
    signal: options?.signal,
    windowsHide: true,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options: ExecCommandOptions = {},
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options;
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, options.shell);
  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  options.signal?.throwIfAborted();
  options.probe?.signal.throwIfAborted();
  const execution = execFileAsync(resolvedCommand, resolvedArgs, {
    cwd: options.cwd,
    env: childEnv,
    encoding: options.encoding ?? "utf8",
    killSignal: options.killSignal,
    timeout: options.probe ? 0 : options.timeout,
    maxBuffer: options.maxBuffer,
    shell,
    windowsHide: true,
    signal: options.probe ? undefined : options.signal,
  });
  if (!options.probe) return execution as Promise<ExecCommandResult>;
  return awaitOwnedExecution(
    execution as Promise<ExecCommandResult> & { child: ChildProcess },
    options.probe,
    options,
  );
}

async function awaitOwnedExecution(
  execution: Promise<ExecCommandResult> & { child: ChildProcess },
  probe: CommandProbeOwner,
  options: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const child = execution.child;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      const attempt = closeOwnedCommand(child, closed);
      closing = attempt;
      void attempt.catch(() => {
        if (closing === attempt) closing = undefined;
      });
    }
    return closing;
  };
  const release = probe.own({ close });
  const signal = options.signal ? AbortSignal.any([probe.signal, options.signal]) : probe.signal;
  let interruption: unknown;
  const interrupt = (reason: unknown) => {
    interruption ??= reason;
    void close().catch(() => undefined);
  };
  const onAbort = () => interrupt(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer =
    options.timeout && options.timeout > 0
      ? setTimeout(
          () => interrupt(new Error(`Provider command timed out after ${options.timeout}ms`)),
          options.timeout,
        )
      : undefined;
  // Owned commands stop through one tree-aware path. Letting execFile's abort
  // or timeout kill only the leader first can orphan its native descendants.
  try {
    const result = await execution;
    if (interruption !== undefined) throw interruption;
    return result;
  } catch (error) {
    throw interruption ?? error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    await close();
    release();
  }
}

async function closeOwnedCommand(child: ChildProcess, closed: Promise<void>): Promise<void> {
  // Match the existing provider subprocess shutdown budget. A timeout retains
  // the owner so the lifecycle coordinator can retry certification.
  if (child.pid !== undefined) {
    const result = await terminateWithTreeKill(child, {
      // Temporary queries have no turn to finish. Kill the whole discovered tree
      // together so an exiting shell cannot leave an ignoring descendant behind.
      gracefulSignal: "SIGKILL",
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 1_000,
    });
    if (result === "kill-timeout")
      throw new Error("Provider command did not exit after termination");
  }
  await withTimeout(closed, 1_000, "Provider command output did not drain after termination");
}
