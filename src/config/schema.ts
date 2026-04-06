import { z } from "zod";

export const CLIConfigSchema = z.object({
  // Model selection: first in list is primary, rest are fallbacks
  // e.g. ["sonnet", "opus"] → try sonnet, fall back to opus on rate-limit
  // Single string also works: "sonnet"
  model: z.union([z.string(), z.array(z.string())]).optional(),
  // Legacy field — merged into model array if model is a string
  fallbackModel: z.string().optional(),
  permissionMode: z.enum(["auto", "dangerously-skip"]).default("auto"),
  maxBudgetPerTask: z.number().positive().optional(),
  appendSystemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const GitConfigSchema = z
  .object({
    baseBranch: z.string().default("main"),
    branchPrefix: z.string().default("burn"),
    autoCreatePR: z.boolean().default(true),
    draftPR: z.boolean().default(true),
    reviewers: z.array(z.string()).default([]),
    commitTemplate: z
      .string()
      .default("burn({type}): {title} [{taskId}]"),
  })
  .default({
    baseBranch: "main",
    branchPrefix: "burn",
    autoCreatePR: true,
    draftPR: true,
    reviewers: [],
    commitTemplate: "burn({type}): {title} [{taskId}]",
  });

export const ExecutionConfigSchema = z
  .object({
    maxConcurrentAgents: z.number().int().positive().default(1),
    taskTimeoutMinutes: z.number().positive().default(30),
    pollIntervalSeconds: z.number().positive().default(10),
    maxAttemptsPerTask: z.number().int().positive().default(3),
  })
  .default({
    maxConcurrentAgents: 1,
    taskTimeoutMinutes: 30,
    pollIntervalSeconds: 10,
    maxAttemptsPerTask: 3,
  });

export const BudgetAllocationSchema = z
  .object({
    // Percentage-based allocation by task type (must sum to <= 100)
    // If not set, no allocation limits — first come first served
    feature: z.number().min(0).max(100).optional(),
    bug: z.number().min(0).max(100).optional(),
    refactor: z.number().min(0).max(100).optional(),
    test: z.number().min(0).max(100).optional(),
    docs: z.number().min(0).max(100).optional(),
    performance: z.number().min(0).max(100).optional(),
    security: z.number().min(0).max(100).optional(),
    chore: z.number().min(0).max(100).optional(),
    brainstorm: z.number().min(0).max(100).optional(),
  })
  .optional();

export const SafetyConfigSchema = z
  .object({
    // USD-based limits (all optional — if unset, no cap)
    maxBudgetPerTaskUsd: z.number().positive().optional(),
    maxBudgetPerDayUsd: z.number().positive().optional(),
    maxBudgetTotalUsd: z.number().positive().optional(),

    // Token-based limits (all optional — if unset, no cap)
    maxTokensPerTask: z.number().int().positive().optional(),
    maxTokensPerDay: z.number().int().positive().optional(),
    maxTokensTotal: z.number().int().positive().optional(),

    // Time-based limits (all optional — if unset, no cap)
    maxRuntimePerTaskMinutes: z.number().positive().optional(),   // wall-clock per task
    maxRuntimePerDayMinutes: z.number().positive().optional(),    // total agent runtime per day
    maxRuntimePerSessionHours: z.number().positive().optional(),  // single `burn start` session

    // Percentage-based budget allocation by task type
    budgetAllocation: BudgetAllocationSchema,

    // Other safety limits
    maxFilesModifiedPerTask: z.number().int().positive().default(20),
    maxLinesChangedPerTask: z.number().int().positive().default(1000),
    requireApprovalForTypes: z.array(z.string()).default(["security"]),
    forbiddenPaths: z
      .array(z.string())
      .default(["*.env*", "credentials.*", ".github/workflows/*"]),
  })
  .default({
    maxFilesModifiedPerTask: 20,
    maxLinesChangedPerTask: 1000,
    requireApprovalForTypes: ["security"],
    forbiddenPaths: ["*.env*", "credentials.*", ".github/workflows/*"],
  });

export const BrainstormConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    focusAreas: z
      .array(z.string())
      .default(["tests", "docs", "security", "performance"]),
    ignoreAreas: z
      .array(z.string())
      .default(["vendor/", "node_modules/", "dist/"]),
    model: z.string().default("sonnet"),
    maxSuggestionsPerRun: z.number().int().positive().default(5),
    intervalMinutes: z.number().positive().default(60),
    autoApprove: z
      .array(
        z.object({
          type: z.string(),
          maxComplexity: z
            .enum(["trivial", "small", "medium", "large", "epic"])
            .optional(),
        })
      )
      .default([]),
  })
  .default({
    enabled: true,
    focusAreas: ["tests", "docs", "security", "performance"],
    ignoreAreas: ["vendor/", "node_modules/", "dist/"],
    model: "sonnet",
    maxSuggestionsPerRun: 5,
    intervalMinutes: 60,
    autoApprove: [],
  });

export const PreferencesSchema = z
  .object({
    language: z.string().optional(),
    style: z.string().optional(),
    forbiddenPatterns: z.array(z.string()).default([]),
    testFramework: z.string().optional(),
    linter: z.string().optional(),
  })
  .default({
    forbiddenPatterns: [],
  });

export const BurnConfigSchema = z.object({
  cli: z
    .object({
      preference: z.array(z.string()).default(["claude"]),
      claude: CLIConfigSchema.optional(),
      codex: CLIConfigSchema.optional(),
      aider: CLIConfigSchema.optional(),
    })
    .default({
      preference: ["claude"],
    }),
  git: GitConfigSchema,
  execution: ExecutionConfigSchema,
  safety: SafetyConfigSchema,
  brainstorm: BrainstormConfigSchema,
  preferences: PreferencesSchema,
  profiles: z.record(z.string(), z.any()).default({}),
});

export type BurnConfig = z.infer<typeof BurnConfigSchema>;
export type CLIConfig = z.infer<typeof CLIConfigSchema>;
