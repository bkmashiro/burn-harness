import { ulid } from "ulid";
import { getDb } from "../db/client.js";

export interface Task {
  id: string;
  title: string;
  description: string;
  type: string;
  priority: number;
  estimated_complexity: string;
  depends_on: string;
  tags: string;
  status: string;
  source: string;
  target_files: string | null;
  branch: string | null;
  pr_url: string | null;
  max_attempts: number;
  current_attempt: number;
  total_tokens_used: number;
  estimated_cost_usd: number;
  budget_limit_usd: number | null;
  worker_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AddTaskInput {
  title: string;
  description?: string;
  type?: string;
  priority?: number;
  estimatedComplexity?: string;
  dependsOn?: string[];
  tags?: string[];
  source?: string;
  targetFiles?: string[];
  budgetLimitUsd?: number;
  maxAttempts?: number;
}

export function addTask(input: AddTaskInput): Task {
  const db = getDb();
  const id = ulid();

  const stmt = db.prepare(`
    INSERT INTO tasks (id, title, description, type, priority, estimated_complexity, depends_on, tags, source, target_files, budget_limit_usd, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.title,
    input.description ?? input.title,
    input.type ?? "chore",
    input.priority ?? 3,
    input.estimatedComplexity ?? "medium",
    JSON.stringify(input.dependsOn ?? []),
    JSON.stringify(input.tags ?? []),
    input.source ?? "user",
    input.targetFiles ? JSON.stringify(input.targetFiles) : null,
    input.budgetLimitUsd ?? null,
    input.maxAttempts ?? 3
  );

  return getTask(id)!;
}

export function getTask(id: string): Task | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Task
    | undefined;
}

export function listTasks(filter?: {
  status?: string;
  type?: string;
  source?: string;
}): Task[] {
  const db = getDb();
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params: string[] = [];

  if (filter?.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  if (filter?.type) {
    sql += " AND type = ?";
    params.push(filter.type);
  }
  if (filter?.source) {
    sql += " AND source = ?";
    params.push(filter.source);
  }

  sql += " ORDER BY priority ASC, created_at ASC";
  return db.prepare(sql).all(...params) as Task[];
}

export function claimNextTask(workerId: string): Task | undefined {
  const db = getDb();

  const task = db
    .prepare(
      `
    UPDATE tasks
    SET status = 'planning',
        worker_id = ?,
        started_at = datetime('now'),
        current_attempt = current_attempt + 1
    WHERE id = (
      SELECT t.id FROM tasks t
      WHERE t.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(t.depends_on) dep
          JOIN tasks t2 ON t2.id = dep.value
          WHERE t2.status != 'done'
        )
      ORDER BY t.priority ASC, t.created_at ASC
      LIMIT 1
    )
    RETURNING *
  `
    )
    .get(workerId) as Task | undefined;

  return task;
}

export function updateTaskStatus(
  id: string,
  status: string,
  extra?: Record<string, unknown>
): void {
  const db = getDb();
  let sql = `UPDATE tasks SET status = ?`;
  const params: unknown[] = [status];

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      sql += `, ${key} = ?`;
      params.push(value);
    }
  }

  if (status === "done" || status === "failed" || status === "cancelled") {
    sql += ", completed_at = datetime('now')";
  }

  sql += " WHERE id = ?";
  params.push(id);

  db.prepare(sql).run(...params);
}

export function recordAttempt(input: {
  taskId: string;
  attemptNumber: number;
  cli: string;
  model?: string;
  exitCode?: number;
  tokensUsed?: number;
  costUsd?: number;
  failureReason?: string;
  logFile?: string;
  diffStat?: string;
  sessionId?: string;
}): void {
  const db = getDb();

  db.prepare(
    `
    INSERT INTO attempts (task_id, attempt_number, cli, model, exit_code, tokens_used, cost_usd, failure_reason, log_file, diff_stat, session_id, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `
  ).run(
    input.taskId,
    input.attemptNumber,
    input.cli,
    input.model ?? null,
    input.exitCode ?? null,
    input.tokensUsed ?? 0,
    input.costUsd ?? 0,
    input.failureReason ?? null,
    input.logFile ?? null,
    input.diffStat ?? null,
    input.sessionId ?? null
  );

  // Update task totals
  if (input.tokensUsed || input.costUsd) {
    db.prepare(
      `
      UPDATE tasks
      SET total_tokens_used = total_tokens_used + ?,
          estimated_cost_usd = estimated_cost_usd + ?
      WHERE id = ?
    `
    ).run(input.tokensUsed ?? 0, input.costUsd ?? 0, input.taskId);
  }
}

export function recordCost(input: {
  taskId: string;
  cli: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}): void {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];

  db.prepare(
    `
    INSERT INTO cost_tracking (date, task_id, cli, model, tokens_in, tokens_out, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    today,
    input.taskId,
    input.cli,
    input.model ?? null,
    input.tokensIn,
    input.tokensOut,
    input.costUsd
  );
}

export function getDailyCost(): number {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_tracking WHERE date = ?")
    .get(today) as { total: number };
  return row.total;
}

export function getTotalCost(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_tracking")
    .get() as { total: number };
  return row.total;
}

export function getDailyTokens(): number {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const row = db
    .prepare("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as total FROM cost_tracking WHERE date = ?")
    .get(today) as { total: number };
  return row.total;
}

export function getTotalTokens(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as total FROM cost_tracking")
    .get() as { total: number };
  return row.total;
}

export function getTaskTokens(taskId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COALESCE(SUM(tokens_used), 0) as total FROM attempts WHERE task_id = ?")
    .get(taskId) as { total: number };
  return row.total;
}

export function getDailyCostByType(type: string): number {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ct.cost_usd), 0) as total
       FROM cost_tracking ct
       JOIN tasks t ON ct.task_id = t.id
       WHERE ct.date = ? AND t.type = ?`
    )
    .get(today, type) as { total: number };
  return row.total;
}

export function getQueueStats(): {
  pending: number;
  executing: number;
  done: number;
  failed: number;
  total: number;
} {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) as count FROM tasks GROUP BY status"
    )
    .all() as { status: string; count: number }[];

  const stats = { pending: 0, executing: 0, done: 0, failed: 0, total: 0 };
  for (const row of rows) {
    if (row.status === "pending" || row.status === "blocked") {
      stats.pending += row.count;
    } else if (
      row.status === "planning" ||
      row.status === "executing"
    ) {
      stats.executing += row.count;
    } else if (row.status === "done") {
      stats.done += row.count;
    } else if (row.status === "failed") {
      stats.failed += row.count;
    }
    stats.total += row.count;
  }
  return stats;
}
