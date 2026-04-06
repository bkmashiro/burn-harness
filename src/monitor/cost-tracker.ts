import { getDailyCost, getTotalCost, recordCost } from "../core/task-queue.js";
import type { BurnConfig } from "../config/schema.js";

export class CostTracker {
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

  isDailyBudgetExceeded(): boolean {
    return getDailyCost() >= this.config.safety.maxBudgetPerDayUsd;
  }

  isTotalBudgetExceeded(): boolean {
    return getTotalCost() >= this.config.safety.maxBudgetTotalUsd;
  }

  isTaskBudgetExceeded(taskCostSoFar: number, taskBudget?: number | null): boolean {
    const limit = taskBudget ?? this.config.safety.maxBudgetPerTaskUsd;
    return taskCostSoFar >= limit;
  }

  getDailyCost(): number {
    return getDailyCost();
  }

  getTotalCost(): number {
    return getTotalCost();
  }

  getRemainingDailyBudget(): number {
    return Math.max(0, this.config.safety.maxBudgetPerDayUsd - getDailyCost());
  }
}
