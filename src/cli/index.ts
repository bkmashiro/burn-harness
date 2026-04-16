#!/usr/bin/env node

import { Command } from "commander";
import { addCommand } from "./commands/add.js";
import { queueCommand } from "./commands/queue.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { initCommand } from "./commands/init.js";
import { rollbackCommand } from "./commands/rollback.js";
import { reportCommand } from "./commands/report.js";
import { yoloCommand } from "./commands/yolo.js";
import { newProjectCommand } from "./commands/new-project.js";
import { psCommand, stopAllCommand, clearCommand } from "./commands/ps.js";
import { configCommand } from "./commands/config.js";
import { getDb } from "../db/client.js";
import { startInteractive } from "./interactive.js";

const program = new Command()
  .name("burn")
  .description(
    "burn-harness — Run AI coding CLIs non-stop on a dev task queue"
  )
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(addCommand);
program.addCommand(queueCommand);
program.addCommand(startCommand);
program.addCommand(statusCommand);
program.addCommand(rollbackCommand);
program.addCommand(reportCommand);
program.addCommand(yoloCommand);
program.addCommand(newProjectCommand);
program.addCommand(psCommand);
program.addCommand(stopAllCommand);
program.addCommand(clearCommand);
program.addCommand(configCommand);

// Interactive REPL mode — the default when no subcommand is given
program
  .command("interactive")
  .alias("i")
  .description("Start interactive mode (REPL with guided workflows)")
  .action(async () => {
    await startInteractive();
  });

program
  .command("stop")
  .description("Stop the running burn-harness (sends SIGTERM to daemon)")
  .action(() => {
    console.log(
      "burn-harness runs in foreground. Press Ctrl+C in the running terminal to stop."
    );
  });

program
  .command("promote <taskId>")
  .description("Move a task to the front of the queue")
  .action((taskId: string) => {
    const db = getDb();
    db.prepare("UPDATE tasks SET priority = 0 WHERE id LIKE ?").run(
      `%${taskId}`
    );
    console.log(`Task promoted to highest priority.`);
  });

program
  .command("retry <taskId>")
  .description("Reset a failed task for retry")
  .action((taskId: string) => {
    const db = getDb();
    db.prepare(
      "UPDATE tasks SET status = 'pending', current_attempt = 0, worker_id = NULL, completed_at = NULL WHERE id LIKE ? AND status = 'failed'"
    ).run(`%${taskId}`);
    console.log(`Task reset for retry.`);
  });

program
  .command("cancel <taskId>")
  .description("Cancel a task")
  .action((taskId: string) => {
    const db = getDb();
    db.prepare(
      "UPDATE tasks SET status = 'cancelled', completed_at = datetime('now') WHERE id LIKE ?"
    ).run(`%${taskId}`);
    console.log(`Task cancelled.`);
  });

// Default: if no command given and stdin is a TTY, start interactive mode
const args = process.argv.slice(2);
if (args.length === 0 && process.stdin.isTTY) {
  startInteractive().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  program.parse();
}
