import { describe, it, expect } from "vitest";
import { BurnConfigSchema } from "../src/config/schema.js";

describe("BurnConfigSchema", () => {
  it("parses minimal config with defaults", () => {
    const config = BurnConfigSchema.parse({});
    expect(config.cli.preference).toEqual(["claude"]);
    expect(config.execution.maxConcurrentAgents).toBe(1);
    expect(config.execution.taskTimeoutMinutes).toBe(30);
    expect(config.safety.maxFilesModifiedPerTask).toBe(20);
    expect(config.brainstorm.enabled).toBe(true);
  });

  it("parses full config", () => {
    const config = BurnConfigSchema.parse({
      cli: {
        preference: ["anthropic", "claude"],
        claude: { model: ["sonnet", "opus"], permissionMode: "dangerously-skip" },
      },
      git: { baseBranch: "develop", branchPrefix: "ai" },
      execution: { maxConcurrentAgents: 3, taskTimeoutMinutes: 60 },
      safety: {
        maxBudgetPerDayUsd: 50,
        maxBudgetPerTaskUsd: 5,
        costWarningThresholdUsd: 10,
      },
      brainstorm: {
        enabled: false,
        focusAreas: ["security"],
      },
    });

    expect(config.cli.preference).toEqual(["anthropic", "claude"]);
    expect(config.git.baseBranch).toBe("develop");
    expect(config.execution.maxConcurrentAgents).toBe(3);
    expect(config.safety.maxBudgetPerDayUsd).toBe(50);
    expect(config.safety.costWarningThresholdUsd).toBe(10);
    expect(config.brainstorm.enabled).toBe(false);
  });

  it("sets costWarningThresholdUsd default to 5", () => {
    const config = BurnConfigSchema.parse({});
    expect(config.safety.costWarningThresholdUsd).toBe(5);
  });

  it("validates budget allocation percentages", () => {
    const config = BurnConfigSchema.parse({
      safety: {
        budgetAllocation: {
          feature: 40,
          bug: 30,
          test: 15,
          brainstorm: 15,
        },
      },
    });
    expect(config.safety.budgetAllocation!.feature).toBe(40);
  });

  it("rejects invalid budget allocation percentages", () => {
    expect(() =>
      BurnConfigSchema.parse({
        safety: {
          budgetAllocation: { feature: 150 },
        },
      })
    ).toThrow();
  });

  it("supports model as string or array", () => {
    const withString = BurnConfigSchema.parse({
      cli: { claude: { model: "sonnet" } },
    });
    expect(withString.cli.claude!.model).toBe("sonnet");

    const withArray = BurnConfigSchema.parse({
      cli: { claude: { model: ["sonnet", "opus"] } },
    });
    expect(withArray.cli.claude!.model).toEqual(["sonnet", "opus"]);
  });

  it("defaults git config correctly", () => {
    const config = BurnConfigSchema.parse({});
    expect(config.git.baseBranch).toBe("main");
    expect(config.git.branchPrefix).toBe("burn");
    expect(config.git.autoCreatePR).toBe(true);
    expect(config.git.draftPR).toBe(true);
    expect(config.git.commitTemplate).toBe("burn({type}): {title} [{taskId}]");
  });

  it("defaults forbidden paths", () => {
    const config = BurnConfigSchema.parse({});
    expect(config.safety.forbiddenPaths).toContain("*.env*");
    expect(config.safety.forbiddenPaths).toContain("credentials.*");
  });

  it("supports profiles", () => {
    const config = BurnConfigSchema.parse({
      profiles: {
        fast: { execution: { maxConcurrentAgents: 5 } },
      },
    });
    expect(config.profiles.fast).toBeDefined();
  });
});
