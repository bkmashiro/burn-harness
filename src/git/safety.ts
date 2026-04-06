import { minimatch } from "minimatch";

const FORBIDDEN_GIT_COMMANDS = [
  "push --force",
  "push -f ",
  "reset --hard",
  "clean -f",
];

const PROTECTED_BRANCHES = ["main", "master", "develop", "production"];

export function isForbiddenPath(
  filePath: string,
  forbiddenPaths: string[]
): boolean {
  for (const pattern of forbiddenPaths) {
    if (minimatch(filePath, pattern)) {
      return true;
    }
  }
  return false;
}

export function isProtectedBranch(branchName: string): boolean {
  return PROTECTED_BRANCHES.includes(branchName);
}

export function isForbiddenGitCommand(command: string): boolean {
  return FORBIDDEN_GIT_COMMANDS.some((forbidden) =>
    command.includes(forbidden)
  );
}

export function validateBranchForPush(branchName: string, prefix: string): boolean {
  // Only allow pushing branches that start with our prefix
  return branchName.startsWith(`${prefix}/`);
}
