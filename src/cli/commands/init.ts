import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { getDb } from "../../db/client.js";

const DEFAULT_CONFIG = `# burn-harness configuration
# See: https://github.com/bkmashiro/burn-harness

cli:
  preference: [claude]  # Fallback order: claude, codex, aider

  claude:
    # Model selection: string or array (first = primary, rest = fallbacks)
    model: [sonnet, opus]     # Try sonnet first, fall back to opus
    # Required for autonomous operation (--print mode can't prompt for approval)
    permissionMode: dangerously-skip
    # appendSystemPrompt: |
    #   Follow project conventions strictly.

git:
  baseBranch: main
  branchPrefix: burn
  autoCreatePR: true
  draftPR: true
  # reviewers: [alice, bob]

execution:
  maxConcurrentAgents: 1
  taskTimeoutMinutes: 30
  maxAttemptsPerTask: 3

safety:
  # All budget limits are OPTIONAL. If not set, burn runs with no caps.
  # Uncomment any limits you want to enforce:

  # USD limits
  # maxBudgetPerTaskUsd: 5.00    # Per-task spending cap
  # maxBudgetPerDayUsd: 50.00    # Daily aggregate cap
  # maxBudgetTotalUsd: 500.00    # Lifetime cap

  # Token limits
  # maxTokensPerTask: 100000     # Max tokens per task
  # maxTokensPerDay: 1000000     # Max tokens per day
  # maxTokensTotal: 10000000     # Lifetime token cap

  # Time limits
  # maxRuntimePerTaskMinutes: 30      # Max wall-clock per task
  # maxRuntimePerDayMinutes: 480      # Max agent runtime per day (8h)
  # maxRuntimePerSessionHours: 12     # Max single session length

  # Budget allocation by task type (% of daily budget)
  # budgetAllocation:
  #   feature: 40
  #   bug: 30
  #   test: 15
  #   brainstorm: 15

  maxFilesModifiedPerTask: 20
  forbiddenPaths:
    - "*.env*"
    - "credentials.*"
    - ".github/workflows/*"

brainstorm:
  enabled: true
  focusAreas: [tests, docs, security, performance]
  model: sonnet
  maxSuggestionsPerRun: 5
  intervalMinutes: 60
  autoApprove: []
  # autoApprove:
  #   - type: test
  #     maxComplexity: small

# preferences:
#   style: |
#     - Use functional patterns
#     - Write tests for all new functions
`;

export const initCommand = new Command("init")
  .description("Initialize burn-harness in the current project")
  .option("--force", "Overwrite existing config")
  .action((opts: Record<string, boolean>) => {
    const projectRoot = process.cwd();
    const configPath = path.join(projectRoot, "burn.yaml");
    const gitignorePath = path.join(projectRoot, ".gitignore");

    // Create burn.yaml
    if (fs.existsSync(configPath) && !opts.force) {
      console.log(
        chalk.yellow("burn.yaml already exists. Use --force to overwrite.")
      );
    } else {
      fs.writeFileSync(configPath, DEFAULT_CONFIG);
      console.log(chalk.green("✓") + " Created burn.yaml");
    }

    // Add .burn/ to .gitignore
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      if (!content.includes(".burn/")) {
        fs.appendFileSync(gitignorePath, "\n# burn-harness\n.burn/\nburn.local.yaml\n");
        console.log(chalk.green("✓") + " Added .burn/ to .gitignore");
      }
    } else {
      fs.writeFileSync(
        gitignorePath,
        "# burn-harness\n.burn/\nburn.local.yaml\n"
      );
      console.log(chalk.green("✓") + " Created .gitignore with .burn/");
    }

    // Initialize database
    getDb(projectRoot);
    console.log(chalk.green("✓") + " Initialized .burn/ database");

    console.log();
    console.log(chalk.bold("Next steps:"));
    console.log(`  1. Edit ${chalk.cyan("burn.yaml")} to configure your preferences`);
    console.log(`  2. ${chalk.cyan("burn add")} ${chalk.dim('"Fix the login bug"')} — add tasks`);
    console.log(`  3. ${chalk.cyan("burn start")} — launch the agent loop`);
    console.log(`  4. ${chalk.cyan("burn queue")} — check progress`);
  });
