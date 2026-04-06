import type { BurnConfig } from "../config/schema.js";
import { loadUserPreferences, mergePreferencesIntoPrompt } from "../config/preferences.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { monitorProcess } from "../monitor/output-parser.js";
import { addTask, type AddTaskInput } from "../core/task-queue.js";
import { getDb } from "../db/client.js";

export interface BrainstormSuggestion {
  title: string;
  description: string;
  type: string;
  priority: number;
  estimatedComplexity: string;
  targetFiles?: string[];
}

const BRAINSTORM_CATEGORIES = [
  {
    name: "tests",
    prompt:
      "Find functions, modules, or code paths that lack test coverage. Suggest specific test cases including edge cases, error paths, and boundary conditions.",
  },
  {
    name: "docs",
    prompt:
      "Find exported functions/classes missing documentation, outdated README sections, or undocumented APIs. Also look for misleading comments that don't match the code.",
  },
  {
    name: "security",
    prompt:
      "Find potential security issues: hardcoded secrets, injection risks (SQL, command, path traversal), missing input validation, unsafe deserialization, timing attacks, outdated deps with known CVEs.",
  },
  {
    name: "performance",
    prompt:
      "Find performance bottlenecks: N+1 queries, unnecessary re-renders, missing memoization, large bundle imports, missing indexes, synchronous I/O in hot paths, memory leaks.",
  },
  {
    name: "code-quality",
    prompt:
      "Find code smells: long functions (>50 lines), duplicated code, high cyclomatic complexity, dead code, inconsistent naming, god objects, feature envy.",
  },
  {
    name: "error-handling",
    prompt:
      "Find missing error handling: unhandled promise rejections, bare catch blocks, missing error boundaries, missing retry logic, swallowed errors, missing finally blocks for cleanup.",
  },
  {
    name: "type-safety",
    prompt:
      'Find type safety issues: `any` types, missing null checks, unsafe type assertions, implicit `any` parameters, missing return types on public APIs.',
  },
  {
    name: "reliability",
    prompt:
      "Find reliability issues: race conditions, missing locks, unhandled edge cases in parsing, missing timeouts on network calls, missing graceful shutdown, resource leaks (file handles, connections, listeners).",
  },
  {
    name: "ux",
    prompt:
      "Find user experience issues: misleading error messages, missing progress indicators, silent failures, confusing CLI flags, missing --help text, inconsistent output formats.",
  },
  {
    name: "architecture",
    prompt:
      "Find architectural issues: circular dependencies, god modules that do too much, missing abstractions, tight coupling between modules, config scattered across files, missing dependency injection.",
  },
];

export class BrainstormGenerator {
  private lastCategory = -1;
  private lastRunAt = 0;

  constructor(
    private config: BurnConfig,
    private registry: AdapterRegistry,
    private projectRoot: string
  ) {}

  canRun(): boolean {
    if (!this.config.brainstorm.enabled) return false;
    const elapsed = Date.now() - this.lastRunAt;
    return elapsed >= this.config.brainstorm.intervalMinutes * 60 * 1000;
  }

