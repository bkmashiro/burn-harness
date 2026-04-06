import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { getDb } from "../db/client.js";
import { loadConfig } from "../config/loader.js";
import {
  addTask,
  listTasks,
  getQueueStats,
  getDailyCost,
  getTotalCost,
  getDailyTokens,
  getTotalTokens,
  getDailyCostByType,
  type Task,
  type AddTaskInput,
} from "../core/task-queue.js";
import { Orchestrator } from "../core/orchestrator.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { monitorProcess } from "../monitor/output-parser.js";
import type { BurnConfig } from "../config/schema.js";

const BANNER = `
${chalk.bold.hex("#FF6B35")("  ╔══════════════════════════════════════╗")}
${chalk.bold.hex("#FF6B35")("  ║")}  ${chalk.bold("burn-harness")} ${chalk.dim("v0.1.0")}                 ${chalk.bold.hex("#FF6B35")("║")}
${chalk.bold.hex("#FF6B35")("  ║")}  ${chalk.dim("AI coding agent orchestrator")}         ${chalk.bold.hex("#FF6B35")("║")}
${chalk.bold.hex("#FF6B35")("  ╚══════════════════════════════════════╝")}
`;

const HELP_TEXT = `
${chalk.bold("Commands:")}

  ${chalk.cyan("Task Management")}
  ${chalk.bold("/add")} ${chalk.dim("<description>")}     Add a task to the queue
  ${chalk.bold("/add-interactive")}            Guided task creation wizard
  ${chalk.bold("/queue")}  ${chalk.dim("or")} ${chalk.bold("/q")}             Show the task queue
  ${chalk.bold("/status")}                     Show system status
  ${chalk.bold("/promote")} ${chalk.dim("<id>")}             Move task to front
  ${chalk.bold("/retry")} ${chalk.dim("<id>")}               Retry a failed task
  ${chalk.bold("/cancel")} ${chalk.dim("<id>")}              Cancel a task
  ${chalk.bold("/rollback")} ${chalk.dim("<id>")}            Undo a task's changes
  ${chalk.bold("/report")}                     Cost and usage report
  ${chalk.bold("/budget")}                     Show budget limits and usage

  ${chalk.cyan("Agent Control")}
  ${chalk.bold("/start")}                      Start the agent loop
  ${chalk.bold("/stop")}                       Stop the agent loop
  ${chalk.bold("/brainstorm")}                 Run brainstorm now (agent analyzes codebase)
  ${chalk.bold("/review")}                     Review brainstormed suggestions

  ${chalk.cyan("Interactive Modes")}
  ${chalk.bold("/plan")} ${chalk.dim("<goal>")}               Plan a project with AI (break into tasks)
  ${chalk.bold("/chat")} ${chalk.dim("<question>")}           Ask the AI agent a question about the codebase
  ${chalk.bold("/refine")} ${chalk.dim("<id>")}               Refine a task's description with AI help

  ${chalk.cyan("System")}
  ${chalk.bold("/config")}                     Show current config
  ${chalk.bold("/help")}  ${chalk.dim("or")} ${chalk.bold("/?")}              Show this help
  ${chalk.bold("/clear")}                      Clear the screen
  ${chalk.bold("/exit")}  ${chalk.dim("or")} ${chalk.bold("Ctrl+C")}          Exit

  ${chalk.dim("Tip: Just type naturally! Anything without / prefix is treated as")}
  ${chalk.dim('a new task to add. e.g. "Fix the login bug" adds it directly.')}
`;

type InteractiveState = {
  config: BurnConfig;
  orchestrator: Orchestrator | null;
  projectRoot: string;
};

export async function startInteractive(): Promise<void> {
  const projectRoot = process.cwd();

  // Initialize DB
  getDb(projectRoot);

  const config = loadConfig(projectRoot);
  const state: InteractiveState = {
    config,
    orchestrator: null,
    projectRoot,
  };

  console.log(BANNER);

  // Show quick status
  printQuickStatus();

  console.log(chalk.dim("  Type /help for commands, or just describe a task to add it.\n"));

  const rl = readline.createInterface({ input, output, prompt: chalk.hex("#FF6B35")("burn > ") });

  rl.prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    try {
      await handleInput(trimmed, state, rl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`Error: ${msg}`));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    if (state.orchestrator) {
      state.orchestrator.stop();
    }
    console.log(chalk.dim("\nGoodbye!"));
    process.exit(0);
  });
}

async function handleInput(
  input: string,
  state: InteractiveState,
  rl: readline.Interface
): Promise<void> {
  // Slash commands
  if (input.startsWith("/")) {
    const [cmd, ...args] = input.split(/\s+/);
    const argStr = args.join(" ");

    switch (cmd.toLowerCase()) {
      case "/help":
      case "/?":
        console.log(HELP_TEXT);
        return;

      case "/clear":
        console.clear();
        console.log(BANNER);
        return;

      case "/exit":
      case "/quit":
        rl.close();
        return;

      case "/add":
        if (!argStr) {
          console.log(chalk.yellow("Usage: /add <task description>"));
          return;
        }
        await handleQuickAdd(argStr);
        return;

      case "/add-interactive":
        await handleInteractiveAdd(rl);
        return;

      case "/queue":
      case "/q":
        handleQueue(argStr);
        return;

      case "/status":
        handleStatus(state);
        return;

      case "/promote":
        handlePromote(argStr);
        return;

      case "/retry":
        handleRetry(argStr);
        return;

      case "/cancel":
        handleCancel(argStr);
        return;

      case "/start":
        await handleStart(state);
        return;

      case "/stop":
        handleStop(state);
        return;

      case "/brainstorm":
        await handleBrainstorm(state);
        return;

      case "/review":
        await handleReview(state, rl);
        return;

      case "/plan":
        await handlePlan(argStr, state, rl);
        return;

      case "/chat":
        await handleChat(argStr, state);
        return;

      case "/refine":
        await handleRefine(argStr, state, rl);
        return;

      case "/report":
        handleReport();
        return;

      case "/budget":
        handleBudget(state);
        return;

      case "/config":
        handleConfig(state);
        return;

      case "/rollback":
        handleRollback(argStr);
        return;

      default:
        console.log(chalk.yellow(`Unknown command: ${cmd}. Type /help for available commands.`));
        return;
    }
  }

  // No slash prefix — treat as a quick task add
  await handleQuickAdd(input);
}

