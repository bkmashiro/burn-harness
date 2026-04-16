import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type {
  CLIAdapter,
  CLICapabilities,
  CLIProcess,
  ExecuteParams,
} from "./types.js";

/**
 * Native Anthropic SDK adapter — calls the Anthropic API directly.
 * No CLI dependency required. Supports streaming, tool_use, and
 * context window management.
 *
 * Pricing (per 1M tokens):
 *   claude-opus-4-5:     $15 input / $75 output
 *   claude-sonnet-4-5:   $3 input / $15 output
 *   claude-haiku-3-5:    $0.80 input / $4 output
 *
 * Built-in tools: bash, read_file, write_file, list_dir, search_code
 */

// Model pricing: [input $/1M, output $/1M]
const MODEL_PRICING: Record<string, [number, number]> = {
  "claude-opus-4-5-20250514": [15, 75],
  "claude-sonnet-4-5-20250514": [3, 15],
  "claude-haiku-3-5-20241022": [0.8, 4],
  // Aliases
  "opus": [15, 75],
  "sonnet": [3, 15],
  "haiku": [0.8, 4],
  "claude-opus-4-5": [15, 75],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-3-5": [0.8, 4],
};

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-5-20250514",
  sonnet: "claude-sonnet-4-5-20250514",
  haiku: "claude-haiku-3-5-20241022",
  "claude-opus-4-5": "claude-opus-4-5-20250514",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250514",
  "claude-haiku-3-5": "claude-haiku-3-5-20241022",
};

const TOOL_DEFINITIONS = [
  {
    name: "bash",
    description:
      "Execute a bash command in the working directory. Use for running tests, installing packages, git operations, etc. Commands time out after 60 seconds by default.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default: 60000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the full file content.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to working directory or absolute)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Creates parent directories as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file",
        },
        content: {
          type: "string",
          description: "Content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description:
      "List files and directories in a directory. Returns names with / suffix for directories.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory path (default: working directory)",
        },
      },
      required: [],
    },
  },
  {
    name: "search_code",
    description:
      "Search for a pattern in files using grep/ripgrep. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern (regex supported)",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: working directory)",
        },
        include: {
          type: "string",
          description: "Glob pattern for files to include (e.g., '*.ts')",
        },
      },
      required: ["pattern"],
    },
  },
];

function resolveModel(model?: string): string {
  if (!model) return "claude-sonnet-4-5-20250514";
  return MODEL_ALIASES[model] ?? model;
}

function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["sonnet"];
  return (tokensIn * pricing[0] + tokensOut * pricing[1]) / 1_000_000;
}

/**
 * Execute a built-in tool and return the result string.
 */
async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): Promise<string> {
  switch (toolName) {
    case "bash": {
      const command = input.command as string;
      const timeoutMs = (input.timeout_ms as number) ?? 60_000;
      return new Promise<string>((resolve) => {
        const proc = spawn("bash", ["-c", command], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: timeoutMs,
        });
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        proc.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        proc.on("close", (code) => {
          const result = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
          if (code !== 0) {
            resolve(
              `Exit code: ${code}\n${result}`.slice(0, 50_000)
            );
          } else {
            resolve(result.slice(0, 50_000));
          }
        });
        proc.on("error", (err) => {
          resolve(`Error: ${err.message}`);
        });
      });
    }

    case "read_file": {
      const filePath = path.resolve(cwd, input.path as string);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.length > 100_000) {
          return content.slice(0, 100_000) + "\n... (truncated)";
        }
        return content;
      } catch (err) {
        return `Error reading file: ${(err as Error).message}`;
      }
    }

    case "write_file": {
      const filePath = path.resolve(cwd, input.path as string);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content as string);
        return `File written: ${filePath}`;
      } catch (err) {
        return `Error writing file: ${(err as Error).message}`;
      }
    }

    case "list_dir": {
      const dirPath = path.resolve(cwd, (input.path as string) ?? ".");
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n");
      } catch (err) {
        return `Error listing directory: ${(err as Error).message}`;
      }
    }

    case "search_code": {
      const pattern = input.pattern as string;
      const searchPath = path.resolve(cwd, (input.path as string) ?? ".");
      const include = input.include as string | undefined;
      return new Promise<string>((resolve) => {
        const args = ["-rn", "--color=never"];
        if (include) args.push("--include", include);
        args.push(pattern, searchPath);
        const proc = spawn("grep", args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30_000,
        });
        let output = "";
        proc.stdout?.on("data", (d: Buffer) => {
          output += d.toString();
        });
        proc.on("close", () => {
          resolve(output.slice(0, 50_000) || "No matches found.");
        });
        proc.on("error", () => {
          resolve("grep not available");
        });
      });
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

/**
 * AnthropicSDKAdapter wraps the Anthropic SDK into a ChildProcess-like
 * interface so it can be consumed by the existing monitorProcess().
 *
 * It creates a synthetic ChildProcess that emits stream-json events
 * on stdout, matching the Claude CLI format.
 */
export class AnthropicSDKAdapter implements CLIAdapter {
  readonly name = "anthropic";

  capabilities(): CLICapabilities {
    return {
      supportsStreaming: true,
      supportsJsonOutput: true,
      supportsBudgetLimit: true,
      supportsSessionResume: false,
      supportsSystemPrompt: true,
      supportsPermissionBypass: true,
      supportsTokenReporting: true,
      supportsCostReporting: true,
      supportedModels: [
        "claude-opus-4-5",
        "claude-sonnet-4-5",
        "claude-haiku-3-5",
        "opus",
        "sonnet",
        "haiku",
      ],
    };
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return !!apiKey && apiKey.length > 10;
  }

  execute(params: ExecuteParams): CLIProcess {
    // Create a fake ChildProcess using a long-running node subprocess
    // that drives the Anthropic API and emits stream-json on stdout.
    const model = resolveModel(params.model);
    const budgetUsd = params.budgetUsd ?? 50;
    const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;

    // We use a node subprocess that does the actual API work.
    // This is necessary because monitorProcess() expects a ChildProcess.
    const scriptPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "_anthropic-worker.mjs"
    );

    // Serialize config as env vars
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(params.env ?? {}),
      _ANTHROPIC_PROMPT: params.prompt,
      _ANTHROPIC_MODEL: model,
      _ANTHROPIC_CWD: params.cwd,
      _ANTHROPIC_BUDGET_USD: String(budgetUsd),
      _ANTHROPIC_TIMEOUT_MS: String(timeoutMs),
    };

    if (params.systemPrompt) {
      env._ANTHROPIC_SYSTEM_PROMPT = params.systemPrompt;
    }
    if (params.appendPrompt) {
      env._ANTHROPIC_APPEND_PROMPT = params.appendPrompt;
    }

    const proc = spawn("node", [scriptPath], {
      cwd: params.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { process: proc };
  }

  resume(_sessionId: string, params: ExecuteParams): CLIProcess {
    // SDK adapter doesn't support resume — just re-execute
    return this.execute(params);
  }
}

// Export pricing for cost tracking
export { MODEL_PRICING, MODEL_ALIASES, resolveModel, calculateCost, TOOL_DEFINITIONS, executeTool };
