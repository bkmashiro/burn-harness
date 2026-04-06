import type { BurnConfig } from "../config/schema.js";
import type { CLIAdapter, OutputEvent } from "../adapters/types.js";
import type { Task } from "./task-queue.js";
import {
  claimNextTask,
  updateTaskStatus,
  recordAttempt,
} from "./task-queue.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";
import {
  makeBranchName,
  hasChanges,
  commitAll,
  getDiffStat,
} from "../git/branch.js";
import { pushBranch, createDraftPR } from "../git/pr.js";
import { validateBranchForPush } from "../git/safety.js";
import { monitorProcess } from "../monitor/output-parser.js";
import { BackoffController, formatDuration } from "../monitor/rate-limit.js";
import { CostTracker } from "../monitor/cost-tracker.js";
import { createSessionLogger } from "../logging/logger.js";
import type { AdapterRegistry } from "../adapters/registry.js";

export interface WorkerState {
  id: string;
  status: "idle" | "working" | "rate-limited" | "stopped";
  currentTask: Task | null;
  lastError?: string;
}

export class Worker {
  private state: WorkerState;
  private stopped = false;
  private backoff = new BackoffController();
  private costTracker: CostTracker;
  private log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(
    private workerId: string,
    private projectRoot: string,
    private config: BurnConfig,
    private registry: AdapterRegistry,
    logger: { info: (obj: Record<string, unknown>, msg: string) => void }
  ) {
    this.state = {
      id: workerId,
      status: "idle",
      currentTask: null,
    };
    this.costTracker = new CostTracker(config);
    this.log = (msg, data) =>
      logger.info({ worker: workerId, ...data }, msg);
  }

  getState(): WorkerState {
    return { ...this.state };
  }

  stop(): void {
    this.stopped = true;
    this.state.status = "stopped";
  }

  async run(): Promise<void> {
    this.log("Worker started");

    while (!this.stopped) {
      try {
        // Check all budget limits (USD, tokens, time — only those configured)
        const budgetStatus = this.costTracker.checkBudget();
        if (budgetStatus.exceeded) {
          this.log("Budget limit hit", {
            reason: budgetStatus.reason,
            summary: budgetStatus.summary,
          });
          if (budgetStatus.action === "stop") {
            this.stop();
            break;
          }
          // action === "pause" — wait and re-check
          this.state.status = "rate-limited";
          await this.sleep(60_000);
          continue;
        }

        // Try to claim a task
        const task = claimNextTask(this.workerId);
        if (!task) {
          this.state.status = "idle";
          await this.sleep(this.config.execution.pollIntervalSeconds * 1000);
          continue;
        }

        this.state.currentTask = task;
        this.state.status = "working";
        this.backoff.reset();

        await this.executeTask(task);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log("Worker error", { error: message });
        this.state.lastError = message;
        await this.sleep(5000);
      }
    }

    this.log("Worker stopped");
  }