// ─── Command Handlers ─────────────────────────────────────────────────────

async function handleQuickAdd(description: string): Promise<void> {
  // Smart type detection from description
  const type = detectTaskType(description);
  const priority = detectPriority(description);

  const task = addTask({
    title: description.slice(0, 100),
    description,
    type,
    priority,
  });

  console.log(
    chalk.green("  + ") +
      `Task ${chalk.bold(task.id.slice(-6))} added — ${chalk.dim(`[${type}/P${priority}]`)} ${description.slice(0, 60)}`
  );
}

async function handleInteractiveAdd(rl: readline.Interface): Promise<void> {
  console.log(chalk.cyan("\n  Task Creation Wizard\n"));

  const title = await ask(rl, "  Title: ");
  if (!title) {
    console.log(chalk.yellow("  Cancelled."));
    return;
  }

  const description = await ask(rl, "  Description (or press Enter to use title): ");

  const typeChoices = "bug, feature, refactor, test, docs, performance, security, chore";
  const typeInput = await ask(rl, `  Type [${chalk.dim(typeChoices)}] (default: chore): `);
  const type = typeInput || "chore";

  const priorityInput = await ask(rl, "  Priority 1-5 [1=critical, 5=nice-to-have] (default: 3): ");
  const priority = parseInt(priorityInput, 10) || 3;

  const complexityInput = await ask(rl, "  Complexity [trivial/small/medium/large/epic] (default: medium): ");
  const complexity = complexityInput || "medium";

  const filesInput = await ask(rl, "  Target files (comma-separated, or Enter to skip): ");
  const budgetInput = await ask(rl, "  Budget cap in USD (or Enter for default): ");

  const input: AddTaskInput = {
    title: title.slice(0, 100),
    description: description || title,
    type,
    priority,
    estimatedComplexity: complexity,
    targetFiles: filesInput ? filesInput.split(",").map((s) => s.trim()) : undefined,
    budgetLimitUsd: budgetInput ? parseFloat(budgetInput) : undefined,
  };

  const task = addTask(input);
  console.log(
    chalk.green("\n  + ") +
      `Task ${chalk.bold(task.id.slice(-6))} created!`
  );
  printTaskDetail(task);
}

function handleQueue(filter: string): void {
  let tasks: Task[];
  if (filter) {
    const [key, value] = filter.split("=");
    tasks = listTasks(
      key === "status" ? { status: value } : key === "type" ? { type: value } : {}
    );
  } else {
    tasks = listTasks();
    tasks = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
  }

  const stats = getQueueStats();
  console.log(
    chalk.bold("\n  Task Queue") +
      chalk.dim(
        ` — ${stats.pending} pending, ${stats.executing} running, ${stats.done} done, ${stats.failed} failed`
      )
  );

  if (tasks.length === 0) {
    console.log(chalk.dim("  Queue is empty. Add tasks or run /brainstorm.\n"));
    return;
  }

  console.log();
  for (const task of tasks) {
    const id = chalk.dim(task.id.slice(-6));
    const status = colorStatus(task.status);
    const type = chalk.dim(`[${task.type}]`.padEnd(14));
    const pri = `P${task.priority}`;
    const title = task.title.slice(0, 55);
    const cost = task.estimated_cost_usd > 0
      ? chalk.dim(` $${task.estimated_cost_usd.toFixed(2)}`)
      : "";
    console.log(`  ${id}  ${status} ${pri} ${type} ${title}${cost}`);
    if (task.pr_url) {
      console.log(chalk.dim(`          PR: ${task.pr_url}`));
    }
  }
  console.log();
}

