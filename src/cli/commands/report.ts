import { Command } from "commander";
import { getDb } from "../../db/client.js";
import {
  getDailyCost,
  getTotalCost,
  getCostByAdapter,
  getPerTaskCosts,
  estimateQueueCost,
  getHourlyCosts,
} from "../../core/task-queue.js";
import chalk from "chalk";

export const reportCommand = new Command("report")
  .description("Show cost and usage report")
  .option("--days <n>", "Number of days to show", "7")
  .option("--today", "Show detailed breakdown for today")
  .action((opts: { days: string; today?: boolean }) => {
    const db = getDb();

    if (opts.today) {
      showTodayReport(db);
      return;
    }

    const days = parseInt(opts.days, 10);

    console.log(chalk.bold(`burn-harness report (last ${days} days)`));
    console.log();

    // Daily costs
    const dailyCosts = db
      .prepare(
        `SELECT date, SUM(cost_usd) as cost, SUM(tokens_in + tokens_out) as tokens, COUNT(*) as requests
         FROM cost_tracking
         WHERE date >= date('now', ?)
         GROUP BY date
         ORDER BY date DESC`
      )
      .all(`-${days} days`) as {
      date: string;
      cost: number;
      tokens: number;
      requests: number;
    }[];

    if (dailyCosts.length === 0) {
      console.log(chalk.dim("  No cost data yet."));
    } else {
      console.log(chalk.bold("  Date        Cost     Tokens    Requests"));
      for (const row of dailyCosts) {
        console.log(
          `  ${row.date}  $${row.cost.toFixed(2).padStart(7)}  ${String(row.tokens).padStart(9)}  ${String(row.requests).padStart(8)}`
        );
      }

      const totalCost = dailyCosts.reduce((s, r) => s + r.cost, 0);
      const totalTokens = dailyCosts.reduce((s, r) => s + r.tokens, 0);
      const totalRequests = dailyCosts.reduce((s, r) => s + r.requests, 0);
      console.log(
        chalk.bold(
          `  ${"Total".padEnd(10)}  $${totalCost.toFixed(2).padStart(7)}  ${String(totalTokens).padStart(9)}  ${String(totalRequests).padStart(8)}`
        )
      );
    }

    console.log();

    // Cost by adapter
    const adapterCosts = getCostByAdapter();
    if (adapterCosts.length > 0) {
      console.log(chalk.bold("  Cost by Adapter"));
      for (const row of adapterCosts) {
        console.log(
          `  ${row.cli.padEnd(14)}  $${row.cost.toFixed(2).padStart(7)}  ${String(row.tokens).padStart(9)} tokens  ${row.calls} calls`
        );
      }
      console.log();
    }

    // Task summary by type
    const tasksByType = db
      .prepare(
        `SELECT type, status, COUNT(*) as count, SUM(estimated_cost_usd) as cost
         FROM tasks
         GROUP BY type, status
         ORDER BY type, status`
      )
      .all() as { type: string; status: string; count: number; cost: number }[];

    if (tasksByType.length > 0) {
      console.log(chalk.bold("  Tasks by type"));
      const grouped = new Map<string, { total: number; done: number; failed: number; cost: number }>();
      for (const row of tasksByType) {
        const entry = grouped.get(row.type) ?? { total: 0, done: 0, failed: 0, cost: 0 };
        entry.total += row.count;
        if (row.status === "done") entry.done += row.count;
        if (row.status === "failed") entry.failed += row.count;
        entry.cost += row.cost;
        grouped.set(row.type, entry);
      }

      for (const [type, data] of grouped) {
        console.log(
          `  ${type.padEnd(14)} ${chalk.green(`${data.done} done`)}  ${chalk.red(`${data.failed} failed`)}  ${chalk.dim(`${data.total} total`)}  $${data.cost.toFixed(2)}`
        );
      }
    }

    // Queue cost estimate
    const estimate = estimateQueueCost();
    if (estimate.pendingCount > 0) {
      console.log();
      console.log(chalk.bold("  Queue Cost Estimate"));
      console.log(
        `  ${estimate.pendingCount} pending tasks * ~$${estimate.avgCostPerTask.toFixed(2)}/task = ${chalk.yellow(`~$${estimate.estimatedCost.toFixed(2)}`)}`
      );
    }

    // Most expensive tasks
    const expensiveTasks = getPerTaskCosts(5);
    if (expensiveTasks.length > 0) {
      console.log();
      console.log(chalk.bold("  Most Expensive Tasks"));
      for (const t of expensiveTasks) {
        console.log(
          `  ${chalk.dim(t.id.slice(-6))}  $${t.cost.toFixed(2).padStart(6)}  [${t.type}]  ${t.title.slice(0, 45)}`
        );
      }
    }

    console.log();
  });

