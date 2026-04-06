import { execSync, execFileSync } from "node:child_process";

export function pushBranch(cwd: string, branchName: string): void {
  execSync(`git push -u origin "${branchName}"`, { cwd, stdio: "pipe" });
}

export function createDraftPR(
  cwd: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
  labels: string[] = []
): string {
  // Use execFileSync to avoid shell interpretation of body content
  // (backticks, $(), parentheses in PR body were being executed by /bin/sh)
  const args = [
    "pr", "create",
    "--base", baseBranch,
    "--head", branchName,
    "--title", title,
    "--body", body,
    "--draft",
  ];

  const url = execFileSync("gh", args, { cwd, encoding: "utf-8" }).trim();

  // Try to add labels (ignore failure — labels may not exist)
  if (labels.length > 0) {
    try {
      execFileSync("gh", ["pr", "edit", url, "--add-label", labels.join(",")], {
        cwd,
        stdio: "pipe",
      });
    } catch {
      // Labels don't exist on this repo — that's fine
    }
  }

  return url;
}

export function closePR(cwd: string, prUrl: string): void {
  try {
    execFileSync("gh", ["pr", "close", prUrl], { cwd, stdio: "pipe" });
  } catch {
    // ignore if already closed
  }
}
