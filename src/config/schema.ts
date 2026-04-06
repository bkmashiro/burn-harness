import { z } from "zod";

export const CLIConfigSchema = z.object({
  model: z.string().optional(),
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

export const SafetyConfigSchema = z
  .object({
    maxBudgetPerTaskUsd: z.number().positive().default(5),
    maxBudgetPerDayUsd: z.number().positive().default(50),
    maxBudgetTotalUsd: z.number().positive().default(500),
    maxFilesModifiedPerTask: z.number().int().positive().default(20),
    maxLinesChangedPerTask: z.number().int().positive().default(1000),
    requireApprovalForTypes: z.array(z.string()).default(["security"]),
    forbiddenPaths: z
      .array(z.string())
      .default(["*.env*", "credentials.*", ".github/workflows/*"]),
  })
  .default({
    maxBudgetPerTaskUsd: 5,
    maxBudgetPerDayUsd: 50,
    maxBudgetTotalUsd: 500,
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
