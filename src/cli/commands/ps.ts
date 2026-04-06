import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const GLOBAL_DIR = path.join(
  process.env.HOME ?? "~",
  ".config",
  "burn",
  "instances"
);

export interface BurnInstance {
  pid: number;
  dir: string;
  command: string;
  startedAt: string;
}

/** Register a running burn instance globally */
export function registerInstance(dir: string, command: string): void {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  const entry: BurnInstance = {
    pid: process.pid,
    dir,
    command,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(GLOBAL_DIR, `${process.pid}.json`),
    JSON.stringify(entry)
  );
}

/** Unregister on exit */
export function unregisterInstance(): void {
  try {
    fs.unlinkSync(path.join(GLOBAL_DIR, `${process.pid}.json`));
  } catch { /* ignore */ }
}

/** List all registered instances, prune dead ones */
export function listInstances(): BurnInstance[] {
  if (!fs.existsSync(GLOBAL_DIR)) return [];

  const instances: BurnInstance[] = [];
  for (const file of fs.readdirSync(GLOBAL_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(GLOBAL_DIR, file), "utf-8")) as BurnInstance;
      // Check if process is still alive
      try {
        process.kill(data.pid, 0);
        instances.push(data);
      } catch {
        // Dead process — prune
        fs.unlinkSync(path.join(GLOBAL_DIR, file));
      }
    } catch {
      // Corrupted file — remove
      try { fs.unlinkSync(path.join(GLOBAL_DIR, file)); } catch { /* ignore */ }
    }
  }
  return instances;
}

/** burn ps — show all running burn instances */
export const psCommand = new Command("ps")
  .description("Show all running burn-harness instances across all repos")
  .action(() => {
    const instances = listInstances();

    if (instances.length === 0) {
      console.log(chalk.dim("No burn-harness instances running."));
      return;
    }

    console.log(chalk.bold(`\n  ${instances.length} burn instance(s) running:\n`));

    for (const inst of instances) {
      const elapsed = formatElapsed(new Date(inst.startedAt));
      const repo = path.basename(inst.dir);
      console.log(`  PID ${chalk.bold(String(inst.pid))}  ${chalk.cyan(repo.padEnd(25))} ${elapsed}  ${chalk.dim(inst.command.slice(0, 60))}`);
      console.log(chalk.dim(`    dir: ${inst.dir}`));
    }
    console.log();
  });

/** burn stop-all — kill every running burn instance */
export const stopAllCommand = new Command("stop-all")
  .description("Stop ALL running burn-harness instances and clear PID files")
  .action(() => {
    const instances = listInstances();

    if (instances.length === 0) {
      console.log(chalk.dim("No burn-harness instances running."));
      return;
    }

    console.log(chalk.yellow(`  Stopping ${instances.length} instance(s)...`));

    for (const inst of instances) {
      try {
        process.kill(inst.pid, "SIGTERM");
        console.log(chalk.green("  + ") + `Killed PID ${inst.pid} (${path.basename(inst.dir)})`);
      } catch {
        console.log(chalk.dim(`  PID ${inst.pid} already dead`));
      }
      // Remove registration
      try {
        fs.unlinkSync(path.join(GLOBAL_DIR, `${inst.pid}.json`));
      } catch { /* ignore */ }
    }

    // Also kill any orphan burn processes not in the registry
    try {
      execSync("pkill -f 'node.*burn.*yolo' 2>/dev/null || true", { stdio: "pipe" });
      execSync("pkill -f 'node.*burn.*start' 2>/dev/null || true", { stdio: "pipe" });
    } catch { /* ignore */ }

    // Clean PID files in all known repos
    if (fs.existsSync(GLOBAL_DIR)) {
      for (const file of fs.readdirSync(GLOBAL_DIR)) {
        try { fs.unlinkSync(path.join(GLOBAL_DIR, file)); } catch { /* ignore */ }
      }
    }

    console.log(chalk.green("  All instances stopped.\n"));
  });

/** burn clear — wipe all task queues across all known repos */
export const clearCommand = new Command("clear-queue")
  .alias("clear")
  .description("Cancel all pending/executing tasks in the current repo (or --all for all repos)")
  .option("--all", "Clear ALL repos that have .burn/ directories")
  .action((opts: { all?: boolean }) => {
    if (opts.all) {
      // Find all repos with .burn/ in ~/projects
      const projectsDir = process.env.HOME ? path.join(process.env.HOME, "projects") : process.cwd();
      let cleared = 0;
      if (fs.existsSync(projectsDir)) {
        for (const dir of fs.readdirSync(projectsDir)) {
          const dbPath = path.join(projectsDir, dir, ".burn", "burn.db");
          if (fs.existsSync(dbPath)) {
            clearRepo(path.join(projectsDir, dir));
            cleared++;
          }
        }
      }
      console.log(chalk.green(`  Cleared ${cleared} repos.\n`));
    } else {
      clearRepo(process.cwd());
      console.log(chalk.green("  Queue cleared.\n"));
    }
  });

function clearRepo(dir: string): void {
  const dbPath = path.join(dir, ".burn", "burn.db");
  if (!fs.existsSync(dbPath)) return;

  try {
    execSync(
      `sqlite3 "${dbPath}" "UPDATE tasks SET status='cancelled', completed_at=datetime('now') WHERE status IN ('pending','planning','executing','blocked')"`,
      { encoding: "utf-8" }
    );
    const count = execSync(
      `sqlite3 "${dbPath}" "SELECT changes()"`,
      { encoding: "utf-8" }
    ).trim();
    console.log(chalk.green("  + ") + `${path.basename(dir)}: cancelled ${count} tasks`);
  } catch {
    console.log(chalk.dim(`  ${path.basename(dir)}: no DB or error`));
  }
}

function formatElapsed(start: Date): string {
  const ms = Date.now() - start.getTime();
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return chalk.yellow(`${hours}h${mins}m`);
  return `${mins}m`;
}
