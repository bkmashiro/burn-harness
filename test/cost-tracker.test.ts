import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { CostTracker } from "../src/monitor/cost-tracker.js";
import type { BurnConfig } from "../src/config/schema.js";
import * as dbModule from "../src/db/client.js";

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      type TEXT DEFAULT 'chore',
      priority INTEGER DEFAULT 3,
      estimated_complexity TEXT DEFAULT 'medium',
      depends_on TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'pending',
      source TEXT DEFAULT 'user',
      target_files TEXT,
      branch TEXT,
      pr_url TEXT,
      max_attempts INTEGER DEFAULT 3,
      current_attempt INTEGER DEFAULT 0,
      total_tokens_used INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      budget_limit_usd REAL,
      worker_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cost_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      cli TEXT NOT NULL,
      model TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_number INTEGER NOT NULL,
      cli TEXT NOT NULL,
      model TEXT,
      exit_code INTEGER,
      tokens_used INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      failure_reason TEXT,
      log_file TEXT,
      diff_stat TEXT,
      session_id TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT
    );
  `);
  return testDb;
}

function makeConfig(overrides: Partial<BurnConfig["safety"]> = {}): BurnConfig {
  return {
    cli: { preference: ["claude"] },
    git: {
      baseBranch: "main",
      branchPrefix: "burn",
      autoCreatePR: true,
      draftPR: true,
      reviewers: [],
      commitTemplate: "burn({type}): {title} [{taskId}]",
    },
    execution: {
      maxConcurrentAgents: 1,
      taskTimeoutMinutes: 30,
      pollIntervalSeconds: 10,
      maxAttemptsPerTask: 3,
    },
    safety: {
      costWarningThresholdUsd: 5,
      maxFilesModifiedPerTask: 20,
      maxLinesChangedPerTask: 1000,
      requireApprovalForTypes: [],
      forbiddenPaths: [],
      ...overrides,
    },
    brainstorm: {
      enabled: false,
      focusAreas: [],
      ignoreAreas: [],
      model: "sonnet",
      maxSuggestionsPerRun: 5,
      intervalMinutes: 60,
      autoApprove: [],
    },
    preferences: { forbiddenPatterns: [] },
    profiles: {},
  } as BurnConfig;
}

beforeEach(() => {
  db = setupTestDb();
  vi.spyOn(dbModule, "getDb").mockReturnValue(db as any);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe("CostTracker", () => {
  describe("checkBudget", () => {
    it("returns OK when no limits set", () => {
      const tracker = new CostTracker(makeConfig());
      const result = tracker.checkBudget();
      expect(result.exceeded).toBe(false);
      expect(result.action).toBe("none");
    });

    it("detects daily budget exceeded", () => {
      const tracker = new CostTracker(makeConfig({ maxBudgetPerDayUsd: 1 }));

      // Insert cost record
      const today = new Date().toISOString().split("T")[0];
      db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'test')").run();
      db.prepare("INSERT INTO cost_tracking (date, task_id, cli, tokens_in, tokens_out, cost_usd) VALUES (?, 't1', 'claude', 1000, 500, 1.50)").run(today);

      const result = tracker.checkBudget();
      expect(result.exceeded).toBe(true);
      expect(result.reason).toBe("daily-usd");
      expect(result.action).toBe("pause");
    });

    it("detects total budget exceeded", () => {
      const tracker = new CostTracker(makeConfig({ maxBudgetTotalUsd: 10 }));

      const today = new Date().toISOString().split("T")[0];
      db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'test')").run();
      db.prepare("INSERT INTO cost_tracking (date, task_id, cli, tokens_in, tokens_out, cost_usd) VALUES (?, 't1', 'claude', 1000, 500, 15)").run(today);

      const result = tracker.checkBudget();
      expect(result.exceeded).toBe(true);
      expect(result.reason).toBe("total-usd");
      expect(result.action).toBe("stop");
    });
  });

  describe("checkTaskBudget", () => {
    it("returns OK within limits", () => {
      const tracker = new CostTracker(makeConfig({ maxBudgetPerTaskUsd: 5 }));
      const result = tracker.checkTaskBudget(2.0, 1000, 60000);
      expect(result.exceeded).toBe(false);
    });

    it("detects per-task cost exceeded", () => {
      const tracker = new CostTracker(makeConfig({ maxBudgetPerTaskUsd: 5 }));
      const result = tracker.checkTaskBudget(6.0, 1000, 60000);
      expect(result.exceeded).toBe(true);
      expect(result.reason).toBe("task-usd");
    });

    it("detects per-task token limit exceeded", () => {
      const tracker = new CostTracker(makeConfig({ maxTokensPerTask: 10000 }));
      const result = tracker.checkTaskBudget(1.0, 15000, 60000);
      expect(result.exceeded).toBe(true);
      expect(result.reason).toBe("task-tokens");
    });

    it("detects per-task runtime exceeded", () => {
      const tracker = new CostTracker(makeConfig({ maxRuntimePerTaskMinutes: 10 }));
      const result = tracker.checkTaskBudget(1.0, 1000, 15 * 60_000);
      expect(result.exceeded).toBe(true);
      expect(result.reason).toBe("task-runtime");
    });

    it("respects task-specific budget over global", () => {
      const tracker = new CostTracker(makeConfig({ maxBudgetPerTaskUsd: 10 }));
      // Task has its own lower limit
      const result = tracker.checkTaskBudget(3.0, 1000, 60000, 2.0);
      expect(result.exceeded).toBe(true);
      expect(result.reason).toBe("task-usd");
    });
  });

  describe("checkCostWarning", () => {
    it("returns null when under threshold", () => {
      const tracker = new CostTracker(makeConfig({ costWarningThresholdUsd: 5 }));
      expect(tracker.checkCostWarning()).toBeNull();
    });

    it("returns warning when threshold exceeded", () => {
      const tracker = new CostTracker(makeConfig({ costWarningThresholdUsd: 1 }));

      const today = new Date().toISOString().split("T")[0];
      db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'test')").run();
      db.prepare("INSERT INTO cost_tracking (date, task_id, cli, tokens_in, tokens_out, cost_usd) VALUES (?, 't1', 'claude', 1000, 500, 2.00)").run(today);

      const warning = tracker.checkCostWarning();
      expect(warning).not.toBeNull();
      expect(warning).toContain("$2.00");
    });
  });

  describe("convenience getters", () => {
    it("getDailyCost returns 0 with no data", () => {
      const tracker = new CostTracker(makeConfig());
      expect(tracker.getDailyCost()).toBe(0);
    });

    it("getSessionRuntimeMinutes starts at 0", () => {
      const tracker = new CostTracker(makeConfig());
      expect(tracker.getSessionRuntimeMinutes()).toBe(0);
    });

    it("addRuntime accumulates", () => {
      const tracker = new CostTracker(makeConfig());
      tracker.addRuntime(60_000);
      tracker.addRuntime(120_000);
      expect(tracker.getSessionRuntimeMinutes()).toBe(3);
    });

    it("getRemainingDailyBudget returns null when no limit", () => {
      const tracker = new CostTracker(makeConfig());
      expect(tracker.getRemainingDailyBudget()).toBeNull();
    });

    it("getRemainingDailyBudget subtracts spent", () => {
      const tracker = new CostTracker(makeConfig({ maxBudgetPerDayUsd: 10 }));

      const today = new Date().toISOString().split("T")[0];
      db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'test')").run();
      db.prepare("INSERT INTO cost_tracking (date, task_id, cli, tokens_in, tokens_out, cost_usd) VALUES (?, 't1', 'claude', 1000, 500, 3.00)").run(today);

      expect(tracker.getRemainingDailyBudget()).toBeCloseTo(7);
    });
  });

  describe("getLimitsSummary", () => {
    it("returns 'no limits' message when unconfigured", () => {
      const tracker = new CostTracker(makeConfig());
      expect(tracker.getLimitsSummary()).toContain("No budget limits");
    });

    it("includes configured limits", () => {
      const tracker = new CostTracker(makeConfig({
        maxBudgetPerDayUsd: 50,
        maxBudgetPerTaskUsd: 5,
      }));
      const summary = tracker.getLimitsSummary();
      expect(summary).toContain("$50");
      expect(summary).toContain("$5");
    });
  });
});
