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
      "Find functions, modules, or code paths that lack test coverage. Suggest specific test cases to add.",
  },
  {
    name: "docs",
    prompt:
      "Find exported functions/classes missing documentation, outdated README sections, or undocumented APIs.",
  },
  {
    name: "security",
    prompt:
      "Find potential security issues: hardcoded secrets, injection risks, missing input validation, outdated deps with known CVEs.",
  },
  {
    name: "performance",
    prompt:
      "Find performance bottlenecks: N+1 queries, unnecessary re-renders, missing memoization, large bundle imports, missing indexes.",
  },
  {
    name: "code-quality",
    prompt:
      "Find code smells: long functions (>50 lines), duplicated code, high cyclomatic complexity, dead code, inconsistent naming.",
  },
  {
    name: "error-handling",
    prompt:
      "Find missing error handling: unhandled promise rejections, bare catch blocks, missing error boundaries, missing retry logic.",
  },
  {
    name: "type-safety",
    prompt:
      'Find type safety issues: `any` types, missing null checks, unsafe type assertions, implicit `any` parameters.',
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

    const prompt = buildBrainstormPrompt(
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
    const deduped = await this.deduplicate(suggestions);

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
    const history = db
      .prepare(
        "SELECT title FROM brainstorm_history WHERE status IN ('suggested', 'approved', 'rejected')"
      )
      .all() as { title: string }[];

    const existingTitles = new Set(
      history.map((h) => h.title.toLowerCase())
    );

    return suggestions.filter(
      (s) => !existingTitles.has(s.title.toLowerCase())
    );
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

function buildBrainstormPrompt(
  category: { name: string; prompt: string },
  ignoreAreas: string[],
  maxSuggestions: number
): string {
  // Include global user preferences in brainstorm context
  const userPrefs = loadUserPreferences();
  const prefsContext = mergePreferencesIntoPrompt(userPrefs);
  const prefsSection = prefsContext
    ? `\n## User Preferences\n${prefsContext}\nSuggestions should align with these preferences.\n`
    : "";

  return `You are analyzing this codebase to suggest improvements.
Do NOT make any changes. Only analyze and suggest.

## Focus Area: ${category.name}
${category.prompt}
${prefsSection}
## Ignore
${ignoreAreas.map((a) => `- ${a}`).join("\n")}

## Output Format
Respond with a JSON array of suggestions (max ${maxSuggestions}):
\`\`\`json
[
  {
    "title": "Short descriptive title",
    "description": "Detailed description of what to do and why",
    "type": "test|docs|security|performance|refactor|chore",
    "priority": 3,
    "estimatedComplexity": "trivial|small|medium|large",
    "targetFiles": ["path/to/file.ts"]
  }
]
\`\`\`

Be specific and actionable. Each suggestion should be a standalone task that an AI coding agent can execute.`;
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
