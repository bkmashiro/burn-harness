import type { ChildProcess } from "node:child_process";
import type { OutputEvent } from "../adapters/types.js";
import { classifyOutput } from "../adapters/types.js";

export interface ParsedResult {
  events: OutputEvent[];
  exitCode: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  sessionId?: string;
  rateLimited: boolean;
  rawOutput: string;
}

export function parseClaudeStreamJson(line: string): OutputEvent | null {
  try {
    const event = JSON.parse(line);

    // Claude stream-json event types

    // System init event — extract session_id
    if (event.type === "system" && event.session_id) {
      return {
        type: "progress",
        message: "",
        raw: line,
      };
    }

    // Assistant message — contains content blocks with text
    if (event.type === "assistant" && event.message) {
      const msg = event.message;
      // Extract text from content blocks: [{type: "text", text: "..."}]
      if (msg.content && Array.isArray(msg.content)) {
        const texts = msg.content
          .filter((b: any) => b.type === "text" && b.text)
          .map((b: any) => b.text);
        if (texts.length > 0) {
          return { type: "progress", message: texts.join("") };
        }
      }
      // Fallback: stringify the whole message
      return {
        type: "progress",
        message: typeof msg === "string" ? msg : "",
      };
    }

    // Content block deltas (streaming)
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta") {
        return { type: "progress", message: delta.text };
      }
    }

    // Tool use events
    if (event.type === "tool_use" || event.tool_name) {
      return {
        type: "tool_use",
        tool: event.tool_name ?? event.name,
        input:
          typeof event.input === "string"
            ? event.input
            : JSON.stringify(event.input),
      };
    }

    // Result event — final response with cost/token data
    if (event.type === "result") {
      return {
        type: "completion",
        result:
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result),
        tokensIn: event.usage?.input_tokens,
        tokensOut: event.usage?.output_tokens,
        costUsd: event.cost_usd ?? event.total_cost_usd,
        raw: line,
      };
    }

    // Rate limit event from Claude
    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info;
      if (info?.status === "rate_limited" || info?.status === "denied") {
        return {
          type: "rate_limit",
          message: `Rate limited (${info.rateLimitType}), resets at ${info.resetsAt}`,
          retryable: true,
          retryAfterMs: info.resetsAt ? (info.resetsAt * 1000 - Date.now()) : undefined,
        };
      }
      // status === "allowed" — not rate limited, ignore
      return null;
    }

    if (event.type === "error") {
      const msg = event.error?.message ?? event.message ?? line;
      const classified = classifyOutput(msg);
      if (classified.type === "rate_limit") return classified;
      return {
        type: "error",
        message: msg,
        code: event.error?.code,
        retryable: event.error?.retryable ?? false,
      };
    }

    // Usage/cost events
    if (event.usage || event.cost_usd) {
      return {
        type: "token_usage",
        tokensIn: event.usage?.input_tokens,
        tokensOut: event.usage?.output_tokens,
        costUsd: event.cost_usd,
      };
    }

    // Session info
    if (event.session_id) {
      return {
        type: "progress",
        message: `Session: ${event.session_id}`,
        raw: line,
      };
    }

    return null;
  } catch {
    // Not JSON — classify as raw text
    return classifyOutput(line);
  }
}

export async function monitorProcess(
  proc: ChildProcess,
  onEvent: (event: OutputEvent) => void,
  onSessionId?: (id: string) => void,
  timeoutMs?: number
): Promise<ParsedResult> {
  const events: OutputEvent[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let sessionId: string | undefined;
  let rateLimited = false;
  let rawOutput = "";

  const processLine = (line: string) => {
    rawOutput += line + "\n";

    const event = parseClaudeStreamJson(line);
    if (!event) return;

    events.push(event);
    onEvent(event);

    if (event.type === "rate_limit") {
      rateLimited = true;
    }

    if (event.tokensIn) tokensIn += event.tokensIn;
    if (event.tokensOut) tokensOut += event.tokensOut;
    if (event.costUsd) costUsd += event.costUsd;

    // Extract session ID from raw output
    if (event.raw) {
      const sessionMatch = event.raw.match(/"session_id"\s*:\s*"([^"]+)"/);
      if (sessionMatch) {
        sessionId = sessionMatch[1];
        onSessionId?.(sessionId);
      }
    }
  };

  let stdoutBuffer = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdoutBuffer += text;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) processLine(line.trim());
    }
  });

  let stderrBuffer = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrBuffer += text;
    rawOutput += text;
    // Check stderr for rate limit patterns
    const classified = classifyOutput(text);
    if (classified.type === "rate_limit") {
      rateLimited = true;
      events.push(classified);
      onEvent(classified);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 10000);
        resolve(-1); // Timeout
      }, timeoutMs);
    }

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? 1);
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });

  // Process remaining buffer
  if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());

  return {
    events,
    exitCode,
    tokensIn,
    tokensOut,
    costUsd,
    sessionId,
    rateLimited,
    rawOutput,
  };
}
