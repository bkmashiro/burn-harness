import {
  getDailyCost,
  getTotalCost,
  getDailyTokens,
  getTotalTokens,
  getTaskTokens,
  getDailyCostByType,
  recordCost,
} from "../core/task-queue.js";
import type { BurnConfig } from "../config/schema.js";

export interface BudgetStatus {
  /** Whether any hard limit has been hit */
  exceeded: boolean;
  /** Which limit was hit, if any */
  reason?: string;
  /** Whether we should pause (daily/session) vs stop (total) */
  action: "none" | "pause" | "stop";
  /** Human-readable summary */
  summary: string;
}

export class CostTracker {
  private sessionStartedAt = Date.now();
  private sessionRuntimeMs = 0; // Accumulated agent runtime in this session

  constructor(private config: BurnConfig) {}

  record(input: {
    taskId: string;
    cli: string;
    model?: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }): void {
    recordCost(input);
  }

  addRuntime(ms: number): void {
    this.sessionRuntimeMs += ms;
  }

  // ─── Composite budget check (called by worker before each task) ──────

  checkBudget(): BudgetStatus {
    // Check total limits first (most severe — stops permanently)
    const totalUsd = this.checkTotalUsd();
    if (totalUsd) return totalUsd;

    const totalTokens = this.checkTotalTokens();
    if (totalTokens) return totalTokens;

    // Check daily limits (pause until midnight)
    const dailyUsd = this.checkDailyUsd();
    if (dailyUsd) return dailyUsd;

    const dailyTokens = this.checkDailyTokens();
    if (dailyTokens) return dailyTokens;

    const dailyRuntime = this.checkDailyRuntime();
    if (dailyRuntime) return dailyRuntime;

    // Check session limit
    const sessionLimit = this.checkSessionRuntime();
    if (sessionLimit) return sessionLimit;

    return { exceeded: false, action: "none", summary: "OK" };
  }

  // ─── Per-task budget check ───────────────────────────────────────────

  checkTaskBudget(
    taskCostSoFar: number,
    taskTokensSoFar: number,
    taskRuntimeMs: number,
    taskBudgetUsd?: number | null,
    taskType?: string
  ): BudgetStatus {
    const safety = this.config.safety;

    // USD per-task limit
    if (safety.maxBudgetPerTaskUsd != null || taskBudgetUsd != null) {
      const limit = taskBudgetUsd ?? safety.maxBudgetPerTaskUsd!;
      if (taskCostSoFar >= limit) {
        return {
          exceeded: true,
          reason: "task-usd",
          action: "stop",
          summary: `Task cost $${taskCostSoFar.toFixed(2)} exceeds limit $${limit.toFixed(2)}`,
        };
      }
    }

    // Token per-task limit
    if (safety.maxTokensPerTask != null) {
      if (taskTokensSoFar >= safety.maxTokensPerTask) {
        return {
          exceeded: true,
          reason: "task-tokens",
          action: "stop",
          summary: `Task used ${taskTokensSoFar} tokens, limit is ${safety.maxTokensPerTask}`,
        };
      }
    }

    // Runtime per-task limit
    if (safety.maxRuntimePerTaskMinutes != null) {
      const limitMs = safety.maxRuntimePerTaskMinutes * 60_000;
      if (taskRuntimeMs >= limitMs) {
        return {
          exceeded: true,
          reason: "task-runtime",
          action: "stop",
          summary: `Task ran ${Math.round(taskRuntimeMs / 60_000)}m, limit is ${safety.maxRuntimePerTaskMinutes}m`,
        };
      }
    }

    // Budget allocation by type
    if (taskType && safety.budgetAllocation) {
      const allocation = safety.budgetAllocation[taskType as keyof typeof safety.budgetAllocation];
      if (allocation != null && safety.maxBudgetPerDayUsd != null) {
        const typeLimit = (allocation / 100) * safety.maxBudgetPerDayUsd;
        const typeSpent = getDailyCostByType(taskType);
        if (typeSpent >= typeLimit) {
          return {
            exceeded: true,
            reason: "type-allocation",
            action: "pause",
            summary: `${taskType} tasks used $${typeSpent.toFixed(2)} of $${typeLimit.toFixed(2)} daily allocation (${allocation}%)`,
          };
        }
      }
    }

    return { exceeded: false, action: "none", summary: "OK" };
  }

