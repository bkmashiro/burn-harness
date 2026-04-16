import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { getDb } from "../../db/client.js";

const DEFAULT_CONFIG = `# burn-harness configuration
# See: https://github.com/bkmashiro/burn-harness

cli:
  # Adapter preference order. Available: claude, codex, aider, anthropic
  # "anthropic" uses the Anthropic SDK directly (no CLI dependency needed)
  preference: [claude]

  claude:
    # Model selection: string or array (first = primary, rest = fallbacks)
    model: [sonnet, opus]     # Try sonnet first, fall back to opus on rate-limit
    permissionMode: dangerously-skip

  # anthropic:                 # Native Anthropic SDK adapter (requires ANTHROPIC_API_KEY)
  #   model: [sonnet, opus]
  #   maxBudgetPerTask: 5.00

  # codex:
  #   model: codex-mini

  # aider:
  #   model: sonnet

git:
  baseBranch: main
  branchPrefix: burn
  autoCreatePR: true
  draftPR: true
  # reviewers: [alice, bob]
  # commitTemplate: "burn({type}): {title} [{taskId}]"

execution:
  maxConcurrentAgents: 1
  taskTimeoutMinutes: 30
  maxAttemptsPerTask: 3
  # pollIntervalSeconds: 10

safety:
  # All budget limits are OPTIONAL. If not set, burn runs with no caps.

  # USD limits
  # maxBudgetPerTaskUsd: 5.00    # Per-task spending cap
  # maxBudgetPerDayUsd: 50.00    # Daily aggregate cap
  # maxBudgetTotalUsd: 500.00    # Lifetime cap

  # Token limits
  # maxTokensPerTask: 100000
  # maxTokensPerDay: 1000000
  # maxTokensTotal: 10000000

  # Time limits
  # maxRuntimePerTaskMinutes: 30
  # maxRuntimePerDayMinutes: 480      # 8 hours
  # maxRuntimePerSessionHours: 12

  # Cost warning: logs a warning when daily cost exceeds this (default $5)
  costWarningThresholdUsd: 5

  # Budget allocation by task type (% of daily budget, must sum <= 100)
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
  focusAreas: [tests, docs, security, performance, code-quality]
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
