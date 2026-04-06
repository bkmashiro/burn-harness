import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDb } from "../../db/client.js";
import { loadConfig } from "../../config/loader.js";
import { addTask, getQueueStats } from "../../core/task-queue.js";
import { Orchestrator } from "../../core/orchestrator.js";
import { AdapterRegistry } from "../../adapters/registry.js";
import { monitorProcess } from "../../monitor/output-parser.js";

const YOLO_BANNER = `
${chalk.bold.red("  🔥 YOLO MODE 🔥")}
${chalk.dim("  Agents brainstorm and burn autonomously.")}
${chalk.dim("  All changes on branches — main is never touched.")}
${chalk.dim("  Every edit is tracked, committed, and revertible.")}
${chalk.dim("  Ctrl+C to stop anytime.")}
`;

/**
 * YOLO mode: fire-and-forget autonomous coding.
 *
 * `burn yolo` — zero config, zero prompts. The agent:
 *   1. Auto-initializes if needed
 *   2. Brainstorms tasks from the codebase
 *   3. Auto-approves everything
 *   4. Executes non-stop
 *   5. Creates draft PRs for everything
 *   6. When queue empties, brainstorms again
 *   7. Repeat forever
 *
 * Optional: `burn yolo "focus on tests"` — seed the brainstorm direction
 */
export const yoloCommand = new Command("yolo")
  .description("Fire-and-forget autonomous mode — agents brainstorm and burn non-stop")
  .argument("[focus]", "Optional focus hint for the AI (e.g. 'tests', 'security', 'refactor auth')")
  .option("--workers <n>", "Total concurrent agents across all repos (default: 1, max ~5 for Claude)", "1")
  .option("--profile <name>", "Config profile to use")
  .option("--budget <usd>", "Daily budget cap in USD (per repo)")
  .option("--seed <n>", "Number of initial brainstorm tasks to generate", "5")
  .option("-d, --dir <paths>", "Comma-separated directories/repos to work on (default: cwd)")
  .option("--dry-run", "Brainstorm tasks but don't start agents")
  .action(async (focus: string | undefined, opts: Record<string, string | boolean>) => {
    // Resolve target directories
    const targetDirs = opts.dir
      ? (opts.dir as string).split(",").map(d => path.resolve(d.trim()))
      : [process.cwd()];

    // Validate all directories
    for (const dir of targetDirs) {
      if (!fs.existsSync(dir)) {
        console.log(chalk.red(`  Directory not found: ${dir}`));
        process.exit(1);
      }
      if (!fs.statSync(dir).isDirectory()) {
        console.log(chalk.red(`  Not a directory: ${dir}`));
        process.exit(1);
      }
      try {
        const { execSync } = await import("node:child_process");
        execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "pipe" });
      } catch {
        console.log(chalk.red(`  Not a git repository: ${dir}`));
        console.log(chalk.dim("  YOLO mode only works on git repos (for safety — all changes on branches)."));
        process.exit(1);
      }
    }

    // Multi-repo: fork a child process per repo (each gets its own DB singleton)
    if (targetDirs.length > 1) {
      console.log(YOLO_BANNER);
      const totalWorkers = parseInt(opts.workers as string, 10) || 1;
      // Distribute workers: 1 per repo, extras go to first repos
      const workersPerRepo = Math.max(1, Math.floor(totalWorkers / targetDirs.length));
      // Only run as many repos in parallel as we have workers
      const maxParallel = Math.min(targetDirs.length, totalWorkers);

      console.log(chalk.bold(`  Burning ${targetDirs.length} repos (${totalWorkers} total agents, ${maxParallel} parallel, ${workersPerRepo}/repo):\n`));
      for (const dir of targetDirs) {
        console.log(chalk.dim(`    ${path.basename(dir).padEnd(25)} ${dir}`));
      }
      console.log();

      const cliEntry = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "index.js"
      );

      function spawnRepo(dir: string) {
        const args = ["yolo"];
        if (focus) args.push(focus);
        args.push("--workers", String(workersPerRepo));
        if (opts.budget) args.push("--budget", opts.budget as string);
        if (opts.seed) args.push("--seed", opts.seed as string);
        if (opts.dryRun) args.push("--dry-run");

        const child = fork(cliEntry, args, {
          cwd: dir,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: { ...process.env },
        });

        const prefix = chalk.cyan(`[${path.basename(dir)}]`);

        child.stdout?.on("data", (data: Buffer) => {
          for (const line of data.toString().split("\n")) {
            if (line.trim()) console.log(`  ${prefix} ${line}`);
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          for (const line of data.toString().split("\n")) {
            if (line.trim()) console.log(`  ${prefix} ${chalk.dim(line)}`);
          }
        });

        return child;
      }

      const activeChildren = new Set<ReturnType<typeof fork>>();

      const cleanup = () => {
        console.log(chalk.yellow("\n  Stopping all agents..."));
        for (const child of activeChildren) {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          for (const child of activeChildren) {
            child.kill("SIGKILL");
          }
          process.exit(0);
        }, 5000);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // Worker pool: spawn up to maxParallel, as one finishes start next
      const queue = [...targetDirs];
      await new Promise<void>((resolveAll) => {
        let finished = 0;
        const total = targetDirs.length;

        function fillPool() {
          while (activeChildren.size < maxParallel && queue.length > 0) {
            const dir = queue.shift()!;
            const child = spawnRepo(dir);
            activeChildren.add(child);

            child.on("close", (code) => {
              activeChildren.delete(child);
              const name = path.basename(dir);
              console.log(
                `  ${chalk.cyan(`[${name}]`)} ${code === 0 ? chalk.green("done") : chalk.red(`exited ${code}`)}`
              );
              finished++;
              if (finished >= total) {
                resolveAll();
              } else {
                fillPool(); // Start next repo in the freed slot
              }
            });
          }
        }

        fillPool();
      });

      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      return;
    }

    const projectRoot = targetDirs[0];

    // Auto-init if burn.yaml doesn't exist
    const configPath = path.join(projectRoot, "burn.yaml");
    if (!fs.existsSync(configPath)) {
      console.log(chalk.dim("  No burn.yaml found — auto-initializing..."));
      fs.mkdirSync(path.join(projectRoot, ".burn"), { recursive: true });
    }

    await runYoloOnRepo(projectRoot, focus, opts);
  });

