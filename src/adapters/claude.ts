import { spawn } from "node:child_process";
import type {
  CLIAdapter,
  CLICapabilities,
  CLIProcess,
  ExecuteParams,
} from "./types.js";

export class ClaudeAdapter implements CLIAdapter {
  readonly name = "claude";

  capabilities(): CLICapabilities {
    return {
      supportsStreaming: true,
      supportsJsonOutput: true,
      supportsBudgetLimit: true,
      supportsSessionResume: true,
      supportsSystemPrompt: true,
      supportsPermissionBypass: true,
      supportsTokenReporting: true,
      supportsCostReporting: true,
      supportedModels: ["opus", "sonnet", "haiku"],
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = spawn("claude", ["--version"], { stdio: "pipe" });
      return new Promise((resolve) => {
        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });
    } catch {
      return false;
    }
  }

  execute(params: ExecuteParams): CLIProcess {
    const args = this.buildArgs(params);
    const proc = spawn("claude", args, {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { process: proc };
  }

  resume(sessionId: string, params: ExecuteParams): CLIProcess {
    const args = this.buildArgs(params);
    args.push("--resume", sessionId);
    const proc = spawn("claude", args, {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { process: proc, sessionId };
  }

  private buildArgs(params: ExecuteParams): string[] {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (params.model) {
      args.push("--model", params.model);
    }

    if (params.budgetUsd) {
      args.push("--max-budget-usd", String(params.budgetUsd));
    }

    if (params.systemPrompt) {
      args.push("--system-prompt", params.systemPrompt);
    }

    if (params.appendPrompt) {
      args.push("--append-system-prompt", params.appendPrompt);
    }

    // Permission mode: dangerously-skip for autonomous operation,
    // auto requires user approval which blocks in --print mode
    if (params.permissionMode === "dangerously-skip") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", params.permissionMode ?? "auto");
    }

    args.push("--", params.prompt);

    return args;
  }
}