  async run(): Promise<BrainstormSuggestion[]> {
    this.lastRunAt = Date.now();

    const adapter = await this.registry.selectAdapter();
    if (!adapter) return [];

    // Rotate category
    const focusAreas = this.config.brainstorm.focusAreas;
    const categories = BRAINSTORM_CATEGORIES.filter((c) =>
      focusAreas.includes(c.name)
    );
    if (categories.length === 0) return [];

    this.lastCategory = (this.lastCategory + 1) % categories.length;
    const category = categories[this.lastCategory];

    const prompt = this.buildPrompt(
      category,
      this.config.brainstorm.ignoreAreas,
      this.config.brainstorm.maxSuggestionsPerRun
    );

    const cliProcess = adapter.execute({
      prompt,
      cwd: this.projectRoot,
      model: this.config.brainstorm.model,
      budgetUsd: 2, // Keep brainstorming cheap
    });

    let output = "";
    const result = await monitorProcess(
      cliProcess.process,
      (event) => {
        if (event.message) output += event.message;
        if (event.result) output += event.result;
      },
      undefined,
      300_000 // 5 minute timeout
    );

    for (const event of result.events) {
      if (event.type === "completion" && event.result) {
        output += event.result;
      }
    }

    const suggestions = parseSuggestions(output);

    if (suggestions.length === 0) {
      // Log what we got for debugging
      const preview = output.trim().slice(0, 200);
      console.error(`[brainstorm] No suggestions parsed from ${output.length} chars of output: ${preview}...`);
      return [];
    }

    const deduped = await this.deduplicate(suggestions);

    if (deduped.length === 0 && suggestions.length > 0) {
      console.error(`[brainstorm] ${suggestions.length} suggestions all deduplicated. Clearing old history to allow fresh ideas.`);
      // Clear old history so brainstorm can generate new ideas
      const db = getDb();
      db.prepare("DELETE FROM brainstorm_history WHERE created_at < datetime('now', '-1 hour')").run();
      // Retry dedup with cleared history
      const retried = await this.deduplicate(suggestions);
      if (retried.length > 0) {
        for (const s of retried) {
          this.recordSuggestion(s, category.name);
        }
        for (const s of retried) {
          if (this.shouldAutoApprove(s)) {
            addTask({
              title: s.title,
              description: s.description,
              type: s.type,
              priority: s.priority,
              estimatedComplexity: s.estimatedComplexity,
              targetFiles: s.targetFiles,
              source: "brainstorm",
            } as AddTaskInput);
          }
        }
        return retried;
      }
    }

    // Store in history
    for (const s of deduped) {
      this.recordSuggestion(s, category.name);
    }

    // Auto-approve eligible suggestions
    for (const s of deduped) {
      if (this.shouldAutoApprove(s)) {
        addTask({
          title: s.title,
          description: s.description,
          type: s.type,
          priority: s.priority,
          estimatedComplexity: s.estimatedComplexity,
          targetFiles: s.targetFiles,
          source: "brainstorm",
        } as AddTaskInput);
      }
    }

    return deduped;
  }

