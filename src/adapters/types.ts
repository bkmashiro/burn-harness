import type { ChildProcess } from "node:child_process";

export interface OutputEvent {
  type:
    | "progress"
    | "tool_use"
    | "file_edit"
    | "completion"
    | "error"
    | "rate_limit"
    | "token_usage"
    | "unknown";
  message?: string;
  tool?: string;
  input?: string;
  path?: string;
  diff?: string;
  result?: string;
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  raw?: string;
}

export interface ExecuteParams {
  prompt: string;
  cwd: string;
  model?: string;
  systemPrompt?: string;
  appendPrompt?: string;
  budgetUsd?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  env?: Record<string, string>;
}

export interface CLIProcess {
  process: ChildProcess;
  sessionId?: string;
}

export interface CLICapabilities {
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;
  supportsBudgetLimit: boolean;
  supportsSessionResume: boolean;
  supportsSystemPrompt: boolean;
  supportsPermissionBypass: boolean;
  supportedModels: string[];
}

export interface CLIAdapter {
  readonly name: string;
  capabilities(): CLICapabilities;
  isAvailable(): Promise<boolean>;
  execute(params: ExecuteParams): CLIProcess;
  resume(sessionId: string, params: ExecuteParams): CLIProcess;
}

export const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /quota exceeded/i,
  /capacity/i,
  /overloaded/i,
  /retry.?after/i,
  /credit balance/i,
  /billing/i,
  /usage limit/i,
];

export const CRASH_PATTERNS = [
  /SIGKILL|SIGSEGV|SIGABRT/,
  /out of memory/i,
  /heap out of memory/i,
  /maximum call stack/i,
];

export function classifyOutput(line: string): OutputEvent {
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(line)) {
      const retryMatch = line.match(/retry.?after:?\s*(\d+)/i);
      return {
        type: "rate_limit",
        message: line,
        retryable: true,
        retryAfterMs: retryMatch ? parseInt(retryMatch[1]) * 1000 : undefined,
      };
    }
  }

  for (const pattern of CRASH_PATTERNS) {
    if (pattern.test(line)) {
      return {
        type: "error",
        message: line,
        retryable: false,
      };
    }
  }

  return { type: "unknown", raw: line };
}
