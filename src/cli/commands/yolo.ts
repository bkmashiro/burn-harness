import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { fork, execSync as execSyncFn } from "node:child_process";
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
  .option("--rotate <min>", "Minutes per repo before rotating to next (multi-repo only)", "15")
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

      const rotateMinutes = parseInt(opts.rotate as string, 10) || 15;

      console.log(chalk.bold(`  Burning ${targetDirs.length} repos (${totalWorkers} agents, ${maxParallel} parallel, rotate every ${rotateMinutes}m):\n`));
      for (const dir of targetDirs) {
        console.log(chalk.dim(`    ${path.basename(dir).padEnd(25)} ${dir}`));
      }
      console.log();

      // ── Scout Phase: rank repos by how much work they need ──
      console.log(chalk.cyan("  🔍 Scout phase: analyzing all repos to prioritize...\n"));

      const repoScores = await scoutRepos(targetDirs, focus);

      // Sort by score descending (most work needed first)
      const rankedDirs = [...targetDirs].sort((a, b) => {
        return (repoScores.get(b) ?? 0) - (repoScores.get(a) ?? 0);
      });

      console.log(chalk.bold("  Priority order:\n"));
      for (let i = 0; i < rankedDirs.length; i++) {
        const dir = rankedDirs[i];
        const score = repoScores.get(dir) ?? 0;
        const bar = score > 0 ? "█".repeat(Math.min(20, Math.round(score / 5))) : "░";
        console.log(`  ${chalk.dim(`${i + 1}.`)} ${path.basename(dir).padEnd(25)} ${chalk.yellow(bar)} ${score > 0 ? `score: ${score}` : chalk.dim("no data")}`);
      }
      console.log();

      // Replace targetDirs ordering with ranked order
      targetDirs.length = 0;
      targetDirs.push(...rankedDirs);

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

      // Round-robin scheduler: run maxParallel repos at a time,
      // rotate every rotateMinutes so all repos get a turn.
      const activeSlots = new Map<string, ReturnType<typeof fork>>(); // dir → child
      let stopped = false;

      const cleanup = () => {
        stopped = true;
        console.log(chalk.yellow("\n  Stopping all agents..."));
        for (const child of activeSlots.values()) {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          for (const child of activeSlots.values()) {
            child.kill("SIGKILL");
          }
          process.exit(0);
        }, 5000);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // Build a round-robin queue of all repos (infinite rotation)
      let roundRobinIdx = 0;

      function nextRepos(n: number): string[] {
        const picks: string[] = [];
        for (let i = 0; i < n && i < targetDirs.length; i++) {
          picks.push(targetDirs[(roundRobinIdx + i) % targetDirs.length]);
        }
        roundRobinIdx = (roundRobinIdx + n) % targetDirs.length;
        return picks;
      }

      function killSlot(dir: string): Promise<void> {
        const child = activeSlots.get(dir);
        if (!child) return Promise.resolve();
        return new Promise((resolve) => {
          child.on("close", () => {
            activeSlots.delete(dir);
            resolve();
          });
          child.kill("SIGTERM");
          // Force kill after 10s
          setTimeout(() => {
            if (activeSlots.has(dir)) {
              child.kill("SIGKILL");
              activeSlots.delete(dir);
              resolve();
            }
          }, 10000);
        });
      }

      // Main rotation loop
      let rotationCount = 0;
      const reposPerCycle = Math.ceil(targetDirs.length / maxParallel);

      while (!stopped) {
        // Re-scout every full cycle through all repos
        if (rotationCount > 0 && rotationCount % reposPerCycle === 0) {
          console.log(chalk.cyan("\n  🔍 Re-scouting: re-ranking repos based on current state...\n"));
          const newScores = await scoutRepos(targetDirs, focus);
          targetDirs.sort((a, b) => (newScores.get(b) ?? 0) - (newScores.get(a) ?? 0));
          roundRobinIdx = 0; // Reset to start from highest priority

          for (let i = 0; i < Math.min(5, targetDirs.length); i++) {
            const d = targetDirs[i];
            const s = newScores.get(d) ?? 0;
            console.log(chalk.dim(`  ${i + 1}. ${path.basename(d).padEnd(25)} score: ${s}`));
          }
          console.log();
        }

        // Pick next batch of repos
        const batch = nextRepos(maxParallel);

        // Kill any active slots that aren't in the new batch
        const toKill = [...activeSlots.keys()].filter(d => !batch.includes(d));
        if (toKill.length > 0) {
          console.log(chalk.dim(`\n  Rotating: pausing ${toKill.map(d => path.basename(d)).join(", ")}`));
          await Promise.all(toKill.map(killSlot));
        }

        // Start repos that aren't already running
        for (const dir of batch) {
          if (!activeSlots.has(dir)) {
            console.log(chalk.cyan(`  Starting: ${path.basename(dir)}`));
            const child = spawnRepo(dir);
            activeSlots.set(dir, child);

            child.on("close", () => {
              activeSlots.delete(dir);
            });
          }
        }

        rotationCount++;

        // Wait for rotation interval, but rotate early if all active slots exited
        const rotateMs = rotateMinutes * 60_000;
        const deadline = Date.now() + rotateMs;
        while (Date.now() < deadline && !stopped) {
          await new Promise(r => setTimeout(r, 10000));
          // Early rotation: if all children in this batch have exited, no point waiting
          if (activeSlots.size === 0) {
            console.log(chalk.dim("  All slots idle — rotating early."));
            break;
          }
        }
      }

      // Cleanup remaining
      await Promise.all([...activeSlots.keys()].map(killSlot));
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

