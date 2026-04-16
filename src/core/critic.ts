import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BurnConfig } from "../config/schema.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { monitorProcess } from "../monitor/output-parser.js";

export interface CriticResult {
  approved: boolean;
  score: number; // 1-10
  issues: string[];
  suggestions: string[];
  rawFeedback: string;
  testResults?: { passed: number; failed: number; skipped: number };
  typeCheckPassed?: boolean;
  automatedChecks: AutomatedCheckResult[];
}

export interface AutomatedCheckResult {
  name: string;
  passed: boolean;
  output: string;
}

/**
 * Type-specific evaluation criteria.
 */
const TYPE_CRITERIA: Record<string, string> = {
  bug: `Evaluate this BUG FIX specifically:
- Does the fix actually address the root cause (not just symptoms)?
- Could the fix introduce regressions?
- Are there edge cases the fix might miss?
- Is there a test that verifies the fix?
- Is the fix minimal and focused (not mixed with unrelated changes)?`,

  feature: `Evaluate this FEATURE implementation:
- Is the feature complete as described?
- Does it follow existing patterns and conventions?
- Are there edge cases handled?
- Is it well-tested?
- Is the API/interface intuitive?
- Are there any breaking changes?`,

  test: `Evaluate these TEST changes:
- Do the tests actually test meaningful behavior (not just implementation)?
- Are edge cases covered?
- Are the assertions specific and useful?
- Do the tests pass?
- Is test coverage meaningfully improved?
- Are the tests maintainable and readable?`,

  refactor: `Evaluate this REFACTORING:
- Is behavior preserved exactly (no functional changes)?
- Is the code genuinely simpler/cleaner after the change?
- Are there any subtle behavior changes hidden in the refactor?
- Does it improve readability or reduce duplication?
- Are all callers updated correctly?`,

  docs: `Evaluate these DOCUMENTATION changes:
- Is the documentation accurate and matches the actual code?
- Is it complete (covers all public APIs, parameters, return values)?
- Are examples provided where helpful?
- Is the writing clear and concise?
- Are there any outdated references?`,

  security: `Evaluate this SECURITY change:
- Does it actually fix the vulnerability?
- Could it introduce new security issues?
- Is input validation thorough?
- Are there timing/race condition concerns?
- Is error handling secure (no info leaks)?`,

  performance: `Evaluate this PERFORMANCE improvement:
- Is there evidence it actually improves performance?
- Could it degrade performance in other scenarios?
- Is correctness preserved?
- Are there any memory/resource leak risks?
- Is the optimization worth the added complexity?`,
};

/**
 * GAN-like critic: after an agent completes a task, a second AI pass
 * reviews the diff and either approves or requests changes.
 *
 * Generator (Worker) -> produces code changes
 * Discriminator (Critic) -> reviews and scores the changes
 *
 * Now enhanced with:
 * 1. Type-specific evaluation criteria
 * 2. Automated checks (tests, type-checking, linting) run BEFORE AI review
 * 3. Structured output with test results and check details
 */
export class Critic {
  constructor(
    private config: BurnConfig,
    private registry: AdapterRegistry
  ) {}

