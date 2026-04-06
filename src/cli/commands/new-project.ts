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

export const newProjectCommand = new Command("new")
  .description("Create and build a new project from scratch with AI")
  .argument("<description>", "What the project should do (or 'brainstorm' for AI to decide)")
  .option("-n, --name <name>", "Project name (default: AI-generated)")
  .option("--dir <dir>", "Parent directory (default: cwd)")
  .option("--workers <n>", "Concurrent agents", "1")
  .option("--no-github", "Don't create a GitHub repo")
  .option("--dry-run", "Plan only, don't execute")
  .option("--rounds <n>", "GAN critique rounds for brainstorm mode", "2")
  .action(async (description: string, opts: Record<string, string | boolean>) => {
    const parentDir = (opts.dir as string) ?? process.cwd();
    const prefs = loadUserPreferences();
    const prefsContext = mergePreferencesIntoPrompt(prefs);

    console.log(chalk.bold.hex("#FF6B35")("\n  🔨 burn new — AI builds a project from scratch\n"));

    const config = loadConfig(parentDir);
    const registry = new AdapterRegistry(config);
    const adapter = await registry.selectAdapter();
    if (!adapter) {
      console.log(chalk.red("  No AI CLI available."));
      process.exit(1);
    }

    const resolvedModel = config.cli.claude?.model
      ? (Array.isArray(config.cli.claude.model) ? config.cli.claude.model[0] : config.cli.claude.model)
      : "sonnet";

    // If user says "brainstorm", run GAN-like proposal/critique loop
    const isBrainstorm = description.toLowerCase() === "brainstorm" || description.toLowerCase() === "surprise me";
    let finalDescription = description;
    let projectName = opts.name as string | undefined;

    if (isBrainstorm) {
      console.log(chalk.cyan("  GAN mode: generating unique project ideas...\n"));
      const result = await brainstormProjectIdea(adapter, parentDir, resolvedModel, prefsContext, parseInt(opts.rounds as string, 10) || 2);
      if (!result) return;
      finalDescription = result.description;
      projectName = projectName ?? result.name;
      console.log(chalk.bold(`\n  Final idea: ${result.name}`));
      console.log(chalk.dim(`  ${result.description}\n`));
    }

    // Phase 1: Plan tasks (no file contents — just task list)
    console.log(chalk.dim("  Planning tasks..."));

    const planPrompt = `I want to create a new project:

"${finalDescription}"

${prefsContext ? `User preferences:\n${prefsContext}\n` : ""}

Output a JSON object with ONLY:
{
  "name": "project-name-slug",
  "description": "One-line description",
  "language": "TypeScript",
  "tasks": [
    {"title": "...", "description": "Detailed agent instructions", "type": "feature", "priority": 1, "estimatedComplexity": "medium"}
  ]
}

Rules:
- "tasks" should be 5-10 ordered steps to build the complete project
- Task 1 MUST be "Set up project scaffold" (create package.json, tsconfig, .gitignore, README, src/ dir)
- Include tasks for: core features, tests, docs, error handling, CLI entry point
- Each task description should be detailed enough for an AI agent to execute without questions
- Use ${prefs.patterns?.preferredLanguages?.[0] ?? "TypeScript"} unless the description implies otherwise
- Do NOT include file contents in the JSON — agents will create files when executing tasks`;

    const tmpDir = fs.mkdtempSync(path.join(parentDir, ".burn-plan-"));
    let planOutput = "";

    try {
      const proc = adapter.execute({
        prompt: planPrompt,
        cwd: tmpDir,
        model: resolvedModel,
        budgetUsd: 2,
        permissionMode: "dangerously-skip",
      });
      const result = await monitorProcess(
        proc.process,
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Parse plan
    let plan: {
      name: string;
      description: string;
      language: string;
      tasks: Array<{
        title: string;
        description: string;
        type: string;
        priority: number;
        estimatedComplexity: string;
      }>;
    };

    try {
      // Try code block first
      const codeBlock = planOutput.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      const raw = codeBlock ? codeBlock[1] : planOutput.match(/\{[\s\S]*"tasks"[\s\S]*\}/)![0];
      plan = JSON.parse(raw);
      if (!plan.tasks?.length) throw new Error("No tasks");
    } catch {
      console.log(chalk.red("  Failed to parse project plan."));
      console.log(chalk.dim(`  Output: ${planOutput.trim().slice(0, 300)}...`));
      return;
    }

    projectName = projectName ?? plan.name;
    const projectDir = path.join(parentDir, projectName);

    console.log(chalk.bold(`\n  Project: ${chalk.cyan(projectName)}`));
    console.log(chalk.dim(`  ${plan.description}`));
    console.log(chalk.dim(`  Language: ${plan.language} | Tasks: ${plan.tasks.length} | Dir: ${projectDir}\n`));

    for (let i = 0; i < plan.tasks.length; i++) {
      const t = plan.tasks[i];
      console.log(`  ${chalk.bold(String(i + 1))}. ${chalk.cyan(`[${t.type}]`)} ${t.title}`);
    }

    if (opts.dryRun) {
      console.log(chalk.yellow("\n  Dry run — not creating project.\n"));
      return;
    }

    // Phase 2: Create directory, git init, minimal scaffold
    console.log(chalk.cyan("\n  Scaffolding..."));

    if (fs.existsSync(projectDir)) {
      console.log(chalk.red(`  Directory exists: ${projectDir}`));
      return;
    }

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), `# ${projectName}\n\n${plan.description}\n`);
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "node_modules/\ndist/\n.burn/\nburn.local.yaml\n");

    execSync("git init", { cwd: projectDir, stdio: "pipe" });
    execSync("git add -A", { cwd: projectDir, stdio: "pipe" });
    execSync('git commit -m "Initial scaffold by burn-harness"', { cwd: projectDir, stdio: "pipe" });
    console.log(chalk.green("  + ") + "git init");

    // GitHub repo
    if (opts.github !== false) {
      try {
        execSync(
          `gh repo create "${projectName}" --public --source . --push --description ${JSON.stringify(plan.description)}`,
          { cwd: projectDir, stdio: "pipe" }
        );
        console.log(chalk.green("  + ") + "GitHub repo created");
      } catch {
        console.log(chalk.dim("  Skipped GitHub repo"));
      }
    }

    // burn.yaml
    fs.writeFileSync(path.join(projectDir, "burn.yaml"), `cli:
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
  intervalMinutes: 5
`);
    fs.mkdirSync(path.join(projectDir, ".burn"), { recursive: true });
    console.log(chalk.green("  + ") + "burn.yaml");

    // Queue tasks
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
    console.log(chalk.green(`  + ${plan.tasks.length} tasks queued`));

    // Start burning
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

/**
 * GAN-like brainstorm: Generator proposes ideas, Critic evaluates.
 * Multiple rounds produce increasingly refined, unique project ideas.
 */
async function brainstormProjectIdea(
  adapter: { execute: Function; name: string },
  parentDir: string,
  model: string,
  prefsContext: string,
  rounds: number
): Promise<{ name: string; description: string } | null> {
  // Create a temp git repo for Claude CLI calls (it needs a git working dir)
  const cwd = fs.mkdtempSync(path.join(parentDir, ".burn-brainstorm-"));
  execSync("git init", { cwd, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd, stdio: "pipe" });

  const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} };

  let currentIdea = "";

  try {
  for (let round = 0; round < rounds; round++) {
    const isFirst = round === 0;
    console.log(chalk.dim(`  Round ${round + 1}/${rounds}...`));

    // Generator: propose an idea
    const genPrompt = isFirst
      ? `You are a creative project idea generator. Propose a unique, useful open-source project idea.

${prefsContext ? `The developer's preferences:\n${prefsContext}\n` : ""}

Requirements:
- Must be something that doesn't already exist (or a significantly better take)
- Should be achievable by one developer in a few days
- Should solve a real problem developers have
- Should be interesting enough to get GitHub stars
- Prefer CLI tools, dev tools, or libraries

Output ONLY a JSON object:
{"name": "project-name", "description": "2-3 sentence description of what it does, why it's useful, and how it's different from existing tools"}`
      : `A critic reviewed the previous idea and said:

Previous idea: ${currentIdea}

Critic feedback: The idea needs to be more unique and useful.

Generate a BETTER, more refined idea that addresses the criticism. Make it more specific, more novel, and more practically useful.

Output ONLY a JSON object:
{"name": "project-name", "description": "2-3 sentence description"}`;

    let genOutput = "";
    const genProc = adapter.execute({
      prompt: genPrompt,
      cwd,
      model,
      budgetUsd: 1,
      permissionMode: "dangerously-skip",
    });
    const genResult = await monitorProcess(
      genProc.process,
      (event: any) => {
        if (event.message) genOutput += event.message;
        if (event.result) genOutput += event.result;
      },
      undefined,
      120_000
    );
    for (const event of genResult.events) {
      if (event.type === "completion" && event.result) genOutput += event.result;
    }

    try {
      const match = genOutput.match(/\{[\s\S]*"name"[\s\S]*"description"[\s\S]*\}/);
      if (match) {
        const idea = JSON.parse(match[0]);
        currentIdea = `${idea.name}: ${idea.description}`;
        console.log(chalk.dim(`    → ${idea.name}: ${idea.description.slice(0, 80)}...`));

        // Last round — skip critic
        if (round === rounds - 1) {
          return { name: idea.name, description: idea.description };
        }
      }
    } catch {
      continue;
    }

    // Critic: evaluate the idea
    const criticPrompt = `You are a harsh but fair project idea critic. Evaluate this project idea:

"${currentIdea}"

Is this actually useful? Does something like this already exist? Is it too ambitious or too trivial?
Would developers actually use this?

Rate 1-10 and give specific criticism. Output ONLY:
{"score": N, "criticism": "what's wrong or could be better", "exists": "name any similar existing tools"}`;

    let criticOutput = "";
    const criticProc = adapter.execute({
      prompt: criticPrompt,
      cwd,
      model,
      budgetUsd: 1,
      permissionMode: "dangerously-skip",
    });
    const criticResult = await monitorProcess(
      criticProc.process,
      (event: any) => {
        if (event.message) criticOutput += event.message;
        if (event.result) criticOutput += event.result;
      },
      undefined,
      120_000
    );
    for (const event of criticResult.events) {
      if (event.type === "completion" && event.result) criticOutput += event.result;
    }

    try {
      const match = criticOutput.match(/\{[\s\S]*"score"[\s\S]*\}/);
      if (match) {
        const critique = JSON.parse(match[0]);
        console.log(chalk.dim(`    Critic: ${critique.score}/10 — ${(critique.criticism as string).slice(0, 80)}`));

        // If score is high enough, accept it
        if (critique.score >= 8) {
          const ideaMatch = currentIdea.match(/^([^:]+):\s*(.*)/);
          if (ideaMatch) {
            return { name: ideaMatch[1], description: ideaMatch[2] };
          }
        }
      }
    } catch {
      // continue to next round
    }
  }

  // Return whatever we have
  const ideaMatch = currentIdea.match(/^([^:]+):\s*(.*)/);
  if (ideaMatch) {
    return { name: ideaMatch[1], description: ideaMatch[2] };
  }

  console.log(chalk.yellow("  Could not generate a project idea."));
  return null;

  } finally {
    cleanup();
  }
}
