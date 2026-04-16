import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  addTask,
  getTask,
  listTasks,
  claimNextTask,
  updateTaskStatus,
  recordAttempt,
  recordCost,
  getDailyCost,
  getTotalCost,
  getDailyTokens,
  getBlockedBy,
  getDependencyGraph,
  renderDependencyTree,
  getCostByAdapter,
  getPerTaskCosts,
  estimateQueueCost,
  getHourlyCosts,
  getQueueStats,
} from "../src/core/task-queue.js";

// We need to mock getDb to use an in-memory database
import * as dbModule from "../src/db/client.js";
import { vi } from "vitest";

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");

  // Create tables matching the real schema
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
  `);

  return testDb;
}

beforeEach(() => {
  db = setupTestDb();
  vi.spyOn(dbModule, "getDb").mockReturnValue(db as any);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe("addTask", () => {
  it("creates a task with default values", () => {
    const task = addTask({ title: "Test task" });
    expect(task).toBeDefined();
    expect(task.title).toBe("Test task");
    expect(task.type).toBe("chore");
    expect(task.priority).toBe(3);
    expect(task.status).toBe("pending");
    expect(task.estimated_complexity).toBe("medium");
    expect(task.max_attempts).toBe(3);
    expect(task.current_attempt).toBe(0);
  });

  it("creates a task with custom values", () => {
    const task = addTask({
      title: "Fix login bug",
      type: "bug",
      priority: 1,
      estimatedComplexity: "large",
      tags: ["auth", "critical"],
      dependsOn: ["abc123"],
    });
    expect(task.type).toBe("bug");
    expect(task.priority).toBe(1);
    expect(task.estimated_complexity).toBe("large");
    expect(JSON.parse(task.tags)).toEqual(["auth", "critical"]);
    expect(JSON.parse(task.depends_on)).toEqual(["abc123"]);
  });
});

describe("getTask", () => {
  it("returns undefined for non-existent task", () => {
    expect(getTask("nonexistent")).toBeUndefined();
  });

  it("retrieves an existing task", () => {
    const created = addTask({ title: "Find me" });
    const found = getTask(created.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Find me");
  });
});

describe("listTasks", () => {
  it("returns empty array when no tasks", () => {
    expect(listTasks()).toEqual([]);
  });

  it("returns all tasks", () => {
    addTask({ title: "Task 1" });
    addTask({ title: "Task 2" });
    expect(listTasks()).toHaveLength(2);
  });

  it("filters by status", () => {
    addTask({ title: "Pending task" });
    const done = addTask({ title: "Done task" });
    updateTaskStatus(done.id, "done");
    expect(listTasks({ status: "pending" })).toHaveLength(1);
    expect(listTasks({ status: "done" })).toHaveLength(1);
  });

  it("filters by type", () => {
    addTask({ title: "Bug", type: "bug" });
    addTask({ title: "Feature", type: "feature" });
    expect(listTasks({ type: "bug" })).toHaveLength(1);
  });
});

describe("claimNextTask", () => {
  it("returns undefined when queue is empty", () => {
    expect(claimNextTask("worker-0")).toBeUndefined();
  });

  it("claims the highest priority task", () => {
    addTask({ title: "Low priority", priority: 5 });
    addTask({ title: "High priority", priority: 1 });
    const claimed = claimNextTask("worker-0");
    expect(claimed).toBeDefined();
    expect(claimed!.title).toBe("High priority");
    expect(claimed!.status).toBe("planning");
    expect(claimed!.worker_id).toBe("worker-0");
  });

  it("skips tasks with unmet dependencies", () => {
    const dep = addTask({ title: "Dependency" });
    addTask({ title: "Dependent", dependsOn: [dep.id] });
    addTask({ title: "Independent" });

    const claimed = claimNextTask("worker-0");
    expect(claimed).toBeDefined();
    // Should claim either the dependency or the independent, not the dependent
    expect(claimed!.title).not.toBe("Dependent");
  });

  it("allows claiming task after dependency is done", () => {
    const dep = addTask({ title: "Dependency" });
    const dependent = addTask({ title: "Dependent", dependsOn: [dep.id] });

    // Complete dependency
    updateTaskStatus(dep.id, "done");

    // Claim remaining tasks
    const claimed1 = claimNextTask("worker-0");
    expect(claimed1).toBeDefined();
    // One of the remaining pending tasks should be claimable
  });
});

describe("updateTaskStatus", () => {
  it("updates task status", () => {
    const task = addTask({ title: "Test" });
    updateTaskStatus(task.id, "executing");
    expect(getTask(task.id)!.status).toBe("executing");
  });

  it("sets completed_at for terminal states", () => {
    const task = addTask({ title: "Test" });
    updateTaskStatus(task.id, "done");
    expect(getTask(task.id)!.completed_at).not.toBeNull();
  });

  it("sets completed_at for failed state", () => {
    const task = addTask({ title: "Test" });
    updateTaskStatus(task.id, "failed");
    expect(getTask(task.id)!.completed_at).not.toBeNull();
  });

  it("accepts extra fields", () => {
    const task = addTask({ title: "Test" });
    updateTaskStatus(task.id, "reviewing", { pr_url: "https://github.com/pr/1" });
    expect(getTask(task.id)!.pr_url).toBe("https://github.com/pr/1");
  });
});

describe("recordAttempt", () => {
  it("records an attempt and updates task totals", () => {
    const task = addTask({ title: "Test" });
    recordAttempt({
      taskId: task.id,
      attemptNumber: 1,
      cli: "claude",
      model: "sonnet",
      exitCode: 0,
      tokensUsed: 5000,
      costUsd: 0.15,
    });

    const updated = getTask(task.id)!;
    expect(updated.total_tokens_used).toBe(5000);
    expect(updated.estimated_cost_usd).toBeCloseTo(0.15);
  });
});

describe("cost tracking", () => {
  it("records and retrieves daily cost", () => {
    const task = addTask({ title: "Test" });
    recordCost({
      taskId: task.id,
      cli: "claude",
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.05,
    });

    expect(getDailyCost()).toBeCloseTo(0.05);
  });

  it("records and retrieves total cost", () => {
    const task = addTask({ title: "Test" });
    recordCost({ taskId: task.id, cli: "claude", tokensIn: 1000, tokensOut: 500, costUsd: 0.10 });
    recordCost({ taskId: task.id, cli: "claude", tokensIn: 2000, tokensOut: 1000, costUsd: 0.20 });
    expect(getTotalCost()).toBeCloseTo(0.30);
  });

  it("tracks daily tokens", () => {
    const task = addTask({ title: "Test" });
    recordCost({ taskId: task.id, cli: "claude", tokensIn: 1000, tokensOut: 500, costUsd: 0.05 });
    expect(getDailyTokens()).toBe(1500);
  });

  it("returns cost by adapter", () => {
    const task = addTask({ title: "Test" });
    recordCost({ taskId: task.id, cli: "claude", tokensIn: 1000, tokensOut: 500, costUsd: 0.10 });
    recordCost({ taskId: task.id, cli: "anthropic", tokensIn: 2000, tokensOut: 1000, costUsd: 0.20 });

    const adapters = getCostByAdapter();
    expect(adapters).toHaveLength(2);
    expect(adapters[0].cli).toBe("anthropic"); // Higher cost first
    expect(adapters[0].cost).toBeCloseTo(0.20);
  });

  it("returns per-task costs", () => {
    const task1 = addTask({ title: "Expensive" });
    const task2 = addTask({ title: "Cheap" });
    recordAttempt({ taskId: task1.id, attemptNumber: 1, cli: "claude", costUsd: 1.50, tokensUsed: 10000 });
    recordAttempt({ taskId: task2.id, attemptNumber: 1, cli: "claude", costUsd: 0.10, tokensUsed: 1000 });

    // Mark as completed
    updateTaskStatus(task1.id, "done");
    updateTaskStatus(task2.id, "done");

    const costs = getPerTaskCosts(10);
    expect(costs.length).toBeGreaterThan(0);
  });
});

describe("estimateQueueCost", () => {
  it("estimates cost for pending tasks", () => {
    // Add some completed tasks with costs
    const done1 = addTask({ title: "Done 1" });
    recordAttempt({ taskId: done1.id, attemptNumber: 1, cli: "claude", costUsd: 0.50, tokensUsed: 5000 });
    updateTaskStatus(done1.id, "done");

    // Add pending tasks
    addTask({ title: "Pending 1" });
    addTask({ title: "Pending 2" });

    const estimate = estimateQueueCost();
    expect(estimate.pendingCount).toBe(2);
    expect(estimate.avgCostPerTask).toBeCloseTo(0.50);
    expect(estimate.estimatedCost).toBeCloseTo(1.00);
  });

  it("uses default estimate when no completed tasks", () => {
    addTask({ title: "Pending" });
    const estimate = estimateQueueCost();
    expect(estimate.pendingCount).toBe(1);
    expect(estimate.avgCostPerTask).toBe(0.5); // Default
  });
});

describe("getQueueStats", () => {
  it("returns correct stats", () => {
    addTask({ title: "Pending 1" });
    addTask({ title: "Pending 2" });
    const done = addTask({ title: "Done" });
    const failed = addTask({ title: "Failed" });
    updateTaskStatus(done.id, "done");
    updateTaskStatus(failed.id, "failed");

    const stats = getQueueStats();
    expect(stats.pending).toBe(2);
    expect(stats.done).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.total).toBe(4);
  });
});

describe("dependency graph", () => {
  it("builds dependency graph", () => {
    const task1 = addTask({ title: "Base task" });
    addTask({ title: "Dependent", dependsOn: [task1.id] });

    const graph = getDependencyGraph();
    expect(graph.size).toBe(2);

    const baseEntry = graph.get(task1.id)!;
    expect(baseEntry.blocks.length).toBe(1);
  });

  it("renders dependency tree", () => {
    const task1 = addTask({ title: "Root" });
    const task2 = addTask({ title: "Child", dependsOn: [task1.id] });

    const tasks = [task1, getTask(task2.id)!];
    const tree = renderDependencyTree(tasks);
    expect(tree).toContain("Root");
    expect(tree).toContain("Child");
  });
});
