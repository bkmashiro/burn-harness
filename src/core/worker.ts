import type { BurnConfig } from "../config/schema.js";
import { loadUserPreferences, mergePreferencesIntoPrompt } from "../config/preferences.js";
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
import { pushBranch, createDraftPR, generatePRTitle, buildPRBody, type PRDetails } from "../git/pr.js";
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
  private modelRateLimits = new Map<string, number>();
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
    const selectedModel = this.getModelForAdapter(adapter.name);
    const sessionLog = createSessionLogger(
      this.projectRoot,
      task.id,
      task.current_attempt
    );

    // Get permission mode from CLI config — default to dangerously-skip for autonomous operation
    const cliConfig = this.config.cli[adapter.name as keyof typeof this.config.cli];
    const permissionMode = (cliConfig && typeof cliConfig === "object" && "permissionMode" in cliConfig)
      ? (cliConfig as Record<string, unknown>).permissionMode as string
      : "dangerously-skip";

    this.log("Invoking CLI", {
      taskId: task.id,
      cli: adapter.name,
      model: selectedModel ?? "default",
      permissionMode,
      branch: branchName,
    });

    let sessionId: string | undefined;

    try {

      const cliProcess = adapter.execute({
        prompt,
        cwd: worktreePath,
        model: selectedModel,
        budgetUsd: task.budget_limit_usd ?? this.config.safety.maxBudgetPerTaskUsd ?? undefined,
        timeoutMs: this.config.execution.taskTimeoutMinutes * 60 * 1000,
        appendPrompt: this.config.preferences.style ?? undefined,
        permissionMode,
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

      this.log("CLI process exited", {
        taskId: task.id,
        exitCode: result.exitCode,
        rateLimited: result.rateLimited,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
        runtimeMs: taskRuntimeMs,
        eventsCount: result.events.length,
      });

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

        // Check cost warning threshold
        const costWarning = this.costTracker.checkCostWarning();
        if (costWarning) {
          this.log("COST WARNING", { warning: costWarning });
        }
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
      await this.handleSuccess(task, adapter.name, selectedModel, branchName, worktreePath, sessionLog.logPath, result, sessionId);
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
    model: string | undefined,
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
      model: model ?? undefined,
      exitCode: 0,
      tokensUsed: result.tokensIn + result.tokensOut,
      costUsd: result.costUsd,
      logFile,
      diffStat,
      sessionId,
    });

    // Check if there are actual changes to push
    if (!diffStat) {
      this.log("No changes made, marking as done", { taskId: task.id, model: model ?? "default" });
      updateTaskStatus(task.id, "done");
      return;
    }

    // Push and create PR
    if (
      this.config.git.autoCreatePR &&
      validateBranchForPush(branchName, this.config.git.branchPrefix)
    ) {
      try {
        this.log("Pushing branch", { taskId: task.id, branch: branchName });
        pushBranch(worktreePath, branchName);

        const prTitle = generatePRTitle(task.type, task.title);
        const prDetails: PRDetails = {
          title: prTitle,
          taskId: task.id,
          taskType: task.type,
          taskPriority: task.priority,
          description: task.description,
          cliName,
          diffStat: diffStat ?? "",
          costUsd: result.costUsd > 0 ? result.costUsd : undefined,
          tokensUsed: (result.tokensIn + result.tokensOut) > 0
            ? result.tokensIn + result.tokensOut
            : undefined,
        };
        const prBody = buildPRBody(prDetails);

        // Build labels: always include burn-harness and task type
        const labels = ["burn-harness", task.type];
        if (task.priority <= 2) labels.push("priority:high");
        if (task.source === "brainstorm") labels.push("brainstorm");

        const prUrl = createDraftPR(
          worktreePath,
          branchName,
          this.config.git.baseBranch,
          prTitle,
          prBody,
          labels
        );

        updateTaskStatus(task.id, "reviewing", { pr_url: prUrl });
        this.log("PR created", { taskId: task.id, model: model ?? "default", prUrl });
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
    const currentModel = this.getModelForAdapter(adapter.name);
    const chain = this.getModelChain(adapter.name);
    const delay = this.backoff.nextDelay();

    // Mark the current model as rate-limited — next call will use fallback
    if (currentModel && chain.length > 1) {
      this.markModelRateLimited(adapter.name, currentModel, delay);
    }

    this.log("Rate limited, backing off", {
      taskId: task.id,
      model: currentModel,
      nextModel: this.getModelForAdapter(adapter.name), // May have changed after marking
      delay: formatDuration(delay),
    });

    this.state.status = "rate-limited";
    this.registry.markRateLimited(adapter.name, delay);

    recordAttempt({
      taskId: task.id,
      attemptNumber: task.current_attempt,
      cli: adapter.name,
      model: currentModel,
      exitCode,
      failureReason: `Rate limited (model: ${currentModel ?? "default"})`,
      logFile,
    });

    // Re-queue the task (don't count as a full failed attempt)
    updateTaskStatus(task.id, "pending", {
      worker_id: null,
      current_attempt: task.current_attempt - 1,
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

    // Inject global user preferences
    const userPrefs = loadUserPreferences();
    const prefsPrompt = mergePreferencesIntoPrompt(userPrefs);
    if (prefsPrompt) {
      parts.push(`\n${prefsPrompt}`);
    }

    return parts.join("\n");
  }

  /**
   * Resolve the model chain for an adapter.
   * Returns an array like ["sonnet", "opus"] — first is primary, rest are fallbacks.
   *
   * Config supports:
   *   model: "sonnet"                    → ["sonnet"]
   *   model: ["sonnet", "opus"]          → ["sonnet", "opus"]
   *   model: "sonnet" + fallbackModel: "opus" → ["sonnet", "opus"]
   *   (nothing set)                      → [] (adapter picks default)
   */
  private getModelChain(adapterName: string): string[] {
    const cliConfig = this.config.cli[adapterName as keyof typeof this.config.cli];
    if (!cliConfig || typeof cliConfig !== "object") return [];

    const cfg = cliConfig as Record<string, unknown>;
    const models: string[] = [];

    if (cfg.model) {
      if (Array.isArray(cfg.model)) {
        models.push(...(cfg.model as string[]));
      } else {
        models.push(cfg.model as string);
      }
    }

    // Append legacy fallbackModel if not already in list
    if (cfg.fallbackModel && typeof cfg.fallbackModel === "string") {
      if (!models.includes(cfg.fallbackModel)) {
        models.push(cfg.fallbackModel);
      }
    }

    return models;
  }

  /** Get the current best model to use (skipping rate-limited ones) */
  private getModelForAdapter(adapterName: string): string | undefined {
    const chain = this.getModelChain(adapterName);
    if (chain.length === 0) return undefined;

    // Check if primary model was recently rate-limited, try fallbacks
    for (const model of chain) {
      const limitKey = `model:${adapterName}:${model}`;
      const limitUntil = this.modelRateLimits.get(limitKey) ?? 0;
      if (Date.now() >= limitUntil) {
        return model;
      }
    }

    // All rate-limited — return primary (will hit backoff anyway)
    return chain[0];
  }

  /** Mark a specific model as rate-limited, triggering fallback to next */
  private markModelRateLimited(adapterName: string, model: string, durationMs: number): void {
    const limitKey = `model:${adapterName}:${model}`;
    this.modelRateLimits.set(limitKey, Date.now() + durationMs);

    const chain = this.getModelChain(adapterName);
    const currentIdx = chain.indexOf(model);
    if (currentIdx >= 0 && currentIdx < chain.length - 1) {
      this.log("Model rate-limited, falling back", {
        from: model,
        to: chain[currentIdx + 1],
      });
    }
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