  // ─── Individual checks ──────────────────────────────────────────────

  private checkTotalUsd(): BudgetStatus | null {
    const limit = this.config.safety.maxBudgetTotalUsd;
    if (limit == null) return null;
    const spent = getTotalCost();
    if (spent >= limit) {
      return {
        exceeded: true,
        reason: "total-usd",
        action: "stop",
        summary: `Total spend $${spent.toFixed(2)} exceeds lifetime limit $${limit.toFixed(2)}`,
      };
    }
    return null;
  }

  private checkDailyUsd(): BudgetStatus | null {
    const limit = this.config.safety.maxBudgetPerDayUsd;
    if (limit == null) return null;
    const spent = getDailyCost();
    if (spent >= limit) {
      return {
        exceeded: true,
        reason: "daily-usd",
        action: "pause",
        summary: `Daily spend $${spent.toFixed(2)} exceeds limit $${limit.toFixed(2)}`,
      };
    }
    return null;
  }

  private checkTotalTokens(): BudgetStatus | null {
    const limit = this.config.safety.maxTokensTotal;
    if (limit == null) return null;
    const used = getTotalTokens();
    if (used >= limit) {
      return {
        exceeded: true,
        reason: "total-tokens",
        action: "stop",
        summary: `Total tokens ${used.toLocaleString()} exceeds limit ${limit.toLocaleString()}`,
      };
    }
    return null;
  }

  private checkDailyTokens(): BudgetStatus | null {
    const limit = this.config.safety.maxTokensPerDay;
    if (limit == null) return null;
    const used = getDailyTokens();
    if (used >= limit) {
      return {
        exceeded: true,
        reason: "daily-tokens",
        action: "pause",
        summary: `Daily tokens ${used.toLocaleString()} exceeds limit ${limit.toLocaleString()}`,
      };
    }
    return null;
  }

  private checkDailyRuntime(): BudgetStatus | null {
    const limit = this.config.safety.maxRuntimePerDayMinutes;
    if (limit == null) return null;
    // Use session runtime as a proxy (accurate within this session)
    const usedMs = this.sessionRuntimeMs;
    const limitMs = limit * 60_000;
    if (usedMs >= limitMs) {
      return {
        exceeded: true,
        reason: "daily-runtime",
        action: "pause",
        summary: `Daily runtime ${Math.round(usedMs / 60_000)}m exceeds limit ${limit}m`,
      };
    }
    return null;
  }

  private checkSessionRuntime(): BudgetStatus | null {
    const limit = this.config.safety.maxRuntimePerSessionHours;
    if (limit == null) return null;
    const elapsed = Date.now() - this.sessionStartedAt;
    const limitMs = limit * 3_600_000;
    if (elapsed >= limitMs) {
      return {
        exceeded: true,
        reason: "session-runtime",
        action: "stop",
        summary: `Session has been running ${(elapsed / 3_600_000).toFixed(1)}h, limit is ${limit}h`,
      };
    }
    return null;
  }

  // ─── Convenience getters ────────────────────────────────────────────

  getDailyCost(): number {
    return getDailyCost();
  }

  getTotalCost(): number {
    return getTotalCost();
  }

  getDailyTokens(): number {
    return getDailyTokens();
  }

  getTotalTokens(): number {
    return getTotalTokens();
  }

  getSessionRuntimeMinutes(): number {
    return Math.round(this.sessionRuntimeMs / 60_000);
  }

  getSessionElapsedHours(): number {
    return (Date.now() - this.sessionStartedAt) / 3_600_000;
  }