function handleStatus(state: InteractiveState): void {
  const stats = getQueueStats();
  const dailyCost = getDailyCost();
  const totalCost = getTotalCost();

  console.log(chalk.bold("\n  System Status\n"));

  // Agent loop
  const loopStatus = state.orchestrator
    ? chalk.green("RUNNING")
    : chalk.yellow("STOPPED");
  console.log(`  Agent loop:   ${loopStatus}`);
  console.log();

  // Queue
  console.log(`  Pending:      ${chalk.yellow(String(stats.pending))}`);
  console.log(`  Executing:    ${chalk.blue(String(stats.executing))}`);
  console.log(`  Done:         ${chalk.green(String(stats.done))}`);
  console.log(`  Failed:       ${chalk.red(String(stats.failed))}`);
  console.log();

  // Costs
  const s = state.config.safety;
  const dailyLimit = s.maxBudgetPerDayUsd != null ? ` / $${s.maxBudgetPerDayUsd}` : "";
  const totalLimit = s.maxBudgetTotalUsd != null ? ` / $${s.maxBudgetTotalUsd}` : "";
  console.log(`  Today's cost: ${chalk.bold("$" + dailyCost.toFixed(2))}${dailyLimit}`);
  console.log(`  Total cost:   ${chalk.bold("$" + totalCost.toFixed(2))}${totalLimit}`);

  // Token usage
  const dailyTokens = getDailyTokens();
  const totalTokens = getTotalTokens();
  const dailyTokenLimit = s.maxTokensPerDay != null ? ` / ${s.maxTokensPerDay.toLocaleString()}` : "";
  const totalTokenLimit = s.maxTokensTotal != null ? ` / ${s.maxTokensTotal.toLocaleString()}` : "";
  if (dailyTokens > 0 || s.maxTokensPerDay != null) {
    console.log(`  Tokens today: ${dailyTokens.toLocaleString()}${dailyTokenLimit}`);
  }
  if (totalTokens > 0 || s.maxTokensTotal != null) {
    console.log(`  Tokens total: ${totalTokens.toLocaleString()}${totalTokenLimit}`);
  }

  // Budget mode
  const hasAnyLimit = s.maxBudgetPerDayUsd != null || s.maxBudgetTotalUsd != null ||
    s.maxTokensPerDay != null || s.maxTokensTotal != null ||
    s.maxRuntimePerDayMinutes != null || s.maxRuntimePerSessionHours != null;
  if (!hasAnyLimit) {
    console.log(chalk.dim("\n  No budget limits set — running with no caps."));
  }

  console.log();
}

function handlePromote(idSuffix: string): void {
  if (!idSuffix) {
    console.log(chalk.yellow("  Usage: /promote <task-id>"));
    return;
  }
  const db = getDb();
  const result = db
    .prepare("UPDATE tasks SET priority = 0 WHERE id LIKE ? AND status = 'pending'")
    .run(`%${idSuffix}`);
  if (result.changes > 0) {
    console.log(chalk.green("  + ") + "Task promoted to highest priority.");
  } else {
    console.log(chalk.yellow("  No matching pending task found."));
  }
}

function handleRetry(idSuffix: string): void {
  if (!idSuffix) {
    console.log(chalk.yellow("  Usage: /retry <task-id>"));
    return;
  }
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE tasks SET status = 'pending', current_attempt = 0, worker_id = NULL, completed_at = NULL WHERE id LIKE ? AND status = 'failed'"
    )
    .run(`%${idSuffix}`);
  if (result.changes > 0) {
    console.log(chalk.green("  + ") + "Task reset for retry.");
  } else {
    console.log(chalk.yellow("  No matching failed task found."));
  }
}

function handleCancel(idSuffix: string): void {
  if (!idSuffix) {
    console.log(chalk.yellow("  Usage: /cancel <task-id>"));
    return;
  }
  const db = getDb();
  const result = db
    .prepare("UPDATE tasks SET status = 'cancelled', completed_at = datetime('now') WHERE id LIKE ?")
    .run(`%${idSuffix}`);
  if (result.changes > 0) {
    console.log(chalk.green("  + ") + "Task cancelled.");
  } else {
    console.log(chalk.yellow("  No matching task found."));
  }
}

function handleRollback(idSuffix: string): void {
  if (!idSuffix) {
    console.log(chalk.yellow("  Usage: /rollback <task-id>"));
    return;
  }
  // Delegate to the non-interactive rollback logic
  const { execSync } = require("node:child_process");
  try {
    const output = execSync(
      `node ${process.argv[1]} rollback ${idSuffix}`,
      { encoding: "utf-8" }
    );
    console.log(output);
  } catch (err: any) {
    console.log(chalk.red("  Rollback failed: " + (err.stderr || err.message)));
  }
}

async function handleStart(state: InteractiveState): Promise<void> {
  if (state.orchestrator) {
    console.log(chalk.yellow("  Agent loop is already running."));
    return;
  }

  console.log(chalk.cyan("  Starting agent loop in background..."));
  state.orchestrator = new Orchestrator(
    state.projectRoot,
    state.config
  );

  // Run in background — don't await
  state.orchestrator.start().catch((err) => {
    console.log(chalk.red(`\n  Agent loop error: ${err.message}`));
    state.orchestrator = null;
  });

  // Give it a moment to initialize
  await sleep(1000);

  const adapter = await new AdapterRegistry(state.config).selectAdapter();
  if (adapter) {
    console.log(chalk.green("  + ") + `Agent loop started. Using ${chalk.bold(adapter.name)}.`);
  } else {
    console.log(chalk.red("  No AI CLI available. Install claude, codex, or aider."));
    state.orchestrator.stop();
    state.orchestrator = null;
  }
}

function handleStop(state: InteractiveState): void {
  if (!state.orchestrator) {
    console.log(chalk.yellow("  Agent loop is not running."));
    return;
  }
  state.orchestrator.stop();
  state.orchestrator = null;
  console.log(chalk.green("  + ") + "Agent loop stopped.");
}

