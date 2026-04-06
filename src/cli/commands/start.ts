import { Command } from "commander";
import { loadConfig } from "../../config/loader.js";
import { Orchestrator } from "../../core/orchestrator.js";
import chalk from "chalk";

export const startCommand = new Command("start")
  .description("Start the burn-harness agent loop")
  .option("--profile <name>", "Use a named config profile")
  .option("--workers <n>", "Override max concurrent agents")
  .option("--no-brainstorm", "Disable brainstorming mode")
  .action(async (opts: Record<string, string | boolean>) => {
    const projectRoot = process.cwd();
    const config = loadConfig(projectRoot, opts.profile as string);

    if (opts.workers) {
      config.execution.maxConcurrentAgents = parseInt(
        opts.workers as string,
        10
      );
    }

    if (opts.brainstorm === false) {
      config.brainstorm.enabled = false;
    }

    console.log(
      chalk.bold("🔥 burn-harness") + chalk.dim(" — AI coding agent loop")
    );
    console.log(
      chalk.dim(
        `  Workers: ${config.execution.maxConcurrentAgents} | CLIs: ${config.cli.preference.join(", ")} | Budget: $${config.safety.maxBudgetPerDayUsd}/day`
      )
    );
    console.log();

    const orchestrator = new Orchestrator(projectRoot, config, opts.profile as string);
    await orchestrator.start();
  });