function showTodayReport(db: ReturnType<typeof getDb>): void {
  const dailyCost = getDailyCost();
  const totalCost = getTotalCost();

  console.log(chalk.bold("burn-harness report — today"));
  console.log();

  console.log(`  Daily cost:   ${chalk.bold("$" + dailyCost.toFixed(2))}`);
  console.log(`  Total cost:   ${chalk.bold("$" + totalCost.toFixed(2))}`);
  console.log();

  // Hourly breakdown
  const hourly = getHourlyCosts();
  if (hourly.length > 0) {
    console.log(chalk.bold("  Hourly Breakdown"));
    console.log(chalk.dim("  Hour    Cost    Tokens"));
    for (const h of hourly) {
      const bar = "=".repeat(Math.min(30, Math.round(h.cost * 10)));
      console.log(
        `  ${h.hour}   $${h.cost.toFixed(2).padStart(5)}  ${String(h.tokens).padStart(8)}  ${chalk.green(bar)}`
      );
    }
    console.log();
  }

  // Cost by adapter today
  const today = new Date().toISOString().split("T")[0];
  const adapterToday = db
    .prepare(
      `SELECT cli, SUM(cost_usd) as cost, SUM(tokens_in + tokens_out) as tokens, COUNT(*) as calls
       FROM cost_tracking
       WHERE date = ?
       GROUP BY cli`
    )
    .all(today) as Array<{ cli: string; cost: number; tokens: number; calls: number }>;

  if (adapterToday.length > 0) {
    console.log(chalk.bold("  Today by Adapter"));
    for (const row of adapterToday) {
      console.log(
        `  ${row.cli.padEnd(14)}  $${row.cost.toFixed(2).padStart(7)}  ${String(row.tokens).padStart(9)} tok  ${row.calls} calls`
      );
    }
    console.log();
  }

  // Tasks completed today
  const todayTasks = db
    .prepare(
      `SELECT id, title, type, estimated_cost_usd as cost, status
       FROM tasks
       WHERE date(completed_at) = date('now')
       ORDER BY completed_at DESC`
    )
    .all() as Array<{ id: string; title: string; type: string; cost: number; status: string }>;

  if (todayTasks.length > 0) {
    console.log(chalk.bold(`  Tasks Completed Today (${todayTasks.length})`));
    for (const t of todayTasks) {
      const statusColor = t.status === "done" ? chalk.green : chalk.red;
      console.log(
        `  ${chalk.dim(t.id.slice(-6))}  ${statusColor(t.status.padEnd(7))}  $${t.cost.toFixed(2).padStart(5)}  [${t.type}]  ${t.title.slice(0, 40)}`
      );
    }
    console.log();
  }

  // Estimate remaining
  const estimate = estimateQueueCost();
  if (estimate.pendingCount > 0) {
    console.log(
      chalk.yellow(
        `  Estimated remaining: ${estimate.pendingCount} tasks * ~$${estimate.avgCostPerTask.toFixed(2)} = ~$${estimate.estimatedCost.toFixed(2)}`
      )
    );
    console.log();
  }
}
