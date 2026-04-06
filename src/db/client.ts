import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;

export function getDb(projectRoot?: string): Database.Database {
  if (db) return db;

  const root = projectRoot ?? process.cwd();
  const burnDir = path.join(root, ".burn");
  fs.mkdirSync(burnDir, { recursive: true });
  fs.mkdirSync(path.join(burnDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(burnDir, "worktrees"), { recursive: true });

  const dbPath = path.join(burnDir, "burn.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r: any) => r.name)
  );

  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(
        migration.name
      );
    }
  }
}

const migrations = [
  {
    name: "001_initial",
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'chore',
        priority INTEGER NOT NULL DEFAULT 3,
        estimated_complexity TEXT NOT NULL DEFAULT 'medium',
        depends_on TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL DEFAULT 'user',
        target_files TEXT,
        branch TEXT,
        pr_url TEXT,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        current_attempt INTEGER NOT NULL DEFAULT 0,
        total_tokens_used INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        budget_limit_usd REAL,
        worker_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_priority ON tasks(priority);

      CREATE TABLE attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_number INTEGER NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        cli TEXT NOT NULL,
        model TEXT,
        exit_code INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        failure_reason TEXT,
        log_file TEXT,
        diff_stat TEXT,
        session_id TEXT
      );

      CREATE INDEX idx_attempts_task ON attempts(task_id);

      CREATE TABLE cost_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        cli TEXT NOT NULL,
        model TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_cost_date ON cost_tracking(date);

      CREATE TABLE brainstorm_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'suggested',
        category TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_number INTEGER NOT NULL,
        git_ref TEXT,
        files_modified TEXT NOT NULL DEFAULT '[]',
        tokens_so_far INTEGER NOT NULL DEFAULT 0,
        cost_so_far REAL NOT NULL DEFAULT 0,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