async function handleBrainstorm(state: InteractiveState): Promise<void> {
  console.log(chalk.cyan("  Analyzing codebase for improvements...\n"));

  const registry = new AdapterRegistry(state.config);
  const adapter = await registry.selectAdapter();
  if (!adapter) {
    console.log(chalk.red("  No AI CLI available."));
    return;
  }

  const prompt = `Analyze this codebase and suggest 5 improvements. For each, provide:
1. A concise title
2. A detailed description of what to do and why
3. Type: bug | feature | refactor | test | docs | performance | security | chore
4. Priority: 1-5
5. Estimated complexity: trivial | small | medium | large

Output as a JSON array:
[{"title": "...", "description": "...", "type": "...", "priority": 3, "estimatedComplexity": "small"}]

Focus on: ${state.config.brainstorm.focusAreas.join(", ")}
Be specific and actionable.`;

  const cliProcess = adapter.execute({
    prompt,
    cwd: state.projectRoot,
    model: state.config.brainstorm.model,
    budgetUsd: 2,
  });

  let output = "";
  const result = await monitorProcess(
    cliProcess.process,
    (event) => {
      if (event.type === "progress" && event.message) {
        process.stdout.write(chalk.dim("."));
      }
    },
    undefined,
    300_000
  );

  for (const event of result.events) {
    if (event.type === "completion" && event.result) output += event.result;
    if (event.type === "progress" && event.message) output += event.message;
  }

  console.log("\n");

  // Parse suggestions
  try {
    const jsonMatch = output.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const suggestions = JSON.parse(jsonMatch[0]) as Array<{
        title: string;
        description: string;
        type: string;
        priority: number;
        estimatedComplexity: string;
      }>;

      if (suggestions.length === 0) {
        console.log(chalk.dim("  No suggestions generated."));
        return;
      }

      console.log(chalk.bold(`  Found ${suggestions.length} suggestions:\n`));

      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        console.log(
          `  ${chalk.bold(String(i + 1))}. ${chalk.cyan(`[${s.type}/P${s.priority}/${s.estimatedComplexity}]`)} ${s.title}`
        );
        console.log(chalk.dim(`     ${s.description.slice(0, 100)}${s.description.length > 100 ? "..." : ""}`));
      }

      console.log(chalk.dim("\n  These suggestions are saved. Use /review to approve them.\n"));

      // Store as brainstormed tasks
      const db = getDb();
      for (const s of suggestions) {
        db.prepare(
          "INSERT INTO brainstorm_history (title, description, type, status) VALUES (?, ?, ?, 'suggested')"
        ).run(s.title, s.description, s.type);
      }
    } else {
      console.log(chalk.dim("  Could not parse suggestions from AI output."));
      if (output.trim()) {
        console.log(chalk.dim("  Raw output:"));
        console.log(chalk.dim("  " + output.slice(0, 500)));
      }
    }
  } catch {
    console.log(chalk.dim("  Failed to parse brainstorm output."));
  }
}

async function handleReview(_state: InteractiveState, rl: readline.Interface): Promise<void> {
  const db = getDb();
  const suggestions = db
    .prepare("SELECT * FROM brainstorm_history WHERE status = 'suggested' ORDER BY created_at DESC LIMIT 20")
    .all() as Array<{
    id: number;
    title: string;
    description: string;
    type: string;
  }>;

  if (suggestions.length === 0) {
    console.log(chalk.dim("  No pending suggestions. Run /brainstorm first."));
    return;
  }

  console.log(chalk.bold(`\n  Review ${suggestions.length} brainstormed suggestions\n`));
  console.log(chalk.dim("  For each: [a]pprove  [r]eject  [e]dit  [s]kip  [q]uit\n"));

  for (const s of suggestions) {
    console.log(`  ${chalk.bold(s.title)}`);
    console.log(`  ${chalk.dim(`Type: ${s.type}`)} | ${chalk.dim(s.description.slice(0, 120))}`);

    const action = await ask(rl, chalk.cyan("  Action [a/r/e/s/q]: "));

    switch (action.toLowerCase()) {
      case "a":
      case "approve": {
        const task = addTask({
          title: s.title,
          description: s.description,
          type: s.type,
          source: "brainstorm",
        });
        db.prepare("UPDATE brainstorm_history SET status = 'approved' WHERE id = ?").run(s.id);
        console.log(chalk.green("  + ") + `Approved → Task ${task.id.slice(-6)}\n`);
        break;
      }
      case "r":
      case "reject":
        db.prepare("UPDATE brainstorm_history SET status = 'rejected' WHERE id = ?").run(s.id);
        console.log(chalk.red("  - ") + "Rejected\n");
        break;
      case "e":
      case "edit": {
        const newTitle = await ask(rl, `  New title [${s.title}]: `);
        const newDesc = await ask(rl, `  New description: `);
        const task = addTask({
          title: (newTitle || s.title).slice(0, 100),
          description: newDesc || s.description,
          type: s.type,
          source: "brainstorm",
        });
        db.prepare("UPDATE brainstorm_history SET status = 'approved' WHERE id = ?").run(s.id);
        console.log(chalk.green("  + ") + `Edited & approved → Task ${task.id.slice(-6)}\n`);
        break;
      }
      case "q":
      case "quit":
        console.log(chalk.dim("  Review paused. Remaining suggestions kept for later.\n"));
        return;
      default:
        console.log(chalk.dim("  Skipped.\n"));
        break;
    }
  }

  console.log(chalk.dim("  Review complete!\n"));
}

