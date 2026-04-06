import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../../db/client.js";
import { loadConfig } from "../../config/loader.js";
import { addTask, getQueueStats } from "../../core/task-queue.js";
import { Orchestrator } from "../../core/orchestrator.js";
import { AdapterRegistry } from "../../adapters/registry.js";
import { monitorProcess } from "../../monitor/output-parser.js";

const YOLO_BANNER = `
${chalk.bold.red("  🔥 YOLO MODE 🔥")}
${chalk.dim("  No queue. No plan. Agents brainstorm and burn autonomously.")}
${chalk.dim("  Press Ctrl+C to stop. Everything runs on branches — main is safe.")}
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
  .option("--workers <n>", "Number of concurrent agents", "1")
  .option("--profile <name>", "Config profile to use")
  .option("--budget <usd>", "Daily budget cap in USD")
  .option("--seed <n>", "Number of initial brainstorm tasks to generate", "5")
  .option("--dry-run", "Brainstorm tasks but don't start agents")
  .action(async (focus: string | undefined, opts: Record<string, string | boolean>) => {
    const projectRoot = process.cwd();

    // Auto-init if burn.yaml doesn't exist
    const configPath = path.join(projectRoot, "burn.yaml");
    if (!fs.existsSync(configPath)) {
      console.log(chalk.dim("  No burn.yaml found — auto-initializing..."));
      const { execSync } = await import("node:child_process");
      try {
        execSync("git rev-parse --is-inside-work-tree", { cwd: projectRoot, stdio: "pipe" });
      } catch {
        console.log(chalk.red("  Not a git repository. Run `git init` first."));
        process.exit(1);
      }
      // Create minimal config
      fs.mkdirSync(path.join(projectRoot, ".burn"), { recursive: true });
    }

    const config = loadConfig(projectRoot, opts.profile as string);

    // Override config for YOLO mode
    config.execution.maxConcurrentAgents = parseInt(opts.workers as string, 10) || 1;
    config.brainstorm.enabled = true;
    config.brainstorm.intervalMinutes = 5; // Brainstorm aggressively

    // Auto-approve EVERYTHING in YOLO mode
    config.brainstorm.autoApprove = [
      { type: "test" },
      { type: "docs" },
      { type: "refactor" },
      { type: "performance" },
      { type: "security" },
      { type: "chore" },
      { type: "bug" },
      { type: "feature" },
    ];

    // Set daily budget if specified
    if (opts.budget) {
      config.safety.maxBudgetPerDayUsd = parseFloat(opts.budget as string);
    }

    // Override focus areas if specified
    if (focus) {
      config.brainstorm.focusAreas = parseFocusAreas(focus);
      config.preferences.style = (config.preferences.style ?? "") +
        `\nFocus area for improvements: ${focus}`;
    }

    // Initialize DB
    getDb(projectRoot);

    console.log(YOLO_BANNER);

    // Check CLI availability
    const registry = new AdapterRegistry(config);
    const adapter = await registry.selectAdapter();
    if (!adapter) {
      console.log(chalk.red("  No AI CLI available. Install claude, codex, or aider."));
      process.exit(1);
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

    // Seed the queue with initial brainstorm
    const stats = getQueueStats();
    const seedCount = parseInt(opts.seed as string, 10) || 5;

    if (stats.pending === 0) {
      console.log(chalk.cyan(`  Seeding queue with ${seedCount} brainstormed tasks...`));
      console.log();

      const seedTasks = await brainstormSeed(
        adapter,
        projectRoot,
        config,
        focus,
        seedCount
      );

      if (seedTasks.length === 0) {
        console.log(chalk.yellow("  Could not generate initial tasks. Starting with empty queue."));
        console.log(chalk.dim("  The brainstorm loop will kick in shortly.\n"));
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
      console.log(chalk.yellow("  Dry run — not starting agents. Tasks are in the queue."));
      console.log(chalk.dim("  Run `burn start` to execute them."));
      return;
    }

    // Start the orchestrator
    console.log(chalk.bold.red("  Agents are burning. Ctrl+C to stop.\n"));

    const orchestrator = new Orchestrator(projectRoot, config);
    await orchestrator.start();
  });

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
    // Parse failure
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
