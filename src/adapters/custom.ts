import { spawn } from "node:child_process";
import type {
  CLIAdapter,
  CLICapabilities,
  CLIProcess,
  ExecuteParams,
} from "./types.js";

/**
 * Generic adapter for any CLI tool that accepts a prompt and produces output.
 * This supports local LLM CLIs, custom scripts, or any tool that follows
 * the pattern: <command> [args...] <prompt>
 *
 * Configure in burn.yaml:
 *
 *   cli:
 *     preference: [custom]
 *     custom:
 *       command: ollama           # The CLI binary
 *       args: [run, codellama]    # Arguments before the prompt
 *       promptFlag: ""            # If set, prompt passed as --flag "prompt"
 *                                 # If empty, prompt passed as last positional arg
 *       model: codellama          # For logging/display
 */

export interface CustomAdapterConfig {
  command: string;
  args?: string[];
  promptFlag?: string;
  model?: string;
  env?: Record<string, string>;
}

export class CustomAdapter implements CLIAdapter {
  readonly name: string;

  constructor(private adapterConfig: CustomAdapterConfig) {
    this.name = `custom:${adapterConfig.command}`;
  }

  capabilities(): CLICapabilities {
    return {
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsBudgetLimit: false,
      supportsSessionResume: false,
      supportsSystemPrompt: false,
      supportsPermissionBypass: false,
      supportsTokenReporting: false,
      supportsCostReporting: false,
      supportedModels: [this.adapterConfig.model ?? "unknown"],
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = spawn(this.adapterConfig.command, ["--version"], {
        stdio: "pipe",
      });
      return new Promise((resolve) => {
        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });
    } catch {
      return false;
    }
  }

  execute(params: ExecuteParams): CLIProcess {
    const args = [...(this.adapterConfig.args ?? [])];

    if (this.adapterConfig.promptFlag) {
      args.push(this.adapterConfig.promptFlag, params.prompt);
    } else {
      args.push(params.prompt);
    }

    const proc = spawn(this.adapterConfig.command, args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...this.adapterConfig.env,
        ...params.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { process: proc };
  }

  resume(_sessionId: string, params: ExecuteParams): CLIProcess {
    // Custom CLIs don't support session resume — just re-execute
    return this.execute(params);
  }
}