async function handlePlan(goal: string, state: InteractiveState, rl: readline.Interface): Promise<void> {
  if (!goal) {
    console.log(chalk.yellow("  Usage: /plan <your goal or feature description>"));
    console.log(chalk.dim('  e.g. /plan Add user authentication with OAuth2'));
    return;
  }

  console.log(chalk.cyan("\n  Planning with AI agent...\n"));

  const registry = new AdapterRegistry(state.config);
  const adapter = await registry.selectAdapter();
  if (!adapter) {
    console.log(chalk.red("  No AI CLI available."));
    return;
  }

  const prompt = `I want to accomplish this goal in this codebase:

"${goal}"

Analyze the codebase and break this down into a sequence of concrete, actionable tasks.
Each task should be small enough for an AI coding agent to complete in one session.

Output as a JSON array:
[
  {
    "title": "Short task title",
    "description": "Detailed instructions for the AI agent",
    "type": "bug|feature|refactor|test|docs|performance|security|chore",
    "priority": 1,
    "estimatedComplexity": "trivial|small|medium|large",
    "dependsOn": [],
    "targetFiles": ["path/to/file.ts"]
  }
]

Order tasks by execution order. Use dependsOn (by index, 0-based) to chain dependent tasks.
Be specific about what each task should do and which files it should touch.`;

  const cliProcess = adapter.execute({
    prompt,
    cwd: state.projectRoot,
    model: state.config.cli.claude?.model ?? "sonnet",
    budgetUsd: 3,
  });

  let planOutput = "";
  process.stdout.write(chalk.dim("  Thinking"));
  const result = await monitorProcess(
    cliProcess.process,
    (event) => {
      if (event.type === "progress") process.stdout.write(chalk.dim("."));
      if (event.message) planOutput += event.message;
      if (event.result) planOutput += event.result;
    },
    undefined,
    300_000
  );
  for (const event of result.events) {
    if (event.type === "completion" && event.result) planOutput += event.result;
  }
  console.log("\n");

  try {
    const jsonMatch = planOutput.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      console.log(chalk.dim("  Could not parse plan. Raw output:"));
      console.log(chalk.dim("  " + planOutput.slice(0, 500)));
      return;
    }

    const tasks = JSON.parse(jsonMatch[0]) as Array<{
      title: string;
      description: string;
      type: string;
      priority: number;
      estimatedComplexity: string;
      dependsOn?: number[];
      targetFiles?: string[];
    }>;

    console.log(chalk.bold(`  Plan: ${tasks.length} tasks\n`));
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const deps = t.dependsOn?.length
        ? chalk.dim(` (after: ${t.dependsOn.map((d) => `#${d + 1}`).join(", ")})`)
        : "";
      console.log(
        `  ${chalk.bold(String(i + 1))}. ${chalk.cyan(`[${t.type}/${t.estimatedComplexity}]`)} ${t.title}${deps}`
      );
      console.log(chalk.dim(`     ${t.description.slice(0, 100)}${t.description.length > 100 ? "..." : ""}`));
    }

    console.log();
    const confirm = await ask(rl, chalk.cyan("  Add all tasks to queue? [y/n/edit]: "));

    if (confirm.toLowerCase() === "y" || confirm.toLowerCase() === "yes") {
      const createdIds: string[] = [];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        // Resolve dependency indices to real task IDs
        const dependsOn = (t.dependsOn ?? [])
          .filter((idx) => idx < createdIds.length)
          .map((idx) => createdIds[idx]);

        const created = addTask({
          title: t.title.slice(0, 100),
          description: t.description,
          type: t.type,
          priority: t.priority ?? 3,
          estimatedComplexity: t.estimatedComplexity ?? "medium",
          dependsOn,
          targetFiles: t.targetFiles,
        });
        createdIds.push(created.id);
      }
      console.log(
        chalk.green(`\n  + `) +
          `${tasks.length} tasks added to queue with dependency chain.`
      );
      console.log(chalk.dim("  Run /start to begin execution.\n"));
    } else if (confirm.toLowerCase() === "edit") {
      console.log(chalk.dim("  Edit mode: approve each task individually.\n"));
      const createdIds: string[] = [];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        console.log(`  ${chalk.bold(String(i + 1))}. ${t.title}`);
        const action = await ask(rl, chalk.cyan("  [a]dd / [s]kip / [e]dit: "));

        if (action.toLowerCase() === "a" || action.toLowerCase() === "add") {
          const dependsOn = (t.dependsOn ?? [])
            .filter((idx) => idx < createdIds.length)
            .map((idx) => createdIds[idx]);
          const created = addTask({
            title: t.title.slice(0, 100),
            description: t.description,
            type: t.type,
            priority: t.priority ?? 3,
            estimatedComplexity: t.estimatedComplexity ?? "medium",
            dependsOn,
            targetFiles: t.targetFiles,
          });
          createdIds.push(created.id);
          console.log(chalk.green("  + ") + `Added as ${created.id.slice(-6)}`);
        } else if (action.toLowerCase() === "e" || action.toLowerCase() === "edit") {
          const newTitle = await ask(rl, `  Title [${t.title}]: `);
          const newDesc = await ask(rl, `  Description [Enter to keep]: `);
          const dependsOn = (t.dependsOn ?? [])
            .filter((idx) => idx < createdIds.length)
            .map((idx) => createdIds[idx]);
          const created = addTask({
            title: (newTitle || t.title).slice(0, 100),
            description: newDesc || t.description,
            type: t.type,
            priority: t.priority ?? 3,
            estimatedComplexity: t.estimatedComplexity ?? "medium",
            dependsOn,
            targetFiles: t.targetFiles,
          });
          createdIds.push(created.id);
          console.log(chalk.green("  + ") + `Added as ${created.id.slice(-6)}`);
        } else {
          createdIds.push(""); // Placeholder to keep indices correct
          console.log(chalk.dim("  Skipped."));
        }
      }
      console.log();
    } else {
      console.log(chalk.dim("  Plan discarded.\n"));
    }
  } catch (err) {
    console.log(chalk.red(`  Failed to parse plan: ${err}`));
  }
}