  getRemainingDailyBudget(): number | null {
    const limit = this.config.safety.maxBudgetPerDayUsd;
    if (limit == null) return null;
    return Math.max(0, limit - getDailyCost());
  }

  getRemainingDailyTokens(): number | null {
    const limit = this.config.safety.maxTokensPerDay;
    if (limit == null) return null;
    return Math.max(0, limit - getDailyTokens());
  }

  /**
   * Warn if token/cost limits are configured but the CLI doesn't report them.
   * Returns a warning string or null if everything is compatible.
   */
  checkAdapterCompatibility(adapterName: string, capabilities: { supportsTokenReporting: boolean; supportsCostReporting: boolean }): string | null {
    const warnings: string[] = [];
    const s = this.config.safety;

    if (!capabilities.supportsTokenReporting) {
      if (s.maxTokensPerTask != null || s.maxTokensPerDay != null || s.maxTokensTotal != null) {
        warnings.push(`${adapterName} doesn't report token usage — token limits will use runtime-based estimation`);
      }
    }

    if (!capabilities.supportsCostReporting) {
      if (s.maxBudgetPerTaskUsd != null || s.maxBudgetPerDayUsd != null || s.maxBudgetTotalUsd != null) {
        warnings.push(`${adapterName} doesn't report USD cost — cost limits will use runtime-based estimation`);
      }
    }

    return warnings.length > 0 ? warnings.join("; ") : null;
  }

  /** Get a human-readable summary of all active limits */
  getLimitsSummary(): string {
    const lines: string[] = [];
    const s = this.config.safety;

    if (s.maxBudgetPerTaskUsd != null) lines.push(`  Per-task:  $${s.maxBudgetPerTaskUsd}`);
    if (s.maxBudgetPerDayUsd != null) lines.push(`  Per-day:   $${s.maxBudgetPerDayUsd} (spent: $${getDailyCost().toFixed(2)})`);
    if (s.maxBudgetTotalUsd != null) lines.push(`  Total:     $${s.maxBudgetTotalUsd} (spent: $${getTotalCost().toFixed(2)})`);
    if (s.maxTokensPerTask != null) lines.push(`  Tokens/task: ${s.maxTokensPerTask.toLocaleString()}`);
    if (s.maxTokensPerDay != null) lines.push(`  Tokens/day:  ${s.maxTokensPerDay.toLocaleString()} (used: ${getDailyTokens().toLocaleString()})`);
    if (s.maxTokensTotal != null) lines.push(`  Tokens total: ${s.maxTokensTotal.toLocaleString()} (used: ${getTotalTokens().toLocaleString()})`);
    if (s.maxRuntimePerTaskMinutes != null) lines.push(`  Runtime/task: ${s.maxRuntimePerTaskMinutes}m`);
    if (s.maxRuntimePerDayMinutes != null) lines.push(`  Runtime/day:  ${s.maxRuntimePerDayMinutes}m (used: ${this.getSessionRuntimeMinutes()}m)`);
    if (s.maxRuntimePerSessionHours != null) lines.push(`  Session max:  ${s.maxRuntimePerSessionHours}h (elapsed: ${this.getSessionElapsedHours().toFixed(1)}h)`);

    if (s.budgetAllocation) {
      lines.push(`  Allocation:`);
      for (const [type, pct] of Object.entries(s.budgetAllocation)) {
        if (pct != null) {
          const spent = getDailyCostByType(type);
          const limit = s.maxBudgetPerDayUsd != null ? (pct / 100) * s.maxBudgetPerDayUsd : null;
          lines.push(`    ${type}: ${pct}%${limit != null ? ` ($${limit.toFixed(2)}, spent $${spent.toFixed(2)})` : ""}`);
        }
      }
    }

    if (lines.length === 0) {
      return "  No budget limits set — running with no caps.";
    }

    return lines.join("\n");
  }
}
