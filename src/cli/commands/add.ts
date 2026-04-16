import { Command } from "commander";
import { getDb } from "../../db/client.js";
import { addTask } from "../../core/task-queue.js";
import chalk from "chalk";

export const addCommand = new Command("add")
  .description("Add a task to the queue")
  .argument("<description>", "Task description / prompt for the AI")
  .option("-t, --type <type>", "Task type (bug, feature, refactor, test, docs, performance, security, chore)", "chore")
  .option("-p, --priority <n>", "Priority 1-5 (1=critical)", "3")
  .option("-c, --complexity <level>", "Estimated complexity (trivial, small, medium, large, epic)", "medium")
  .option("--tags <tags>", "Comma-separated tags")
  .option("--files <files>", "Comma-separated target files")
  .option("--budget <usd>", "Per-task budget in USD")
  .option("--depends-on <ids>", "Comma-separated task IDs this depends on")
  .option("--after <ids>", "Alias for --depends-on: task IDs that must complete first")
  .action((description: string, opts: Record<string, string>) => {
    getDb();
    const task = addTask({
      title: description.slice(0, 100),
      description,
      type: opts.type,
      priority: parseInt(opts.priority, 10),
      estimatedComplexity: opts.complexity,
      tags: opts.tags ? opts.tags.split(",").map((s) => s.trim()) : undefined,
      targetFiles: opts.files
        ? opts.files.split(",").map((s) => s.trim())
        : undefined,
      budgetLimitUsd: opts.budget ? parseFloat(opts.budget) : undefined,
      dependsOn: (opts.dependsOn || opts.after)
        ? (opts.dependsOn || opts.after).split(",").map((s) => s.trim())
        : undefined,
    });

    console.log(
      chalk.green("✓") +
        ` Task added: ${chalk.bold(task.id.slice(-6))} — ${task.title}`
    );
    console.log(
      `  Type: ${task.type} | Priority: ${task.priority} | Complexity: ${task.estimated_complexity}`
    );
  });