async function handleChat(question: string, state: InteractiveState): Promise<void> {
  if (!question) {
    console.log(chalk.yellow("  Usage: /chat <your question>"));
    console.log(chalk.dim("  e.g. /chat How does the auth middleware work?"));
    return;
  }

  const registry = new AdapterRegistry(state.config);
  const adapter = await registry.selectAdapter();
  if (!adapter) {
    console.log(chalk.red("  No AI CLI available."));
    return;
  }

  console.log();
  const cliProcess = adapter.execute({
    prompt: question,
    cwd: state.projectRoot,
    model: state.config.cli.claude?.model ?? "sonnet",
    budgetUsd: 1,
  });

  let response = "";
  await monitorProcess(
    cliProcess.process,
    (event) => {
      if (event.type === "progress" && event.message) {
        process.stdout.write(event.message);
        response += event.message;
      }
      if (event.type === "completion" && event.result) {
        process.stdout.write(event.result);
        response += event.result;
      }
    },
    undefined,
    120_000
  );
  console.log("\n");
}

async function handleRefine(idSuffix: string, state: InteractiveState, rl: readline.Interface): Promise<void> {
  if (!idSuffix) {
    console.log(chalk.yellow("  Usage: /refine <task-id>"));
    return;
  }

  const db = getDb();
  const rows = db.prepare("SELECT * FROM tasks WHERE id LIKE ?").all(`%${idSuffix}`) as Task[];
  if (rows.length === 0) {
    console.log(chalk.yellow("  Task not found."));
    return;
  }
  if (rows.length > 1) {
    console.log(chalk.yellow("  Multiple matches. Be more specific."));
    return;
  }

  const task = rows[0];
  console.log(chalk.bold(`\n  Refining: ${task.title}`));
  console.log(chalk.dim(`  Current description: ${task.description.slice(0, 200)}\n`));

  const registry = new AdapterRegistry(state.config);
  const adapter = await registry.selectAdapter();
  if (!adapter) {
    console.log(chalk.red("  No AI CLI available."));
    return;
  }

  const prompt = `I have a task for an AI coding agent:

Title: ${task.title}
Description: ${task.description}
Type: ${task.type}
Target files: ${task.target_files ?? "not specified"}

Please analyze the codebase and refine this task description to be more specific and actionable.
Include:
1. Which files need to be modified
2. What specific changes to make
3. Any edge cases to handle
4. How to verify the changes work

Output the refined description as plain text (not JSON).`;

  console.log(chalk.dim("  Analyzing...\n"));

  const cliProcess = adapter.execute({
    prompt,
    cwd: state.projectRoot,
    model: state.config.cli.claude?.model ?? "sonnet",
    budgetUsd: 2,
  });

  let refinedDesc = "";
  await monitorProcess(
    cliProcess.process,
    (event) => {
      if (event.type === "progress" && event.message) {
        refinedDesc += event.message;
      }
      if (event.type === "completion" && event.result) {
        refinedDesc += event.result;
      }
    },
    undefined,
    180_000
  );

  if (!refinedDesc.trim()) {
    console.log(chalk.yellow("  Could not generate refinement."));
    return;
  }

  console.log(chalk.bold("  Refined description:\n"));
  // Print with indentation
  for (const line of refinedDesc.split("\n")) {
    console.log(`  ${line}`);
  }

  console.log();
  const confirm = await ask(rl, chalk.cyan("  Update task with refined description? [y/n]: "));
  if (confirm.toLowerCase() === "y" || confirm.toLowerCase() === "yes") {
    db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(
      refinedDesc.trim(),
      task.id
    );
    console.log(chalk.green("  + ") + "Task description updated.\n");
  } else {
    console.log(chalk.dim("  Kept original description.\n"));
  }
}

function handleReport(): void {
  const db = getDb();
  const dailyCosts = db
    .prepare(
      `SELECT date, SUM(cost_usd) as cost, SUM(tokens_in + tokens_out) as tokens, COUNT(*) as requests
       FROM cost_tracking
       WHERE date >= date('now', '-7 days')
       GROUP BY date ORDER BY date DESC`
    )
    .all() as { date: string; cost: number; tokens: number; requests: number }[];

  console.log(chalk.bold("\n  Cost Report (last 7 days)\n"));

  if (dailyCosts.length === 0) {
    console.log(chalk.dim("  No cost data yet.\n"));
  } else {
    console.log(chalk.dim("  Date        Cost      Tokens     Requests"));
    for (const row of dailyCosts) {
      console.log(
        `  ${row.date}  $${row.cost.toFixed(2).padStart(7)}  ${String(row.tokens).padStart(10)}  ${String(row.requests).padStart(8)}`
      );
    }
    const total = dailyCosts.reduce((s, r) => s + r.cost, 0);
    console.log(chalk.bold(`  ${"Total".padEnd(10)}  $${total.toFixed(2).padStart(7)}`));
    console.log();
  }
}

