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
  const labelArgs = labels.length
    ? `--label "${labels.join(",")}"`
    : "";

  const cmd = [
    "gh pr create",
    `--base "${baseBranch}"`,
    `--head "${branchName}"`,
    `--title ${JSON.stringify(title)}`,
    `--body ${JSON.stringify(body)}`,
    "--draft",
    labelArgs,
  ]
    .filter(Boolean)
    .join(" ");

  const url = execSync(cmd, { cwd, encoding: "utf-8" }).trim();
  return url;
}

export function closePR(cwd: string, prUrl: string): void {
  try {
    execSync(`gh pr close "${prUrl}"`, { cwd, stdio: "pipe" });
  } catch {
    // ignore if already closed
  }
}
