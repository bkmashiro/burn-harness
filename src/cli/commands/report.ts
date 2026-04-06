import { Command } from "commander";
import { getDb } from "../../db/client.js";
import chalk from "chalk";

export const reportCommand = new Command("report")
  .description("Show cost and usage report")
  .option("--days <n>", "Number of days to show", "7")
  .action((opts: { days: string }) => {
    const db = getDb();
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

    // CLI usage
    const cliUsage = db
      .prepare(
        `SELECT cli, COUNT(*) as count, SUM(cost_usd) as cost, SUM(tokens_in + tokens_out) as tokens
         FROM cost_tracking
         GROUP BY cli`
      )
      .all() as { cli: string; count: number; cost: number; tokens: number }[];

    if (cliUsage.length > 0) {
      console.log();
      console.log(chalk.bold("  Cost by CLI"));
      for (const row of cliUsage) {
        console.log(
          `  ${row.cli.padEnd(10)}  $${row.cost.toFixed(2).padStart(7)}  ${String(row.tokens).padStart(9)} tokens  ${row.count} calls`
        );
      }
    }

    console.log();
  });