  private shouldAutoApprove(suggestion: BrainstormSuggestion): boolean {
    const rules = this.config.brainstorm.autoApprove;
    for (const rule of rules) {
      if (rule.type !== suggestion.type) continue;
      if (
        rule.maxComplexity &&
        !isComplexityWithin(suggestion.estimatedComplexity, rule.maxComplexity)
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  private async deduplicate(
    suggestions: BrainstormSuggestion[]
  ): Promise<BrainstormSuggestion[]> {
    const db = getDb();

    // Check brainstorm history
    const history = db
      .prepare(
        "SELECT title FROM brainstorm_history WHERE status IN ('suggested', 'approved', 'rejected')"
      )
      .all() as { title: string }[];

    // Check existing tasks (pending, executing, reviewing, done)
    const existingTasks = db
      .prepare("SELECT title FROM tasks WHERE status NOT IN ('cancelled', 'failed')")
      .all() as { title: string }[];

    // Check existing burn branches (remote) to avoid duplicating work already pushed
    let existingBranches: string[] = [];
    try {
      const { execSync } = await import("node:child_process");
      const branches = execSync("git branch -r", {
        cwd: this.projectRoot,
        encoding: "utf-8",
        timeout: 5000,
      });
      existingBranches = branches
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b.includes("burn/"));
    } catch {
      // ignore
    }

    const existingTitles = new Set([
      ...history.map((h) => h.title.toLowerCase()),
      ...existingTasks.map((t) => t.title.toLowerCase()),
    ]);

    // Also build a set of slugified branch keywords for fuzzy matching
    const branchKeywords = new Set(
      existingBranches.map((b) => {
        // extract the slug part: burn/type/id/slug → slug
        const parts = b.split("/");
        return parts.slice(4).join("-").toLowerCase();
      }).filter(Boolean)
    );

    return suggestions.filter((s) => {
      const titleLower = s.title.toLowerCase();
      // Exact title match
      if (existingTitles.has(titleLower)) return false;
      // Fuzzy: check if the slug of the title matches an existing branch
      const slug = titleLower.replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      if (branchKeywords.has(slug)) return false;
      return true;
    });
  }

  private buildPrompt(
    category: { name: string; prompt: string },
    ignoreAreas: string[],
    maxSuggestions: number
  ): string {
    const userPrefs = loadUserPreferences();
    const prefsContext = mergePreferencesIntoPrompt(userPrefs);
    const prefsSection = prefsContext
      ? `\n## User Preferences\n${prefsContext}\nSuggestions should align with these preferences.\n`
      : "";

    // Gather what's already been done/attempted — tell Claude so it suggests NEW things
    const db = getDb();
    const doneTasks = db
      .prepare("SELECT title, type FROM tasks WHERE status IN ('done', 'reviewing', 'executing', 'pending') ORDER BY created_at DESC LIMIT 30")
      .all() as { title: string; type: string }[];

    const alreadyDoneSection = doneTasks.length > 0
      ? `\n## Already Done or In Progress (DO NOT suggest these again)\n${doneTasks.map(t => `- [${t.type}] ${t.title}`).join("\n")}\n\nSuggest DIFFERENT improvements that are NOT in the list above.\n`
      : "";

    return `You are analyzing this codebase to suggest improvements.
Do NOT make any changes. Only analyze and suggest.

## Focus Area: ${category.name}
${category.prompt}
${prefsSection}${alreadyDoneSection}
## Ignore
${ignoreAreas.map((a) => `- ${a}`).join("\n")}

## Output Format
Respond with a JSON array of suggestions (max ${maxSuggestions}):
\`\`\`json
[
  {
    "title": "Short descriptive title",
    "description": "Detailed description of what to do and why",
    "type": "test|docs|security|performance|refactor|bug|chore",
    "priority": 3,
    "estimatedComplexity": "trivial|small|medium|large",
    "targetFiles": ["path/to/file.ts"]
  }
]
\`\`\`

Be specific and actionable. Each suggestion should be a standalone task that an AI coding agent can execute. Look DEEPER than surface-level issues — find subtle bugs, architectural problems, and non-obvious improvements.`;
  }

  private recordSuggestion(
    suggestion: BrainstormSuggestion,
    category: string
  ): void {
    const db = getDb();
    db.prepare(
      "INSERT INTO brainstorm_history (title, description, type, category) VALUES (?, ?, ?, ?)"
    ).run(
      suggestion.title,
      suggestion.description,
      suggestion.type,
      category
    );
  }
}

function parseSuggestions(output: string): BrainstormSuggestion[] {
  try {
    const jsonMatch = output.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (s: any) => s.title && s.description && s.type
          )
          .map((s: any) => ({
            title: String(s.title),
            description: String(s.description),
            type: String(s.type),
            priority: Math.min(5, Math.max(1, Number(s.priority) || 3)),
            estimatedComplexity: s.estimatedComplexity ?? "medium",
            targetFiles: Array.isArray(s.targetFiles)
              ? s.targetFiles
              : undefined,
          }));
      }
    }
  } catch {
    // Parse failure
  }
  return [];
}

const COMPLEXITY_ORDER = ["trivial", "small", "medium", "large", "epic"];

function isComplexityWithin(actual: string, max: string): boolean {
  const actualIdx = COMPLEXITY_ORDER.indexOf(actual);
  const maxIdx = COMPLEXITY_ORDER.indexOf(max);
  if (actualIdx === -1 || maxIdx === -1) return false;
  return actualIdx <= maxIdx;
}
