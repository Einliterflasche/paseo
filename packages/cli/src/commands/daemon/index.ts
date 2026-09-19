import { Command, Option } from "commander";
import { startCommand } from "./start.js";
import { runStatusCommand } from "./status.js";
import { runStopCommand } from "./stop.js";
import { runRestartCommand } from "./restart.js";
import { runDeployCommand } from "./deploy.js";
import { runCheckpointCheckCommand } from "./checkpoint-check.js";
import { runSetPasswordCommand } from "./set-password.js";
import { pairCommand } from "./pair.js";
import { runDaemonReloadCommand } from "./reload.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, addJsonOption } from "../../utils/command-options.js";

function resolveHostnamesOption(hostnames: unknown, allowedHosts: unknown): string | undefined {
  if (typeof hostnames === "string") return hostnames;
  if (typeof allowedHosts === "string") return allowedHosts;
  return undefined;
}

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the Paseo daemon");

  daemon.addCommand(startCommand());
  daemon.addCommand(pairCommand());

  addJsonOption(
    daemon
      .command("checkpoint-check")
      .description("Validate checkpoint compatibility offline, without claiming or restoring it"),
  )
    .option("--formats", "Print formats readable by this package")
    .option("--home <path>", "Paseo home containing the checkpoint")
    .option("--generation <id>", "Expected ready generation to validate")
    .action(withOutput(runCheckpointCheckCommand));

  addJsonAndDaemonHostOptions(
    daemon.command("reload").description("Reload config.json without restarting the daemon"),
  ).action(withOutput(runDaemonReloadCommand));

  addJsonOption(daemon.command("status").description("Show local daemon status"))
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action(withOutput(runStatusCommand));

  addJsonOption(daemon.command("stop").description("Stop the local daemon"))
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .option("--timeout <seconds>", "Wait timeout before failing (default: 15)")
    .option("--force", "Send SIGKILL if graceful stop times out")
    .option("--kill-timeout <seconds>", "Wait after SIGKILL before failing (default: 3)")
    .action(withOutput(runStopCommand));

  addJsonOption(
    daemon
      .command("restart")
      .option("--retry-recovery", "Retry a quiescent failed restoration in the existing daemon")
      .option(
        "--acknowledge-crash <generation>",
        "Reconcile an unexpected crash without replaying the consumed checkpoint",
      )
      .option(
        "--orphan-execution-reconciled",
        "Attest orphan provider work was inspected/stopped; accept lost Paseo-only history and completion obligations",
      )
      .description(
        "Restart the local daemon. If it is running, this checkpoints in-flight work over " +
          "RPC and lets the supervisor replace the process — no forced kill. Use --force for " +
          "the old raw stop/start behavior, which is not covered by that guarantee.",
      ),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .option("--reason <text>", "Reason recorded with the controlled restart request")
    .option("--timeout <seconds>", "Wait timeout before --force kills the daemon (default: 15)")
    .option("--force", "Raw stop/start outside the restart-recovery guarantee; SIGKILL on timeout")
    .option(
      "--listen <listen>",
      "Listen target when starting a daemon that was not running (host:port, port, or unix socket)",
    )
    .option("--port <port>", "Port when starting a daemon that was not running")
    .option("--relay", "Enable relay when starting a daemon that was not running")
    .option("--no-relay", "Disable relay when starting a daemon that was not running")
    .option("--no-mcp", "Disable Agent MCP when starting a daemon that was not running")
    .option(
      "--no-inject-mcp",
      "Disable auto-injecting the Paseo MCP into created agents on a fresh start",
    )
    .option(
      "--web-ui",
      "Enable the bundled daemon web UI when starting a daemon that was not running",
    )
    .option(
      "--no-web-ui",
      "Disable the bundled daemon web UI when starting a daemon that was not running",
    )
    .option(
      "--hostnames <hosts>",
      'Daemon hostnames when starting a daemon that was not running (comma-separated, e.g. "myhost,.example.com" or "true" for any)',
    )
    .addOption(new Option("--allowed-hosts <hosts>").hideHelp())
    .action(
      withOutput((...args) => {
        const [options, command] = args.slice(-2) as [(typeof args)[number], Command];
        return runRestartCommand(
          {
            ...options,
            hostnames: resolveHostnamesOption(options.hostnames, options.allowedHosts),
          },
          command,
        );
      }),
    );

  addJsonOption(
    daemon
      .command("deploy")
      .requiredOption(
        "--target-cli <path>",
        "Immutable replacement package's paseo executable for offline checkpoint validation",
      )
      .description(
        "Prepare a checkpoint on the running daemon, then run the given activation command " +
          "and confirm the replacement daemon reports that same checkpoint generation running. " +
          "Never activates without a ready generation, and never force-kills anything on failure.",
      )
      .argument(
        "<argv...>",
        "Activation command to run only after a checkpoint is ready, e.g. -- sudo <closure>/bin/switch-to-configuration switch",
      ),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .option("--reason <text>", "Reason recorded with the checkpoint preparation request")
    .option("--timeout <seconds>", "Connection timeout before checkpoint preparation (default: 15)")
    .option(
      "--wait-timeout <seconds>",
      "Optional wait timeout for the replacement daemon (default: wait until ready)",
    )
    .action(
      withOutput((...args) => {
        const [argv, options, command] = args.slice(-3) as [string[], CommandOptions, Command];
        return runDeployCommand(argv, options, command);
      }),
    );

  addJsonOption(
    daemon
      .command("set-password")
      .description("Prompt for and save a hashed daemon password to config.json"),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action(withOutput(runSetPasswordCommand));

  return daemon;
}