  private async executeTask(task: Task): Promise<void> {
    const taskStartTime = Date.now();
    this.log("Executing task", { taskId: task.id, title: task.title });

    // Select adapter
    const adapter = await this.registry.selectAdapter(task.type);
    if (!adapter) {
      this.log("No CLI adapter available", { taskId: task.id });
      updateTaskStatus(task.id, "pending", { worker_id: null });
      await this.sleep(30_000);
      return;
    }

    // Create branch and worktree
    const branchName = makeBranchName(
      this.config.git.branchPrefix,
      task.type,
      task.id,
      task.title
    );

    let worktreePath: string;
    try {
      worktreePath = createWorktree(
        this.projectRoot,
        this.workerId,
        branchName,
        this.config.git.baseBranch
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("Failed to create worktree", { error: message });
      updateTaskStatus(task.id, "failed", {
        worker_id: null,
      });
      recordAttempt({
        taskId: task.id,
        attemptNumber: task.current_attempt,
        cli: adapter.name,
        failureReason: `Worktree creation failed: ${message}`,
      });
      return;
    }

    updateTaskStatus(task.id, "executing", { branch: branchName });

    // Build prompt with context
    const prompt = this.buildPrompt(task);
    const sessionLog = createSessionLogger(
      this.projectRoot,
      task.id,
      task.current_attempt
    );

    let sessionId: string | undefined;

    try {
      // Invoke CLI
      const cliProcess = adapter.execute({
        prompt,
        cwd: worktreePath,
        model: this.getModelForAdapter(adapter.name),
        budgetUsd: task.budget_limit_usd ?? this.config.safety.maxBudgetPerTaskUsd ?? undefined,
        timeoutMs: this.config.execution.taskTimeoutMinutes * 60 * 1000,
        appendPrompt: this.config.preferences.style ?? undefined,
      });

      const result = await monitorProcess(
        cliProcess.process,
        (event: OutputEvent) => {
          // Log events
          const summary =
            event.type === "tool_use"
              ? `[${event.tool}] ${(event.input ?? "").slice(0, 100)}`
              : event.message ?? event.raw ?? "";
          sessionLog.write(`[${new Date().toISOString()}] ${event.type}: ${summary}\n`);
        },
        (id) => {
          sessionId = id;
        },
        this.config.execution.taskTimeoutMinutes * 60 * 1000
      );

      sessionLog.close();

      const taskRuntimeMs = Date.now() - taskStartTime;
      this.costTracker.addRuntime(taskRuntimeMs);

      // Record costs
      if (result.costUsd > 0) {
        this.costTracker.record({
          taskId: task.id,
          cli: adapter.name,
          model: this.getModelForAdapter(adapter.name),
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsd: result.costUsd,
        });
      }

      // Check per-task budget (tokens, runtime, type allocation)
      const taskBudget = this.costTracker.checkTaskBudget(
        result.costUsd + task.estimated_cost_usd,
        result.tokensIn + result.tokensOut + task.total_tokens_used,
        taskRuntimeMs,
        task.budget_limit_usd,
        task.type
      );
      if (taskBudget.exceeded) {
        this.log("Task budget exceeded", {
          taskId: task.id,
          reason: taskBudget.reason,
          summary: taskBudget.summary,
        });
        // Still save whatever work was done
      }

      // Handle result
      if (result.rateLimited) {
        await this.handleRateLimit(task, adapter, result.exitCode, sessionLog.logPath);
        return;
      }

      if (result.exitCode === -1) {
        // Timeout
        this.log("Task timed out", { taskId: task.id });
        recordAttempt({
          taskId: task.id,
          attemptNumber: task.current_attempt,
          cli: adapter.name,
          exitCode: -1,
          tokensUsed: result.tokensIn + result.tokensOut,
          costUsd: result.costUsd,
          failureReason: "Timeout",
          logFile: sessionLog.logPath,
          sessionId,
        });
        this.requeueOrFail(task);
        return;
      }

      if (result.exitCode !== 0) {
        // CLI failed
        this.log("CLI exited with error", {
          taskId: task.id,
          exitCode: result.exitCode,
        });
        recordAttempt({
          taskId: task.id,
          attemptNumber: task.current_attempt,
          cli: adapter.name,
          exitCode: result.exitCode,
          tokensUsed: result.tokensIn + result.tokensOut,
          costUsd: result.costUsd,
          failureReason: `Exit code ${result.exitCode}`,
          logFile: sessionLog.logPath,
          sessionId,
        });
        this.requeueOrFail(task);
        return;
      }

      // Success! Commit and create PR
      await this.handleSuccess(task, adapter.name, branchName, worktreePath, sessionLog.logPath, result, sessionId);
    } catch (err) {
      sessionLog.close();
      const message = err instanceof Error ? err.message : String(err);
      this.log("Task execution error", { taskId: task.id, error: message });
      recordAttempt({
        taskId: task.id,
        attemptNumber: task.current_attempt,
        cli: adapter.name,
        failureReason: message,
        logFile: sessionLog.logPath,
        sessionId,
      });
      this.requeueOrFail(task);
    } finally {
      this.state.currentTask = null;
    }
  }

  private async handleSuccess(
    task: Task,
    cliName: string,
    branchName: string,
    worktreePath: string,
    logFile: string,
    result: { tokensIn: number; tokensOut: number; costUsd: number },
    sessionId?: string
  ): Promise<void> {
    // Commit any remaining changes
    if (hasChanges(worktreePath)) {
      const commitMsg = this.config.git.commitTemplate
        .replace("{type}", task.type)
        .replace("{title}", task.title)
        .replace("{taskId}", task.id.slice(-6));
      commitAll(worktreePath, commitMsg);
    }

    const diffStat = getDiffStat(worktreePath, this.config.git.baseBranch);

    recordAttempt({
      taskId: task.id,
      attemptNumber: task.current_attempt,
      cli: cliName,
      exitCode: 0,
      tokensUsed: result.tokensIn + result.tokensOut,
      costUsd: result.costUsd,
      logFile,
      diffStat,
      sessionId,
    });

    // Check if there are actual changes to push
    if (!diffStat) {
      this.log("No changes made, marking as done", { taskId: task.id });
      updateTaskStatus(task.id, "done");
      return;
    }

    // Push and create PR
    if (
      this.config.git.autoCreatePR &&
      validateBranchForPush(branchName, this.config.git.branchPrefix)
    ) {
      try {
        pushBranch(worktreePath, branchName);

        const prBody = [
          `## Task`,
          `- **ID**: \`${task.id}\``,
          `- **Type**: ${task.type}`,
          `- **Priority**: ${task.priority}`,
          `- **CLI**: ${cliName}`,
          ``,
          `## Description`,
          task.description,
          ``,
          `## Changes`,
          "```",
          diffStat,
          "```",
          ``,
          `---`,
          `Generated by [burn-harness](https://github.com/bkmashiro/burn-harness)`,
        ].join("\n");

        const prUrl = createDraftPR(
          worktreePath,
          branchName,
          this.config.git.baseBranch,
          `burn(${task.type}): ${task.title}`,
          prBody,
          ["burn-harness", task.type]
        );

        updateTaskStatus(task.id, "reviewing", { pr_url: prUrl });
        this.log("PR created", { taskId: task.id, prUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log("Failed to create PR, marking as reviewing", {
          taskId: task.id,
          error: message,
        });
        updateTaskStatus(task.id, "reviewing");
      }
    } else {
      updateTaskStatus(task.id, "reviewing");
    }
  }

  private async handleRateLimit(
    task: Task,
    adapter: CLIAdapter,
    exitCode: number,
    logFile: string
  ): Promise<void> {
    const delay = this.backoff.nextDelay();
    this.log("Rate limited, backing off", {
      taskId: task.id,
      delay: formatDuration(delay),
      attempt: this.backoff.currentAttempt,
    });

    this.state.status = "rate-limited";
    this.registry.markRateLimited(adapter.name, delay);

    recordAttempt({
      taskId: task.id,
      attemptNumber: task.current_attempt,
      cli: adapter.name,
      exitCode,
      failureReason: "Rate limited",
      logFile,
    });

    // Re-queue the task (don't count as a full failed attempt)
    updateTaskStatus(task.id, "pending", {
      worker_id: null,
      current_attempt: task.current_attempt - 1, // Don't count rate-limit as attempt
    });

    await this.sleep(delay);
    this.state.status = "idle";
  }

  private requeueOrFail(task: Task): void {
    if (task.current_attempt >= task.max_attempts) {
      this.log("Task exceeded max attempts, marking as failed", {
        taskId: task.id,
      });
      updateTaskStatus(task.id, "failed", { worker_id: null });
    } else {
      this.log("Re-queuing task for retry", {
        taskId: task.id,
        attempt: task.current_attempt,
        maxAttempts: task.max_attempts,
      });
      updateTaskStatus(task.id, "pending", { worker_id: null });
    }
  }

  private buildPrompt(task: Task): string {
    const parts = [task.description];

    if (task.target_files) {
      try {
        const files = JSON.parse(task.target_files) as string[];
        if (files.length > 0) {
          parts.push(`\nFocus on these files: ${files.join(", ")}`);
        }
      } catch {
        // ignore
      }
    }

    if (this.config.preferences.forbiddenPatterns.length > 0) {
      parts.push(
        `\nAvoid these patterns: ${this.config.preferences.forbiddenPatterns.join(", ")}`
      );
    }

    return parts.join("\n");
  }

  private getModelForAdapter(adapterName: string): string | undefined {
    const cliConfig = this.config.cli[adapterName as keyof typeof this.config.cli];
    if (cliConfig && typeof cliConfig === "object" && "model" in cliConfig) {
      return cliConfig.model;
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow early wakeup on stop
      const check = setInterval(() => {
        if (this.stopped) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }
}
