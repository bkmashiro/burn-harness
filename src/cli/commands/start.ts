import { Command } from "commander";
import { loadConfig } from "../../config/loader.js";
import { Orchestrator } from "../../core/orchestrator.js";
import { startDashboard } from "../../dashboard/server.js";
import { registerInstance, unregisterInstance } from "./ps.js";
import chalk from "chalk";

export const startCommand = new Command("start")
  .description("Start the burn-harness agent loop")
  .option("--profile <name>", "Use a named config profile")
  .option("--workers <n>", "Override max concurrent agents")
  .option("--no-brainstorm", "Disable brainstorming mode")
  .option("--dashboard", "Start web monitoring dashboard")
  .option("--port <n>", "Dashboard port (default: 4242)", "4242")
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

    // Default session timeout: 4 hours
    if (!config.safety.maxRuntimePerSessionHours) {
      config.safety.maxRuntimePerSessionHours = 4;
    }

    const budgetInfo = config.safety.maxBudgetPerDayUsd != null
      ? `$${config.safety.maxBudgetPerDayUsd}/day`
      : "no cap";

    console.log(
      chalk.bold("burn-harness") + chalk.dim(" — AI coding agent loop")
    );
    console.log(
      chalk.dim(
        `  Workers: ${config.execution.maxConcurrentAgents} | CLIs: ${config.cli.preference.join(", ")} | Budget: ${budgetInfo} | Auto-stop: ${config.safety.maxRuntimePerSessionHours}h`
      )
    );
    console.log();

    registerInstance(projectRoot, `start${opts.profile ? ` --profile ${opts.profile}` : ""}`);
    process.on("exit", unregisterInstance);

    const orchestrator = new Orchestrator(projectRoot, config, opts.profile as string);

    // Start dashboard if requested
    if (opts.dashboard) {
      const dashPort = parseInt(opts.port as string, 10) || 4242;
      const dashServer = startDashboard({
        port: dashPort,
        orchestrator,
        projectRoot,
      });
      console.log(
        chalk.cyan(`  Dashboard: http://localhost:${dashPort}`)
      );
      console.log();

      process.on("exit", () => {
        dashServer.close();
      });
    }

    await orchestrator.start();

    unregisterInstance();
  });