async function runYoloOnRepo(
  projectRoot: string,
  focus: string | undefined,
  opts: Record<string, string | boolean>
): Promise<void> {
  // Auto-init if burn.yaml doesn't exist
  const configPath = path.join(projectRoot, "burn.yaml");
  if (!fs.existsSync(configPath)) {
    console.log(chalk.dim("  No burn.yaml found — auto-initializing..."));
    fs.mkdirSync(path.join(projectRoot, ".burn"), { recursive: true });
  }

  const config = loadConfig(projectRoot, opts.profile as string);

  // Override config for YOLO mode
  config.execution.maxConcurrentAgents = parseInt(opts.workers as string, 10) || 1;
  config.brainstorm.enabled = true;
  config.brainstorm.intervalMinutes = 5;

  // Auto-approve EVERYTHING
  config.brainstorm.autoApprove = [
    { type: "test" }, { type: "docs" }, { type: "refactor" },
    { type: "performance" }, { type: "security" }, { type: "chore" },
    { type: "bug" }, { type: "feature" },
  ];

  if (opts.budget) {
    config.safety.maxBudgetPerDayUsd = parseFloat(opts.budget as string);
  }

  if (focus) {
    config.brainstorm.focusAreas = parseFocusAreas(focus);
    config.preferences.style = (config.preferences.style ?? "") +
      `\nFocus area for improvements: ${focus}`;
  }

  // Initialize DB (each repo gets its own .burn/)
  getDb(projectRoot);

  console.log(YOLO_BANNER);
  console.log(chalk.dim(`  Repo: ${projectRoot}`));

  const registry = new AdapterRegistry(config);
  const adapter = await registry.selectAdapter();
  if (!adapter) {
    console.log(chalk.red("  No AI CLI available. Install claude, codex, or aider."));
    return;
  }

  console.log(chalk.dim(`  CLI: ${adapter.name}`));
  console.log(chalk.dim(`  Workers: ${config.execution.maxConcurrentAgents}`));
  if (focus) console.log(chalk.dim(`  Focus: ${focus}`));
  if (config.safety.maxBudgetPerDayUsd != null) {
    console.log(chalk.dim(`  Daily budget: $${config.safety.maxBudgetPerDayUsd}`));
  } else {
    console.log(chalk.dim(`  Budget: unlimited`));
  }
  console.log();

  // Seed queue
  const stats = getQueueStats();
  const seedCount = parseInt(opts.seed as string, 10) || 5;

  if (stats.pending === 0) {
    console.log(chalk.cyan(`  Seeding queue with ${seedCount} brainstormed tasks...`));
    console.log();

    const seedTasks = await brainstormSeed(adapter, projectRoot, config, focus, seedCount);

    if (seedTasks.length === 0) {
      console.log(chalk.yellow("  Could not generate initial tasks. Brainstorm loop will kick in.\n"));
    } else {
      for (const t of seedTasks) {
        addTask({
          title: t.title.slice(0, 100),
          description: t.description,
          type: t.type,
          priority: t.priority ?? 3,
          estimatedComplexity: t.estimatedComplexity ?? "medium",
          source: "brainstorm",
        });
        console.log(
          chalk.green("  + ") +
            chalk.dim(`[${t.type}/P${t.priority ?? 3}]`) +
            ` ${t.title.slice(0, 60)}`
        );
      }
      console.log(chalk.dim(`\n  ${seedTasks.length} tasks queued.\n`));
    }
  } else {
    console.log(chalk.dim(`  Queue already has ${stats.pending} pending tasks. Resuming.\n`));
  }

  if (opts.dryRun) {
    console.log(chalk.yellow("  Dry run — not starting agents."));
    console.log(chalk.dim("  Run `burn start` to execute them."));
    return;
  }

  console.log(chalk.bold.red("  Agents are burning. Ctrl+C to stop.\n"));

  const orchestrator = new Orchestrator(projectRoot, config);
  await orchestrator.start();
}

