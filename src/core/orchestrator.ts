import type { BurnConfig } from "../config/schema.js";
import { getDb } from "../db/client.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { Worker, type WorkerState } from "./worker.js";
import { Critic } from "./critic.js";
import { BrainstormGenerator } from "../brainstorm/generator.js";
import { getQueueStats, getDailyCost, getTotalCost } from "./task-queue.js";
import { getLogger } from "../logging/logger.js";
import {
  recoverFromCrash,
  writePidFile,
  removePidFile,
  isAlreadyRunning,
} from "./state-persistence.js";
import type pino from "pino";

export interface OrchestratorState {
  running: boolean;
  workers: WorkerState[];
  queueStats: ReturnType<typeof getQueueStats>;
  dailyCost: number;
  totalCost: number;
}

export class Orchestrator {
  private workers: Worker[] = [];
  private running = false;
  private registry: AdapterRegistry;
  private critic: Critic;
  private brainstormer: BrainstormGenerator;
  private logger: pino.Logger;

  constructor(
    private projectRoot: string,
    private config: BurnConfig,
    private profile?: string
  ) {
    // Initialize database
    getDb(projectRoot);

    this.logger = getLogger(projectRoot);
    this.registry = new AdapterRegistry(config);
    this.critic = new Critic(config, this.registry);
    this.brainstormer = new BrainstormGenerator(
      config,
      this.registry,
      projectRoot
    );
  }

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn("Orchestrator already running");
      return;
    }

    // Check if already running
    if (isAlreadyRunning(this.projectRoot)) {
      this.logger.error("Another burn-harness instance is already running");
      return;
    }

    this.running = true;
    writePidFile(this.projectRoot);

    this.logger.info(
      {
        maxWorkers: this.config.execution.maxConcurrentAgents,
        cliPreference: this.config.cli.preference,
        profile: this.profile,
      },
      "Orchestrator starting"
    );

    // Verify at least one CLI is available
    const available = await this.registry.selectAdapter();
    if (!available) {
      this.logger.error(
        "No AI CLI adapters available. Install claude, codex, or aider."
      );
      this.running = false;
      removePidFile(this.projectRoot);
      return;
    }
    this.logger.info(
      { adapter: available.name },
      "Using CLI adapter"
    );

    // Recover from any previous crash — save partial work, re-queue stuck tasks
    const recovery = recoverFromCrash(this.projectRoot);
    if (recovery.recoveredTasks > 0) {
      this.logger.info(
        recovery,
        "Recovered from previous crash"
      );
    }

    // Start workers
    const numWorkers = this.config.execution.maxConcurrentAgents;
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(
        `worker-${i}`,
        this.projectRoot,
        this.config,
        this.registry,
        this.logger
      );
      this.workers.push(worker);
    }

    // Run workers concurrently
    const workerPromises = this.workers.map((w) => w.run());

    // Start brainstorm loop
    const brainstormPromise = this.brainstormLoop();

    // Handle shutdown signals
    const cleanup = () => this.stop();
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Print status periodically
    const statusInterval = setInterval(() => {
      if (this.running) this.printStatus();
    }, 30_000);

    this.printStatus();

    try {
      await Promise.race([
        Promise.all(workerPromises),
        brainstormPromise,
      ]);
    } finally {
      clearInterval(statusInterval);
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      removePidFile(this.projectRoot);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.logger.info("Orchestrator stopping gracefully...");
    this.running = false;
    for (const worker of this.workers) {
      worker.stop();
    }
  }

  getState(): OrchestratorState {
    return {
      running: this.running,
      workers: this.workers.map((w) => w.getState()),
      queueStats: getQueueStats(),
      dailyCost: getDailyCost(),
      totalCost: getTotalCost(),
    };
  }

  getCritic(): Critic {
    return this.critic;
  }

  private async brainstormLoop(): Promise<void> {
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));

      if (!this.running) break;

      // Only brainstorm when queue is empty
      const stats = getQueueStats();
      if (stats.pending > 0 || stats.executing > 0) continue;

      if (!this.brainstormer.canRun()) continue;

      this.logger.info("Queue empty, starting brainstorm...");
      try {
        const suggestions = await this.brainstormer.run();
        if (suggestions.length > 0) {
          this.logger.info(
            { count: suggestions.length },
            "Brainstorm generated suggestions"
          );
          for (const s of suggestions) {
            this.logger.info(
              { title: s.title, type: s.type, priority: s.priority },
              "Suggestion"
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ error: message }, "Brainstorm failed");
      }
    }
  }

  private printStatus(): void {
    const state = this.getState();
    const workerSummary = state.workers
      .map((w) => {
        const task = w.currentTask
          ? ` → ${w.currentTask.title.slice(0, 40)}`
          : "";
        return `  ${w.id}: ${w.status}${task}`;
      })
      .join("\n");

    this.logger.info(
      {
        queue: state.queueStats,
        dailyCost: `$${state.dailyCost.toFixed(2)}`,
        totalCost: `$${state.totalCost.toFixed(2)}`,
      },
      `Status\n${workerSummary}`
    );
  }
}
