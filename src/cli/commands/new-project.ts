import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getDb } from "../../db/client.js";
import { loadConfig } from "../../config/loader.js";
import { addTask } from "../../core/task-queue.js";
import { Orchestrator } from "../../core/orchestrator.js";
import { AdapterRegistry } from "../../adapters/registry.js";
import { monitorProcess } from "../../monitor/output-parser.js";
import { loadUserPreferences, mergePreferencesIntoPrompt } from "../../config/preferences.js";

/**
 * `burn new "CLI tool that watches files"` — scaffold and build a new project from scratch.
 *
 * The agent:
 *   1. Creates a directory, git init, sets up package.json/tsconfig from preferences
 *   2. Plans the architecture with AI
 *   3. Breaks the plan into tasks
 *   4. Executes them one by one
 *   5. Adds tests, docs, CI
 *   6. Creates a GitHub repo and pushes
 */
export const newProjectCommand = new Command("new")
  .description("Create and build a new project from scratch with AI")
  .argument("<description>", "What the project should do")
  .option("-n, --name <name>", "Project name (default: auto-generated)")
  .option("--dir <dir>", "Parent directory (default: cwd)")
  .option("--workers <n>", "Concurrent agents", "1")
  .option("--no-github", "Don't create a GitHub repo")
  .option("--dry-run", "Plan only, don't execute")
  .action(async (description: string, opts: Record<string, string | boolean>) => {
    const parentDir = (opts.dir as string) ?? process.cwd();
    const prefs = loadUserPreferences();

    console.log(chalk.bold.hex("#FF6B35")("\n  🔨 burn new — AI builds a project from scratch\n"));

    // Step 1: Ask AI to plan the project
    const config = loadConfig(parentDir);
    const registry = new AdapterRegistry(config);
    const adapter = await registry.selectAdapter();
    if (!adapter) {
      console.log(chalk.red("  No AI CLI available."));
      process.exit(1);
    }

    const prefsContext = mergePreferencesIntoPrompt(prefs);

    const planPrompt = `I want to create a new project:

"${description}"

${prefsContext ? `User preferences:\n${prefsContext}\n` : ""}

Design this project and output a JSON object with:
{
  "name": "project-name-slug",
  "description": "One-line description for package.json",
  "language": "TypeScript|Rust|Python",
  "setup": {
    "files": {
      "package.json": "{ full content }",
      "tsconfig.json": "{ full content }",
      ".gitignore": "content",
      "README.md": "# Project name\\n\\nDescription..."
    }
  },
  "tasks": [
    {
      "title": "Implement core module",
      "description": "Detailed instructions...",
      "type": "feature",
      "priority": 1,
      "estimatedComplexity": "medium"
    }
  ]
}

The "setup.files" should contain the initial scaffolding files.
The "tasks" should be 5-10 ordered steps to build the full project.
Each task should be self-contained and executable by an AI coding agent.
Include tasks for: core features, tests, docs, error handling, and CLI/API.
Use ${prefs.patterns?.preferredLanguages?.[0] ?? "TypeScript"} unless the description implies otherwise.`;

    console.log(chalk.dim(`  Description: ${description}`));
    console.log(chalk.dim(`  CLI: ${adapter.name}`));
    console.log(chalk.dim("  Planning project...\n"));

    // Use a temp dir for the planning CLI call
    const tmpPlanDir = fs.mkdtempSync(path.join(parentDir, ".burn-plan-"));

    let planOutput = "";
    try {
      const cliProcess = adapter.execute({
        prompt: planPrompt,
        cwd: tmpPlanDir,
        model: config.cli.claude?.model
          ? (Array.isArray(config.cli.claude.model) ? config.cli.claude.model[0] : config.cli.claude.model)
          : "sonnet",
        budgetUsd: 3,
        permissionMode: "dangerously-skip",
      });

      const result = await monitorProcess(
        cliProcess.process,
        (event) => {
          if (event.message) planOutput += event.message;
          if (event.result) planOutput += event.result;
        },
        undefined,
        300_000
      );

      for (const event of result.events) {
        if (event.type === "completion" && event.result) planOutput += event.result;
      }
    } finally {
      fs.rmSync(tmpPlanDir, { recursive: true, force: true });
    }

    // Parse the plan
    let plan: {
      name: string;
      description: string;
      language: string;
      setup: { files: Record<string, string> };
      tasks: Array<{
        title: string;
        description: string;
        type: string;
        priority: number;
        estimatedComplexity: string;
      }>;
    };

    try {
      const jsonMatch = planOutput.match(/\{[\s\S]*"name"[\s\S]*"tasks"[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found");
      plan = JSON.parse(jsonMatch[0]);
      if (!plan.name || !plan.tasks?.length) throw new Error("Missing fields");
    } catch {
      console.log(chalk.red("  Failed to parse project plan."));
      if (planOutput.trim()) {
        console.log(chalk.dim(`  Output preview: ${planOutput.trim().slice(0, 300)}...`));
      }
      return;
    }

    const projectName = (opts.name as string) ?? plan.name;
    const projectDir = path.join(parentDir, projectName);

    console.log(chalk.bold(`  Project: ${projectName}`));
    console.log(chalk.dim(`  Language: ${plan.language}`));
    console.log(chalk.dim(`  Description: ${plan.description}`));
    console.log(chalk.dim(`  Directory: ${projectDir}`));
    console.log(chalk.dim(`  Scaffold files: ${Object.keys(plan.setup.files).length}`));
    console.log(chalk.bold(`\n  Tasks (${plan.tasks.length}):\n`));

    for (let i = 0; i < plan.tasks.length; i++) {
      const t = plan.tasks[i];
      console.log(`  ${chalk.bold(String(i + 1))}. ${chalk.cyan(`[${t.type}/${t.estimatedComplexity}]`)} ${t.title}`);
    }

    if (opts.dryRun) {
      console.log(chalk.yellow("\n  Dry run — not creating project."));
      return;
    }

    // Step 2: Create directory and scaffold
    console.log(chalk.cyan(`\n  Creating project directory...`));

    if (fs.existsSync(projectDir)) {
      console.log(chalk.red(`  Directory already exists: ${projectDir}`));
      return;
    }

    fs.mkdirSync(projectDir, { recursive: true });

    // Write scaffold files
    for (const [filePath, content] of Object.entries(plan.setup.files)) {
      const fullPath = path.join(projectDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      console.log(chalk.green("  + ") + filePath);
    }

    // Git init
    execSync("git init", { cwd: projectDir, stdio: "pipe" });
    execSync("git add -A", { cwd: projectDir, stdio: "pipe" });
    execSync('git commit -m "Initial scaffold by burn-harness"', { cwd: projectDir, stdio: "pipe" });
    console.log(chalk.green("  + ") + "git init + initial commit");

    // Create GitHub repo if requested
    if (opts.github !== false) {
      try {
        execSync(
          `gh repo create "${projectName}" --public --source . --push --description ${JSON.stringify(plan.description)}`,
          { cwd: projectDir, stdio: "pipe" }
        );
        console.log(chalk.green("  + ") + `GitHub repo created`);
      } catch {
        console.log(chalk.dim("  Skipped GitHub repo (gh not configured or repo exists)"));
      }
    }

    // Write burn.yaml
    const burnYaml = `cli:
  preference: [claude]
  claude:
    model: [sonnet, opus]
    permissionMode: dangerously-skip
git:
  baseBranch: main
  autoCreatePR: true
  draftPR: true
execution:
  maxConcurrentAgents: ${opts.workers ?? 1}
  taskTimeoutMinutes: 30
brainstorm:
  enabled: true
  focusAreas: [tests, docs, security, performance, code-quality]
  model: sonnet
  maxSuggestionsPerRun: 3
  intervalMinutes: 5
`;
    fs.writeFileSync(path.join(projectDir, "burn.yaml"), burnYaml);
    fs.mkdirSync(path.join(projectDir, ".burn"), { recursive: true });

    // Add .burn/ to .gitignore
    const gitignorePath = path.join(projectDir, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      if (!content.includes(".burn/")) {
        fs.appendFileSync(gitignorePath, "\n.burn/\nburn.local.yaml\n");
      }
    }

    console.log(chalk.green("  + ") + "burn.yaml");

    // Step 3: Queue tasks
    getDb(projectDir);

    for (const t of plan.tasks) {
      addTask({
        title: t.title.slice(0, 100),
        description: t.description,
        type: t.type ?? "feature",
        priority: t.priority ?? 3,
        estimatedComplexity: t.estimatedComplexity ?? "medium",
        source: "brainstorm",
      });
    }

    console.log(chalk.green(`\n  + ${plan.tasks.length} tasks queued`));

    // Step 4: Start burning
    console.log(chalk.bold.hex("#FF6B35")(`\n  🔥 Building ${projectName}. Ctrl+C to stop.\n`));

    const projectConfig = loadConfig(projectDir);
    projectConfig.brainstorm.enabled = true;
    projectConfig.brainstorm.intervalMinutes = 5;
    projectConfig.brainstorm.autoApprove = [
      { type: "test" }, { type: "docs" }, { type: "refactor" },
      { type: "performance" }, { type: "security" }, { type: "chore" },
      { type: "bug" }, { type: "feature" },
    ];

    const orchestrator = new Orchestrator(projectDir, projectConfig);
    await orchestrator.start();
  });