async function brainstormSeed(
  adapter: { execute: Function; name: string },
  projectRoot: string,
  config: any,
  focus: string | undefined,
  count: number
): Promise<Array<{
  title: string;
  description: string;
  type: string;
  priority?: number;
  estimatedComplexity?: string;
}>> {
  const focusHint = focus
    ? `\nFocus specifically on: ${focus}`
    : "\nFocus on: tests, docs, security, performance, code quality";

  const prompt = `Analyze this codebase and suggest exactly ${count} improvements.
Each should be a concrete, self-contained task an AI coding agent can complete.
${focusHint}

Output as a JSON array:
[{"title": "Short title", "description": "Detailed instructions", "type": "test|docs|security|performance|refactor|bug|feature|chore", "priority": 3, "estimatedComplexity": "small"}]

Be specific and actionable. Include file paths where possible.`;

  const cliProcess = adapter.execute({
    prompt,
    cwd: projectRoot,
    model: config.brainstorm?.model ?? "sonnet",
    budgetUsd: 2,
  });

  let output = "";
  process.stdout.write(chalk.dim("  "));

  const result = await monitorProcess(
    (cliProcess as any).process,
    (event: any) => {
      if (event.type === "progress" && event.message) {
        process.stdout.write(chalk.dim("."));
        output += event.message;
      }
      if (event.type === "completion" && event.result) {
        output += event.result;
      }
    },
    undefined,
    300_000
  );

  for (const event of result.events) {
    if (event.type === "completion" && event.result) output += event.result;
  }

  console.log("\n");

  try {
    // Try to find a JSON array in the output
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((t: any) => t.title && t.description)
          .slice(0, count);
      }
    }
  } catch {
    // JSON parse failed — try to extract from markdown code blocks
    try {
      const codeBlockMatch = output.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
      if (codeBlockMatch) {
        const parsed = JSON.parse(codeBlockMatch[1]);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((t: any) => t.title && t.description)
            .slice(0, count);
        }
      }
    } catch {
      // Still failed
    }
  }


  return [];
}

function parseFocusAreas(focus: string): string[] {
  const lower = focus.toLowerCase();

  // Map natural language to brainstorm categories
  const mapping: Record<string, string> = {
    test: "tests",
    tests: "tests",
    testing: "tests",
    coverage: "tests",
    doc: "docs",
    docs: "docs",
    documentation: "docs",
    readme: "docs",
    security: "security",
    auth: "security",
    vuln: "security",
    perf: "performance",
    performance: "performance",
    speed: "performance",
    optimize: "performance",
    refactor: "code-quality",
    clean: "code-quality",
    quality: "code-quality",
    type: "code-quality",
    error: "error-handling",
    errors: "error-handling",
  };

  const areas = new Set<string>();
  for (const word of lower.split(/\s+/)) {
    if (mapping[word]) areas.add(mapping[word]);
  }

  // If nothing matched, keep focus as a general hint and use all areas
  if (areas.size === 0) {
    return ["tests", "docs", "security", "performance", "code-quality"];
  }

  return [...areas];
}
