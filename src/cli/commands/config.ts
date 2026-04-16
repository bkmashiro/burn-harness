import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";

export const configCommand = new Command("config")
  .description("View or edit burn-harness configuration")
  .addCommand(
    new Command("view")
      .description("Show resolved configuration")
      .option("--profile <name>", "Show config with profile applied")
      .option("--raw", "Show raw YAML instead of formatted output")
      .action((opts: { profile?: string; raw?: boolean }) => {
        const projectRoot = process.cwd();
        const config = loadConfig(projectRoot, opts.profile);

        if (opts.raw) {
          console.log(YAML.stringify(config));
          return;
        }

        console.log(chalk.bold("burn-harness configuration"));
        console.log(chalk.dim(`  Project: ${projectRoot}`));
        console.log();

        // CLI
        console.log(chalk.bold("  CLI"));
        console.log(`    Preference: ${config.cli.preference.join(" → ")}`);
        for (const name of config.cli.preference) {
          const cliConfig = config.cli[name as keyof typeof config.cli];
          if (cliConfig && typeof cliConfig === "object") {
            const cfg = cliConfig as Record<string, unknown>;
            const model = Array.isArray(cfg.model)
              ? (cfg.model as string[]).join(" → ")
              : (cfg.model as string) ?? "default";
            console.log(`    ${name}: model=${model}`);
          }
        }
        console.log();

        // Git
        console.log(chalk.bold("  Git"));
        console.log(`    Base branch: ${config.git.baseBranch}`);
        console.log(`    Branch prefix: ${config.git.branchPrefix}`);
        console.log(`    Auto-create PR: ${config.git.autoCreatePR}`);
        console.log(`    Draft PR: ${config.git.draftPR}`);
        console.log();

        // Execution
        console.log(chalk.bold("  Execution"));
        console.log(`    Max workers: ${config.execution.maxConcurrentAgents}`);
        console.log(`    Task timeout: ${config.execution.taskTimeoutMinutes}m`);
        console.log(`    Max attempts: ${config.execution.maxAttemptsPerTask}`);
        console.log();

        // Safety
        console.log(chalk.bold("  Safety"));
        const s = config.safety;
        if (s.maxBudgetPerTaskUsd != null) console.log(`    Per-task budget: $${s.maxBudgetPerTaskUsd}`);
        if (s.maxBudgetPerDayUsd != null) console.log(`    Daily budget: $${s.maxBudgetPerDayUsd}`);
        if (s.maxBudgetTotalUsd != null) console.log(`    Total budget: $${s.maxBudgetTotalUsd}`);
        if (s.maxTokensPerDay != null) console.log(`    Daily tokens: ${s.maxTokensPerDay.toLocaleString()}`);
        if (s.costWarningThresholdUsd != null) console.log(`    Cost warning at: $${s.costWarningThresholdUsd}`);
        console.log(`    Max files/task: ${s.maxFilesModifiedPerTask}`);
        console.log(`    Forbidden paths: ${s.forbiddenPaths.join(", ")}`);
        console.log();

        // Brainstorm
        console.log(chalk.bold("  Brainstorm"));
        console.log(`    Enabled: ${config.brainstorm.enabled}`);
        console.log(`    Focus: ${config.brainstorm.focusAreas.join(", ")}`);
        console.log(`    Interval: ${config.brainstorm.intervalMinutes}m`);
        console.log(`    Auto-approve: ${config.brainstorm.autoApprove.length > 0 ? config.brainstorm.autoApprove.map((r) => `${r.type}${r.maxComplexity ? `(≤${r.maxComplexity})` : ""}`).join(", ") : "none"}`);
        console.log();

        // Config files found
        console.log(chalk.bold("  Config Files"));
        const userConfig = path.join(process.env.HOME ?? "~", ".config", "burn", "config.yaml");
        const projectConfig = path.join(projectRoot, "burn.yaml");
        const localConfig = path.join(projectRoot, "burn.local.yaml");
        console.log(`    User:    ${fs.existsSync(userConfig) ? chalk.green(userConfig) : chalk.dim("not found")}`);
        console.log(`    Project: ${fs.existsSync(projectConfig) ? chalk.green(projectConfig) : chalk.dim("not found")}`);
        console.log(`    Local:   ${fs.existsSync(localConfig) ? chalk.green(localConfig) : chalk.dim("not found")}`);
        console.log();
      })
  )
  .addCommand(
    new Command("set")
      .description("Set a config value in burn.local.yaml")
      .argument("<key>", "Dot-separated config key (e.g., safety.maxBudgetPerDayUsd)")
      .argument("<value>", "Value to set")
      .action((key: string, value: string) => {
        const projectRoot = process.cwd();
        const localPath = path.join(projectRoot, "burn.local.yaml");

        // Load existing local config
        let localConfig: Record<string, unknown> = {};
        if (fs.existsSync(localPath)) {
          const content = fs.readFileSync(localPath, "utf-8");
          localConfig = (YAML.parse(content) as Record<string, unknown>) ?? {};
        }

        // Parse value
        let parsedValue: unknown = value;
        if (value === "true") parsedValue = true;
        else if (value === "false") parsedValue = false;
        else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10);
        else if (/^\d+\.\d+$/.test(value)) parsedValue = parseFloat(value);
        else if (value.startsWith("[") && value.endsWith("]")) {
          try {
            parsedValue = JSON.parse(value);
          } catch {
            parsedValue = value;
          }
        }

        // Set nested key
        const parts = key.split(".");
        let current = localConfig;
        for (let i = 0; i < parts.length - 1; i++) {
          if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
            current[parts[i]] = {};
          }
          current = current[parts[i]] as Record<string, unknown>;
        }
        current[parts[parts.length - 1]] = parsedValue;

        // Write back
        fs.writeFileSync(localPath, YAML.stringify(localConfig));
        console.log(chalk.green("✓") + ` Set ${chalk.cyan(key)} = ${chalk.bold(String(parsedValue))} in burn.local.yaml`);
      })
  )
  .addCommand(
    new Command("paths")
      .description("Show config file locations")
      .action(() => {
        const projectRoot = process.cwd();
        const userConfig = path.join(process.env.HOME ?? "~", ".config", "burn", "config.yaml");
        const projectConfig = path.join(projectRoot, "burn.yaml");
        const localConfig = path.join(projectRoot, "burn.local.yaml");

        console.log(chalk.bold("Config file locations (loaded in order):"));
        console.log(`  1. User:    ${userConfig} ${fs.existsSync(userConfig) ? chalk.green("(exists)") : chalk.dim("(not found)")}`);
        console.log(`  2. Project: ${projectConfig} ${fs.existsSync(projectConfig) ? chalk.green("(exists)") : chalk.dim("(not found)")}`);
        console.log(`  3. Local:   ${localConfig} ${fs.existsSync(localConfig) ? chalk.green("(exists)") : chalk.dim("(not found)")}`);
        console.log();
        console.log(chalk.dim("Later files override earlier ones. burn.local.yaml is gitignored."));
      })
  );