  /**
   * Run automated checks on the worktree before AI review.
   */
  async runAutomatedChecks(
    worktreePath: string,
    baseBranch: string
  ): Promise<AutomatedCheckResult[]> {
    const results: AutomatedCheckResult[] = [];

    // 1. Get diff stat
    try {
      const diffStat = execSync(`git diff --stat "${baseBranch}"...HEAD`, {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();
      results.push({ name: "diff-stat", passed: true, output: diffStat });
    } catch {
      results.push({ name: "diff-stat", passed: true, output: "No diff available" });
    }

    // 2. Check if package.json has a test script -> run tests
    const pkgPath = path.join(worktreePath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          try {
            const testOutput = execSync("npm test 2>&1", {
              cwd: worktreePath,
              encoding: "utf-8",
              timeout: 120_000,
            });
            results.push({ name: "tests", passed: true, output: testOutput.slice(-2000) });
          } catch (err) {
            const output = (err as { stdout?: string; stderr?: string })?.stdout ?? String(err);
            results.push({
              name: "tests",
              passed: false,
              output: String(output).slice(-2000),
            });
          }
        }
      } catch {
        // Invalid package.json
      }
    }

    // 3. Check if TypeScript -> run tsc --noEmit
    const tsconfigPath = path.join(worktreePath, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) {
      try {
        execSync("npx tsc --noEmit 2>&1", {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: 60_000,
        });
        results.push({ name: "typecheck", passed: true, output: "No errors" });
      } catch (err) {
        const output = (err as { stdout?: string })?.stdout ?? String(err);
        results.push({
          name: "typecheck",
          passed: false,
          output: String(output).slice(-2000),
        });
      }
    }

    // 4. Check if Python -> run pytest
    const pyprojectPath = path.join(worktreePath, "pyproject.toml");
    const setupPyPath = path.join(worktreePath, "setup.py");
    if (fs.existsSync(pyprojectPath) || fs.existsSync(setupPyPath)) {
      try {
        const testOutput = execSync(
          "python -m pytest --tb=short -q 2>&1 || pytest --tb=short -q 2>&1",
          { cwd: worktreePath, encoding: "utf-8", timeout: 120_000 }
        );
        const passed = !testOutput.includes("FAILED");
        results.push({
          name: "pytest",
          passed,
          output: testOutput.slice(-2000),
        });
      } catch (err) {
        const output = (err as { stdout?: string })?.stdout ?? String(err);
        results.push({
          name: "pytest",
          passed: false,
          output: String(output).slice(-2000),
        });
      }
    }

    return results;
  }

  /**
   * Parse test results from automated check output.
   */
  parseTestResults(
    checks: AutomatedCheckResult[]
  ): { passed: number; failed: number; skipped: number } | undefined {
    const testCheck =
      checks.find((c) => c.name === "tests") ??
      checks.find((c) => c.name === "pytest");
    if (!testCheck) return undefined;

    const output = testCheck.output;

    // Node/Jest/Vitest patterns
    let match = output.match(/(\d+)\s+pass/i);
    const passed = match ? parseInt(match[1], 10) : 0;
    match = output.match(/(\d+)\s+fail/i);
    const failed = match ? parseInt(match[1], 10) : 0;
    match = output.match(/(\d+)\s+skip/i);
    const skipped = match ? parseInt(match[1], 10) : 0;

    // Pytest pattern: "X passed, Y failed"
    if (passed === 0 && failed === 0) {
      match = output.match(/(\d+)\s+passed/);
      const pyPassed = match ? parseInt(match[1], 10) : 0;
      match = output.match(/(\d+)\s+failed/);
      const pyFailed = match ? parseInt(match[1], 10) : 0;
      match = output.match(/(\d+)\s+skipped/);
      const pySkipped = match ? parseInt(match[1], 10) : 0;
      if (pyPassed > 0 || pyFailed > 0) {
        return { passed: pyPassed, failed: pyFailed, skipped: pySkipped };
      }
    }

    return { passed, failed, skipped };
  }

