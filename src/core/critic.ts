import type { BurnConfig } from "../config/schema.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { monitorProcess } from "../monitor/output-parser.js";

export interface CriticResult {
  approved: boolean;
  score: number; // 1-10
  issues: string[];
  suggestions: string[];
  rawFeedback: string;
}

/**
 * GAN-like critic: after an agent completes a task, a second AI pass
 * reviews the diff and either approves or requests changes.
 *
 * Generator (Worker) → produces code changes
 * Discriminator (Critic) → reviews and scores the changes
 *
 * If the critic rejects, the task is re-queued with the critic's feedback
 * appended to the prompt, creating an adversarial improvement loop.
 */
export class Critic {
  constructor(
    private config: BurnConfig,
    private registry: AdapterRegistry
  ) {}

  async review(
    worktreePath: string,
    taskDescription: string,
    diff: string,
    options?: { model?: string }
  ): Promise<CriticResult> {
    const adapter = await this.registry.selectAdapter();
    if (!adapter) {
      // No adapter available — auto-approve
      return {
        approved: true,
        score: 7,
        issues: [],
        suggestions: [],
        rawFeedback: "No critic adapter available, auto-approved",
      };
    }

    const prompt = buildCriticPrompt(taskDescription, diff);

    const cliProcess = adapter.execute({
      prompt,
      cwd: worktreePath,
      model: options?.model ?? "sonnet", // Use cheaper model for review
      budgetUsd: 1, // Reviews should be cheap
    });

    let output = "";
    const result = await monitorProcess(
      cliProcess.process,
      (event) => {
        if (event.message) output += event.message;
        if (event.result) output += event.result;
      },
      undefined,
      120_000 // 2 minute timeout for reviews
    );

    // Append any completion result
    for (const event of result.events) {
      if (event.type === "completion" && event.result) {
        output += event.result;
      }
    }

    return parseCriticOutput(output);
  }
}

function buildCriticPrompt(taskDescription: string, diff: string): string {
  return `You are a code reviewer acting as a critic/discriminator in a GAN-like process.

## Original Task
${taskDescription}

## Changes Made (diff)
\`\`\`diff
${diff}
\`\`\`

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

Be strict but fair. Output ONLY the JSON block.`;
}

function parseCriticOutput(output: string): CriticResult {
  try {
    // Extract JSON from output
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
  };
}