function handleBudget(state: InteractiveState): void {
  const s = state.config.safety;
  const dailyCost = getDailyCost();
  const totalCost = getTotalCost();
  const dailyTokens = getDailyTokens();
  const totalTokens = getTotalTokens();

  console.log(chalk.bold("\n  Budget Dashboard\n"));

  const hasAnyLimit = s.maxBudgetPerTaskUsd != null || s.maxBudgetPerDayUsd != null ||
    s.maxBudgetTotalUsd != null || s.maxTokensPerTask != null ||
    s.maxTokensPerDay != null || s.maxTokensTotal != null ||
    s.maxRuntimePerTaskMinutes != null || s.maxRuntimePerDayMinutes != null ||
    s.maxRuntimePerSessionHours != null;

  if (!hasAnyLimit) {
    console.log(chalk.green("  No budget limits configured — running with no caps."));
    console.log(chalk.dim("  Set limits in burn.yaml under safety: to control spending.\n"));
    console.log(`  Spent today:  $${dailyCost.toFixed(2)}  (${dailyTokens.toLocaleString()} tokens)`);
    console.log(`  Spent total:  $${totalCost.toFixed(2)}  (${totalTokens.toLocaleString()} tokens)`);
    console.log();
    return;
  }

  // USD limits
  if (s.maxBudgetPerTaskUsd != null || s.maxBudgetPerDayUsd != null || s.maxBudgetTotalUsd != null) {
    console.log(chalk.cyan("  USD Budget"));
    if (s.maxBudgetPerTaskUsd != null) {
      console.log(`  Per-task cap:   $${s.maxBudgetPerTaskUsd}`);
    }
    if (s.maxBudgetPerDayUsd != null) {
      const pct = Math.min(100, (dailyCost / s.maxBudgetPerDayUsd) * 100);
      const bar = makeBar(pct);
      console.log(`  Daily:          $${dailyCost.toFixed(2)} / $${s.maxBudgetPerDayUsd}  ${bar} ${pct.toFixed(0)}%`);
    }
    if (s.maxBudgetTotalUsd != null) {
      const pct = Math.min(100, (totalCost / s.maxBudgetTotalUsd) * 100);
      const bar = makeBar(pct);
      console.log(`  Total:          $${totalCost.toFixed(2)} / $${s.maxBudgetTotalUsd}  ${bar} ${pct.toFixed(0)}%`);
    }
    console.log();
  }

  // Token limits
  if (s.maxTokensPerTask != null || s.maxTokensPerDay != null || s.maxTokensTotal != null) {
    console.log(chalk.cyan("  Token Budget"));
    if (s.maxTokensPerTask != null) {
      console.log(`  Per-task cap:   ${s.maxTokensPerTask.toLocaleString()}`);
    }
    if (s.maxTokensPerDay != null) {
      const pct = Math.min(100, (dailyTokens / s.maxTokensPerDay) * 100);
      const bar = makeBar(pct);
      console.log(`  Daily:          ${dailyTokens.toLocaleString()} / ${s.maxTokensPerDay.toLocaleString()}  ${bar} ${pct.toFixed(0)}%`);
    }
    if (s.maxTokensTotal != null) {
      const pct = Math.min(100, (totalTokens / s.maxTokensTotal) * 100);
      const bar = makeBar(pct);
      console.log(`  Total:          ${totalTokens.toLocaleString()} / ${s.maxTokensTotal.toLocaleString()}  ${bar} ${pct.toFixed(0)}%`);
    }
    console.log();
  }

  // Time limits
  if (s.maxRuntimePerTaskMinutes != null || s.maxRuntimePerDayMinutes != null || s.maxRuntimePerSessionHours != null) {
    console.log(chalk.cyan("  Time Budget"));
    if (s.maxRuntimePerTaskMinutes != null) console.log(`  Per-task max:   ${s.maxRuntimePerTaskMinutes}m`);
    if (s.maxRuntimePerDayMinutes != null) console.log(`  Daily max:      ${s.maxRuntimePerDayMinutes}m`);
    if (s.maxRuntimePerSessionHours != null) console.log(`  Session max:    ${s.maxRuntimePerSessionHours}h`);
    console.log();
  }

  // Budget allocation
  if (s.budgetAllocation && s.maxBudgetPerDayUsd != null) {
    console.log(chalk.cyan("  Type Allocation (% of daily USD budget)"));
    for (const [type, pct] of Object.entries(s.budgetAllocation)) {
      if (pct == null) continue;
      const typeLimit = (pct / 100) * s.maxBudgetPerDayUsd;
      const typeSpent = getDailyCostByType(type);
      const usedPct = Math.min(100, (typeSpent / typeLimit) * 100);
      const bar = makeBar(usedPct);
      console.log(`  ${type.padEnd(14)} ${String(pct).padStart(3)}%  $${typeSpent.toFixed(2)} / $${typeLimit.toFixed(2)}  ${bar}`);
    }
    console.log();
  }

  console.log(chalk.dim("  Note: CLIs that don't report tokens/cost use runtime estimation."));
  console.log();
}

function makeBar(pct: number): string {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct >= 90 ? chalk.red : pct >= 70 ? chalk.yellow : chalk.green;
  return color("[" + "=".repeat(filled) + " ".repeat(empty) + "]");
}

