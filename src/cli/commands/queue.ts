import { Command } from "commander";
import { getDb } from "../../db/client.js";
import { listTasks, getQueueStats } from "../../core/task-queue.js";
import chalk from "chalk";

const STATUS_COLORS: Record<string, (s: string) => string> = {
  pending: chalk.yellow,
  blocked: chalk.gray,
  planning: chalk.cyan,
  executing: chalk.blue,
  reviewing: chalk.magenta,
  done: chalk.green,
  failed: chalk.red,
  cancelled: chalk.gray,
  brainstormed: chalk.italic,
};

export const queueCommand = new Command("queue")
  .alias("q")
  .description("Show the task queue")
  .option("-s, --status <status>", "Filter by status")
  .option("-t, --type <type>", "Filter by type")
  .option("--all", "Show all tasks including done/cancelled")
  .action((opts: Record<string, string | boolean>) => {
    getDb();

    const filter: { status?: string; type?: string } = {};
    if (opts.status) filter.status = opts.status as string;
    if (opts.type) filter.type = opts.type as string;

    let tasks = listTasks(filter);

    if (!opts.all && !opts.status) {
      tasks = tasks.filter(
        (t) => !["done", "cancelled"].includes(t.status)
      );
    }

    if (tasks.length === 0) {
      console.log(chalk.dim("Queue is empty."));
      return;
    }

    // Header
    const stats = getQueueStats();
    console.log(
      chalk.bold("Task Queue") +
        chalk.dim(
          ` (${stats.pending} pending, ${stats.executing} running, ${stats.done} done, ${stats.failed} failed)`
        )
    );
    console.log();

    // Table
    for (const task of tasks) {
      const id = chalk.dim(task.id.slice(-6));
      const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
      const status = colorFn(task.status.padEnd(11));
      const type = chalk.dim(`[${task.type}]`.padEnd(14));
      const priority = `P${task.priority}`;
      const title = task.title.slice(0, 60);
      const cost = task.estimated_cost_usd > 0
        ? chalk.dim(` $${task.estimated_cost_usd.toFixed(2)}`)
        : "";

      console.log(`  ${id}  ${status} ${priority} ${type} ${title}${cost}`);

      if (task.pr_url) {
        console.log(chalk.dim(`         PR: ${task.pr_url}`));
      }
    }

    console.log();
  });