/**
 * Scout phase: quickly analyze each repo's health to prioritize.
 * No AI calls — pure filesystem analysis. Instant.
 *
 * Scoring heuristic (higher = more work needed):
 *   +20  no tests at all
 *   +15  no README or empty README
 *   +10  no .gitignore
 *   +5   per 100 source files (bigger repos need more work)
 *   +10  no CI config
 *   +5   has TODO/FIXME in source
 *   +3   no type config (tsconfig/pyproject)
 *   -10  already has .burn/ with done tasks (already worked on)
 */
async function scoutRepos(
  dirs: string[],
  _focus: string | undefined
): Promise<Map<string, number>> {
  const exec = execSyncFn;
  const scores = new Map<string, number>();

  for (const dir of dirs) {
    let score = 0;

    try {
      // Count source files
      const srcFiles = countFiles(dir, [".ts", ".js", ".py", ".rs", ".go", ".java"]);
      score += Math.floor(srcFiles / 20); // +1 per 20 files

      // Check for tests
      const hasTests = fs.existsSync(path.join(dir, "test")) ||
        fs.existsSync(path.join(dir, "tests")) ||
        fs.existsSync(path.join(dir, "__tests__")) ||
        fs.existsSync(path.join(dir, "spec"));
      const testFiles = countFiles(dir, [".test.ts", ".test.js", ".spec.ts", ".spec.js", "_test.go", "_test.rs"]);
      if (!hasTests && testFiles === 0) score += 20;
      else if (testFiles > 0 && srcFiles > 0) {
        // Low test ratio
        const ratio = testFiles / srcFiles;
        if (ratio < 0.1) score += 15;
        else if (ratio < 0.3) score += 8;
      }

      // Check for README
      const readme = path.join(dir, "README.md");
      if (!fs.existsSync(readme)) {
        score += 15;
      } else {
        const size = fs.statSync(readme).size;
        if (size < 200) score += 10; // Stub README
      }

      // Check for .gitignore
      if (!fs.existsSync(path.join(dir, ".gitignore"))) score += 10;

      // Check for CI
      const hasCI = fs.existsSync(path.join(dir, ".github", "workflows")) ||
        fs.existsSync(path.join(dir, ".gitlab-ci.yml")) ||
        fs.existsSync(path.join(dir, "Jenkinsfile"));
      if (!hasCI) score += 10;

      // Check for type config
      const hasTypes = fs.existsSync(path.join(dir, "tsconfig.json")) ||
        fs.existsSync(path.join(dir, "pyproject.toml")) ||
        fs.existsSync(path.join(dir, "Cargo.toml"));
      if (!hasTypes && srcFiles > 0) score += 3;

      // Check for TODOs
      try {
        const todoCount = exec(
          `grep -r "TODO\\|FIXME\\|HACK\\|XXX" --include="*.ts" --include="*.js" --include="*.py" --include="*.rs" -c . 2>/dev/null | tail -1`,
          { cwd: dir, encoding: "utf-8", timeout: 5000 }
        ).trim();
        const n = parseInt(todoCount, 10);
        if (n > 0) score += Math.min(10, n);
      } catch { /* no matches or timeout */ }

      // Discount repos already worked on
      const burnDb = path.join(dir, ".burn", "burn.db");
      if (fs.existsSync(burnDb)) {
        try {
          const done = exec(
            `sqlite3 "${burnDb}" "SELECT COUNT(*) FROM tasks WHERE status='done'" 2>/dev/null`,
            { encoding: "utf-8", timeout: 3000 }
          ).trim();
          const doneCount = parseInt(done, 10);
          if (doneCount > 0) score -= Math.min(15, doneCount * 3);
        } catch { /* ignore */ }
      }

    } catch {
      score = 50; // Can't analyze = probably needs work
    }

    scores.set(dir, Math.max(0, score));
  }

  return scores;
}

function countFiles(dir: string, extensions: string[]): number {
  let count = 0;
  try {
    for (const ext of extensions) {
      const result = execSyncFn(
        `find . -name "*${ext}" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.next/*" | wc -l`,
        { cwd: dir, encoding: "utf-8", timeout: 5000 }
      ).trim();
      count += parseInt(result, 10) || 0;
    }
  } catch { /* ignore */ }
  return count;
}

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

  const result = await monitorProcess(
    (cliProcess as any).process,
    (event: any) => {
      if (event.type === "progress" && event.message) {
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
