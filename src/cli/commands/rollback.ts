import { Command } from "commander";
import { execSync } from "node:child_process";
import { getDb } from "../../db/client.js";
import { getTask, updateTaskStatus } from "../../core/task-queue.js";
import { closePR } from "../../git/pr.js";
import { deleteBranch } from "../../git/branch.js";
import chalk from "chalk";

export const rollbackCommand = new Command("rollback")
  .description("Roll back a task's changes (delete branch, close PR)")
  .argument("<taskId>", "Task ID (full or last 6 chars)")
  .action((taskId: string) => {
    const db = getDb();

    // Find task by full ID or suffix
    let task = getTask(taskId);
    if (!task) {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE id LIKE ?")
        .all(`%${taskId}`) as any[];
      if (rows.length === 1) task = rows[0];
      else if (rows.length > 1) {
        console.log(chalk.red("Multiple tasks match. Be more specific."));
        return;
      }
    }

    if (!task) {
      console.log(chalk.red(`Task not found: ${taskId}`));
      return;
    }

    console.log(
      `Rolling back: ${chalk.bold(task.title)} (${task.id.slice(-6)})`
    );

    const cwd = process.cwd();

    // Close PR if exists
    if (task.pr_url) {
      try {
        closePR(cwd, task.pr_url);
        console.log(chalk.green("✓") + " Closed PR");
      } catch {
        console.log(chalk.yellow("⚠") + " Could not close PR");
      }
    }

    // Delete remote branch
    if (task.branch) {
      try {
        execSync(`git push origin --delete "${task.branch}"`, {
          cwd,
          stdio: "pipe",
        });
        console.log(chalk.green("✓") + " Deleted remote branch");
      } catch {
        console.log(chalk.dim("  Remote branch already deleted or not pushed"));
      }

      // Delete local branch
      deleteBranch(cwd, task.branch);
      console.log(chalk.green("✓") + " Deleted local branch");
    }

    // Mark as cancelled
    updateTaskStatus(task.id, "cancelled");
    console.log(chalk.green("✓") + " Task marked as cancelled");
  });