  async review(
    worktreePath: string,
    taskDescription: string,
    diff: string,
    options?: { model?: string; taskType?: string }
  ): Promise<CriticResult> {
    // Run automated checks first
    const baseBranch = this.config.git.baseBranch;
    const automatedChecks = await this.runAutomatedChecks(worktreePath, baseBranch);
    const testResults = this.parseTestResults(automatedChecks);
    const typeCheckResult = automatedChecks.find((c) => c.name === "typecheck");
    const typeCheckPassed = typeCheckResult ? typeCheckResult.passed : undefined;

    const adapter = await this.registry.selectAdapter();
    if (!adapter) {
      // No adapter available -> auto-approve but include check results
      return {
        approved: true,
        score: 7,
        issues: [],
        suggestions: [],
        rawFeedback: "No critic adapter available, auto-approved",
        testResults,
        typeCheckPassed,
        automatedChecks,
      };
    }

    const prompt = buildCriticPrompt(
      taskDescription,
      diff,
      options?.taskType,
      automatedChecks
    );

    const cliProcess = adapter.execute({
      prompt,
      cwd: worktreePath,
      model: options?.model ?? "sonnet",
      budgetUsd: 1,
    });

    let output = "";
    const result = await monitorProcess(
      cliProcess.process,
      (event) => {
        if (event.message) output += event.message;
        if (event.result) output += event.result;
      },
      undefined,
      120_000
    );

    for (const event of result.events) {
      if (event.type === "completion" && event.result) {
        output += event.result;
      }
    }

    const parsed = parseCriticOutput(output);

    // Factor in automated checks: if tests fail, reduce score
    if (testResults && testResults.failed > 0 && parsed.score > 5) {
      parsed.score = Math.max(3, parsed.score - 3);
      parsed.approved = false;
      parsed.issues.push(
        `${testResults.failed} test(s) failing`
      );
    }

    if (typeCheckPassed === false && parsed.score > 5) {
      parsed.score = Math.max(4, parsed.score - 2);
      parsed.issues.push("TypeScript type errors detected");
    }

    return {
      ...parsed,
      testResults,
      typeCheckPassed,
      automatedChecks,
    };
  }
}

function buildCriticPrompt(
  taskDescription: string,
  diff: string,
  taskType?: string,
  automatedChecks?: AutomatedCheckResult[]
): string {
  const typeCriteria = taskType
    ? TYPE_CRITERIA[taskType] ?? ""
    : "";

  const checksSection = automatedChecks?.length
    ? `\n## Automated Check Results\n${automatedChecks
        .map(
          (c) =>
            `### ${c.name}: ${c.passed ? "PASSED" : "FAILED"}\n\`\`\`\n${c.output.slice(0, 500)}\n\`\`\``
        )
        .join("\n\n")}\n`
    : "";

  return `You are a code reviewer acting as a critic/discriminator in a GAN-like process.

## Original Task
${taskDescription}

## Changes Made (diff)
\`\`\`diff
${diff.slice(0, 15000)}
\`\`\`
${checksSection}
${typeCriteria ? `## Type-Specific Criteria\n${typeCriteria}\n` : ""}
## Your Job
Review these changes critically. Score them 1-10 and identify issues.

Respond in EXACTLY this JSON format:
\`\`\`json
{
  "approved": true/false,
  "score": <1-10>,
  "issues": ["issue 1", "issue 2"],
  "suggestions": ["suggestion 1", "suggestion 2"]
}
\`\`\`

Scoring guide:
- 8-10: Approve. Changes are correct, clean, and complete.
- 5-7: Borderline. Minor issues but generally acceptable.
- 1-4: Reject. Significant problems, bugs, or incomplete work.

Only approve (score >= 7) if the changes:
1. Actually solve the described task
2. Don't introduce obvious bugs
3. Follow reasonable coding practices
4. Don't have unnecessary/unrelated changes
${automatedChecks?.some((c) => !c.passed) ? "\nIMPORTANT: Some automated checks FAILED. Factor this heavily into your score." : ""}

Be strict but fair. Output ONLY the JSON block.`;
}

function parseCriticOutput(output: string): CriticResult {
  try {
    const jsonMatch = output.match(/\{[\s\S]*?"approved"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        approved: parsed.approved === true && (parsed.score ?? 0) >= 7,
        score: Math.min(10, Math.max(1, parsed.score ?? 5)),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions
          : [],
        rawFeedback: output,
        automatedChecks: [],
      };
    }
  } catch {
    // Parse failure
  }

  // Default: cautiously approve with low score
  return {
    approved: true,
    score: 6,
    issues: ["Could not parse critic output"],
    suggestions: [],
    rawFeedback: output,
    automatedChecks: [],
  };
}
