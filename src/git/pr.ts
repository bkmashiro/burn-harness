import { execSync } from "node:child_process";

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
  // Create PR without labels first (labels may not exist on repo)
  const cmd = [
    "gh pr create",
    `--base "${baseBranch}"`,
    `--head "${branchName}"`,
    `--title ${JSON.stringify(title)}`,
    `--body ${JSON.stringify(body)}`,
    "--draft",
  ].join(" ");

  const url = execSync(cmd, { cwd, encoding: "utf-8" }).trim();

  // Try to add labels (ignore failure — labels may not exist)
  if (labels.length > 0) {
    try {
      execSync(`gh pr edit "${url}" --add-label "${labels.join(",")}"`, {
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
    execSync(`gh pr close "${prUrl}"`, { cwd, stdio: "pipe" });
  } catch {
    // ignore if already closed
  }
}
