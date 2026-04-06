import { spawn } from "node:child_process";
import type {
  CLIAdapter,
  CLICapabilities,
  CLIProcess,
  ExecuteParams,
} from "./types.js";

export class CodexAdapter implements CLIAdapter {
  readonly name = "codex";

  capabilities(): CLICapabilities {
    return {
      supportsStreaming: true,
      supportsJsonOutput: true,
      supportsBudgetLimit: false,
      supportsSessionResume: true,
      supportsSystemPrompt: false,
      supportsPermissionBypass: true,
      supportsTokenReporting: false,  // Codex doesn't reliably report token counts
      supportsCostReporting: false,   // Codex doesn't report USD cost
      supportedModels: ["o3", "o4-mini", "gpt-4.1"],
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = spawn("codex", ["--version"], { stdio: "pipe" });
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
    const proc = spawn("codex", args, {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { process: proc };
  }

  resume(sessionId: string, params: ExecuteParams): CLIProcess {
    const args = ["exec", "resume", sessionId];
    const proc = spawn("codex", args, {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { process: proc, sessionId };
  }

  private buildArgs(params: ExecuteParams): string[] {
    const args = ["exec", "--json", "--full-auto"];

    if (params.model) {
      args.push("--model", params.model);
    }

    args.push(params.prompt);

    return args;
  }
}
