import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export function createWorktree(
  projectRoot: string,
  workerId: string,
  branchName: string,
  baseBranch: string
): string {
  const worktreePath = path.join(
    projectRoot,
    ".burn",
    "worktrees",
    workerId
  );

  // Remove existing worktree if it exists
  if (fs.existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Force remove directory if git worktree remove fails
      fs.rmSync(worktreePath, { recursive: true, force: true });
      try {
        execSync("git worktree prune", { cwd: projectRoot, stdio: "pipe" });
      } catch {
        // ignore
      }
    }
  }

  // Create new worktree with a new branch
  execSync(
    `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
    { cwd: projectRoot, stdio: "pipe" }
  );

  return worktreePath;
}

export function removeWorktree(
  projectRoot: string,
  workerId: string
): void {
  const worktreePath = path.join(
    projectRoot,
    ".burn",
    "worktrees",
    workerId
  );

  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch {
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  try {
    execSync("git worktree prune", { cwd: projectRoot, stdio: "pipe" });
  } catch {
    // ignore
  }
}

export function getWorktreePath(
  projectRoot: string,
  workerId: string
): string {
  return path.join(projectRoot, ".burn", "worktrees", workerId);
}