function handleConfig(state: InteractiveState): void {
  const s = state.config.safety;
  console.log(chalk.bold("\n  Current Configuration\n"));

  console.log(chalk.cyan("  Execution"));
  console.log(`  CLI preference: ${state.config.cli.preference.join(", ")}`);
  console.log(`  Base branch:    ${state.config.git.baseBranch}`);
  console.log(`  Max workers:    ${state.config.execution.maxConcurrentAgents}`);
  console.log(`  Task timeout:   ${state.config.execution.taskTimeoutMinutes}m`);
  console.log();

  console.log(chalk.cyan("  Budget Limits"));
  const hasAnyLimit = s.maxBudgetPerTaskUsd != null || s.maxBudgetPerDayUsd != null ||
    s.maxBudgetTotalUsd != null || s.maxTokensPerTask != null ||
    s.maxTokensPerDay != null || s.maxTokensTotal != null ||
    s.maxRuntimePerTaskMinutes != null || s.maxRuntimePerDayMinutes != null ||
    s.maxRuntimePerSessionHours != null;

  if (!hasAnyLimit) {
    console.log(chalk.dim("  No budget limits — running with no caps."));
  } else {
    if (s.maxBudgetPerTaskUsd != null) console.log(`  USD/task:       $${s.maxBudgetPerTaskUsd}`);
    if (s.maxBudgetPerDayUsd != null) console.log(`  USD/day:        $${s.maxBudgetPerDayUsd}`);
    if (s.maxBudgetTotalUsd != null) console.log(`  USD total:      $${s.maxBudgetTotalUsd}`);
    if (s.maxTokensPerTask != null) console.log(`  Tokens/task:    ${s.maxTokensPerTask.toLocaleString()}`);
    if (s.maxTokensPerDay != null) console.log(`  Tokens/day:     ${s.maxTokensPerDay.toLocaleString()}`);
    if (s.maxTokensTotal != null) console.log(`  Tokens total:   ${s.maxTokensTotal.toLocaleString()}`);
    if (s.maxRuntimePerTaskMinutes != null) console.log(`  Runtime/task:   ${s.maxRuntimePerTaskMinutes}m`);
    if (s.maxRuntimePerDayMinutes != null) console.log(`  Runtime/day:    ${s.maxRuntimePerDayMinutes}m`);
    if (s.maxRuntimePerSessionHours != null) console.log(`  Session max:    ${s.maxRuntimePerSessionHours}h`);
  }

  if (s.budgetAllocation) {
    console.log();
    console.log(chalk.cyan("  Budget Allocation (% of daily)"));
    for (const [type, pct] of Object.entries(s.budgetAllocation)) {
      if (pct != null) console.log(`  ${type.padEnd(14)} ${pct}%`);
    }
  }

  console.log();
  console.log(chalk.cyan("  Brainstorm"));
  console.log(`  Enabled:        ${state.config.brainstorm.enabled ? chalk.green("yes") : chalk.yellow("no")}`);
  console.log(`  Focus areas:    ${state.config.brainstorm.focusAreas.join(", ")}`);
  console.log();
}

// ─── Utilities ──────────────────────────────────────────────────────────

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  const answer = await (rl as any).question(prompt);
  return String(answer).trim();
}

function printQuickStatus(): void {
  const stats = getQueueStats();
  const dailyCost = getDailyCost();

  if (stats.total === 0) {
    console.log(chalk.dim("  Queue is empty. Type a task description to get started.\n"));
  } else {
    console.log(
      `  ${chalk.yellow(stats.pending + " pending")} · ${chalk.blue(stats.executing + " running")} · ${chalk.green(stats.done + " done")} · ${chalk.dim("$" + dailyCost.toFixed(2) + " today")}\n`
    );
  }
}

function printTaskDetail(task: Task): void {
  console.log(`  ${chalk.dim("ID:")}         ${task.id.slice(-6)}`);
  console.log(`  ${chalk.dim("Type:")}       ${task.type}`);
  console.log(`  ${chalk.dim("Priority:")}   P${task.priority}`);
  console.log(`  ${chalk.dim("Complexity:")} ${task.estimated_complexity}`);
  console.log(`  ${chalk.dim("Status:")}     ${colorStatus(task.status)}`);
  console.log();
}

function colorStatus(status: string): string {
  const colors: Record<string, (s: string) => string> = {
    pending: chalk.yellow,
    blocked: chalk.gray,
    planning: chalk.cyan,
    executing: chalk.blue,
    reviewing: chalk.magenta,
    done: chalk.green,
    failed: chalk.red,
    cancelled: chalk.gray,
    brainstormed: chalk.italic.gray,
  };
  const fn = colors[status] ?? chalk.white;
  return fn(status.padEnd(11));
}

function detectTaskType(description: string): string {
  const lower = description.toLowerCase();
  if (/\b(fix|bug|crash|error|broken|null|undefined|exception)\b/.test(lower)) return "bug";
  if (/\b(add|create|implement|new|feature)\b/.test(lower)) return "feature";
  if (/\b(refactor|extract|rename|move|clean|simplify)\b/.test(lower)) return "refactor";
  if (/\b(test|spec|coverage)\b/.test(lower)) return "test";
  if (/\b(doc|readme|comment|jsdoc)\b/.test(lower)) return "docs";
  if (/\b(perf|speed|slow|fast|optimize|cache|memo)\b/.test(lower)) return "performance";
  if (/\b(security|auth|xss|injection|csrf|vulnerab)\b/.test(lower)) return "security";
  return "chore";
}

function detectPriority(description: string): number {
  const lower = description.toLowerCase();
  if (/\b(critical|urgent|asap|crash|broken|blocker)\b/.test(lower)) return 1;
  if (/\b(important|high)\b/.test(lower)) return 2;
  if (/\b(nice.?to.?have|low|when.?possible)\b/.test(lower)) return 4;
  return 3;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
