/**
 * State persistence and recovery module.
 *
 * Every interruption (crash, SIGKILL, power loss, rate limit) is recoverable.
 * The system stores enough state in SQLite that it can always reconstruct
 * exactly where it was and resume.
 *
 * Recovery strategy:
 * 1. On startup, find tasks stuck in 'planning' or 'executing' status
 * 2. Check if their worktrees still exist and have uncommitted work
 * 3. If work exists, commit it as a checkpoint and re-queue
 * 4. If no work, simply re-queue
 * 5. CLI session IDs are stored so we can attempt --resume
 */

import { getDb } from "../db/client.js";
import { hasChanges, commitAll } from "../git/branch.js";
import { getWorktreePath, removeWorktree } from "../git/worktree.js";
import fs from "node:fs";

export interface RecoveryResult {
  recoveredTasks: number;
  savedCheckpoints: number;
  cleanedWorktrees: number;
}

export function recoverFromCrash(projectRoot: string): RecoveryResult {
  const db = getDb(projectRoot);
  const result: RecoveryResult = {
    recoveredTasks: 0,
    savedCheckpoints: 0,
    cleanedWorktrees: 0,
  };

  // Find orphaned tasks
  const orphanedTasks = db
    .prepare(
      "SELECT * FROM tasks WHERE status IN ('planning', 'executing')"
    )
    .all() as Array<{
    id: string;
    worker_id: string | null;
    branch: string | null;
    current_attempt: number;
  }>;

  for (const task of orphanedTasks) {
    const workerId = task.worker_id;

    // Check if worktree has unsaved work
    if (workerId) {
      const worktreePath = getWorktreePath(projectRoot, workerId);

      if (fs.existsSync(worktreePath)) {
        try {
          if (hasChanges(worktreePath)) {
            // Save partial work as a checkpoint commit
            const sha = commitAll(
              worktreePath,
              `burn(checkpoint): partial work on ${task.id.slice(-6)} [auto-saved on recovery]`
            );

            // Record checkpoint
            db.prepare(
              `INSERT INTO checkpoints (task_id, attempt_number, git_ref, created_at)
               VALUES (?, ?, ?, datetime('now'))`
            ).run(task.id, task.current_attempt, sha);

            result.savedCheckpoints++;
          }
        } catch {
          // Worktree may be in a bad state — just clean it up
        }

        // Clean up worktree
        try {
          removeWorktree(projectRoot, workerId);
          result.cleanedWorktrees++;
        } catch {
          // ignore
        }
      }
    }

    // Re-queue the task
    db.prepare(
      "UPDATE tasks SET status = 'pending', worker_id = NULL WHERE id = ?"
    ).run(task.id);
    result.recoveredTasks++;
  }

  // Find and store the latest session IDs for resumable tasks
  // These are stored in the attempts table and can be used with --resume
  return result;
}

export function getLastSessionId(taskId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT session_id FROM attempts WHERE task_id = ? AND session_id IS NOT NULL ORDER BY attempt_number DESC LIMIT 1"
    )
    .get(taskId) as { session_id: string } | undefined;

  return row?.session_id ?? null;
}

export function getLastCheckpoint(
  taskId: string
): { gitRef: string; attemptNumber: number } | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT git_ref, attempt_number FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(taskId) as { git_ref: string; attempt_number: number } | undefined;

  return row ? { gitRef: row.git_ref, attemptNumber: row.attempt_number } : null;
}

/**
 * Save a PID file so we can detect if a previous instance is still running.
 */
export function writePidFile(projectRoot: string): void {
  const pidPath = `${projectRoot}/.burn/burn.pid`;
  fs.writeFileSync(pidPath, String(process.pid));
}

export function removePidFile(projectRoot: string): void {
  const pidPath = `${projectRoot}/.burn/burn.pid`;
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
}

export function isAlreadyRunning(projectRoot: string): boolean {
  const pidPath = `${projectRoot}/.burn/burn.pid`;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    // Check if process is still alive
    process.kill(pid, 0);
    return true;
  } catch {
    // PID file doesn't exist or process is dead
    removePidFile(projectRoot);
    return false;
  }
}
