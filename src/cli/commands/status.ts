import { Command } from "commander";
import { getDb } from "../../db/client.js";
import { getQueueStats, getDailyCost, getTotalCost, listTasks } from "../../core/task-queue.js";
import chalk from "chalk";

export const statusCommand = new Command("status")
  .description("Show burn-harness status")
  .action(() => {
    getDb();

    const stats = getQueueStats();
    const dailyCost = getDailyCost();
    const totalCost = getTotalCost();

    console.log(chalk.bold("burn-harness status"));
    console.log();

    // Queue
    console.log(chalk.bold("Queue"));
    console.log(`  Pending:    ${chalk.yellow(String(stats.pending))}`);
    console.log(`  Executing:  ${chalk.blue(String(stats.executing))}`);
    console.log(`  Done:       ${chalk.green(String(stats.done))}`);
    console.log(`  Failed:     ${chalk.red(String(stats.failed))}`);
    console.log(`  Total:      ${stats.total}`);
    console.log();

    // Costs
    console.log(chalk.bold("Costs"));
    console.log(`  Today:      $${dailyCost.toFixed(2)}`);
    console.log(`  Total:      $${totalCost.toFixed(2)}`);
    console.log();

    // Recent activity
    const recentDone = listTasks({ status: "done" }).slice(-5);
    if (recentDone.length > 0) {
      console.log(chalk.bold("Recent completions"));
      for (const task of recentDone) {
        const id = chalk.dim(task.id.slice(-6));
        const cost = task.estimated_cost_usd > 0
          ? chalk.dim(` $${task.estimated_cost_usd.toFixed(2)}`)
          : "";
        console.log(`  ${id}  ${task.title.slice(0, 60)}${cost}`);
        if (task.pr_url) {
          console.log(chalk.dim(`         ${task.pr_url}`));
        }
      }
      console.log();
    }

    // Currently executing
    const executing = listTasks({ status: "executing" });
    const planning = listTasks({ status: "planning" });
    const active = [...planning, ...executing];
    if (active.length > 0) {
      console.log(chalk.bold("Active"));
      for (const task of active) {
        const id = chalk.dim(task.id.slice(-6));
        console.log(
          `  ${id}  ${chalk.blue(task.status)} — ${task.title.slice(0, 50)} (${task.worker_id ?? "?"})`
        );
      }
      console.log();
    }
  });
