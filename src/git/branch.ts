import { execSync } from "node:child_process";

export function makeBranchName(
  prefix: string,
  type: string,
  taskId: string,
  title: string
): string {
  const shortId = taskId.slice(-6).toLowerCase();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  return `${prefix}/${type}/${shortId}/${slug}`;
}

export function branchExists(
  cwd: string,
  branchName: string
): boolean {
  try {
    execSync(`git rev-parse --verify "${branchName}"`, {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function getCurrentBranch(cwd: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd,
    encoding: "utf-8",
  }).trim();
}

export function getHeadSha(cwd: string): string {
  return execSync("git rev-parse HEAD", {
    cwd,
    encoding: "utf-8",
  }).trim();
}

export function hasChanges(cwd: string): boolean {
  const status = execSync("git status --porcelain", {
    cwd,
    encoding: "utf-8",
  }).trim();
  return status.length > 0;
}

export function commitAll(cwd: string, message: string): string {
  execSync("git add -A", { cwd, stdio: "pipe" });

  const status = execSync("git status --porcelain", {
    cwd,
    encoding: "utf-8",
  }).trim();

  if (!status) return getHeadSha(cwd);

  execSync(`git commit -m ${JSON.stringify(message)}`, {
    cwd,
    stdio: "pipe",
  });

  return getHeadSha(cwd);
}

export function getDiffStat(cwd: string, baseBranch: string): string {
  try {
    return execSync(`git diff --stat "${baseBranch}"...HEAD`, {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

export function deleteBranch(cwd: string, branchName: string): void {
  try {
    execSync(`git branch -D "${branchName}"`, { cwd, stdio: "pipe" });
  } catch {
    // ignore
  }
}
