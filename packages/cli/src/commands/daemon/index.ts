import { Command } from "commander";
import { startCommand, daemonRunCommand } from "./start.js";
import { daemonStatusCommand } from "./status.js";
import { daemonStopCommand } from "./stop.js";
import { runDeployCommand } from "./deploy.js";
import { daemonRestartCommand } from "./restart.js";
import { runSetPasswordCommand } from "./set-password.js";
import { pairCommand } from "./pair.js";
import { daemonReloadCommand } from "./reload.js";
import { daemonConfigCommand } from "./config.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonOption, addLocalDaemonOptions } from "../../utils/command-options.js";

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the Paseo daemon");
  for (const command of [
    startCommand(),
    daemonRunCommand(),
    daemonStatusCommand(),
    daemonStopCommand(),
    daemonRestartCommand(),
    daemonReloadCommand(),
    pairCommand(),
    daemonConfigCommand(),
  ])
    daemon.addCommand(command);
  addJsonOption(
    addLocalDaemonOptions(
      daemon.command("set-password").description("Save a hashed daemon password (local operation)"),
    ),
  ).action(withOutput(runSetPasswordCommand));
  addJsonOption(
    addLocalDaemonOptions(
      daemon
        .command("deploy")
        .description(
          "Prepare a checkpoint, activate a replacement and verify its exact restored generation",
        )
        .argument("<argv...>", "Activation argv after --"),
    ),
  )
    .option("--reason <text>", "Checkpoint reason")
    .option("--timeout <seconds>", "Connection timeout (default: 15)")
    .option("--wait-timeout <seconds>", "Optional restoration deadline")
    .action(
      withOutput((...args) => {
        const [argv, options, command] = args.slice(-3) as [string[], CommandOptions, Command];
        return runDeployCommand(argv, options, command);
      }),
    );
  return daemon;
}
