#!/usr/bin/env node

/**
 * Anthropic SDK worker process.
 * Launched by AnthropicSDKAdapter, communicates via stdout stream-json events.
 *
 * Reads config from environment variables:
 *   _ANTHROPIC_PROMPT, _ANTHROPIC_MODEL, _ANTHROPIC_CWD,
 *   _ANTHROPIC_BUDGET_USD, _ANTHROPIC_TIMEOUT_MS,
 *   _ANTHROPIC_SYSTEM_PROMPT, _ANTHROPIC_APPEND_PROMPT
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawn as spawnFn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── Config ──────────────────────────────────────────────────────────

const prompt = process.env._ANTHROPIC_PROMPT;
const model = process.env._ANTHROPIC_MODEL || "claude-sonnet-4-5-20250514";
const cwd = process.env._ANTHROPIC_CWD || process.cwd();
const budgetUsd = parseFloat(process.env._ANTHROPIC_BUDGET_USD || "50");
const timeoutMs = parseInt(process.env._ANTHROPIC_TIMEOUT_MS || "1800000", 10);
const systemPrompt = process.env._ANTHROPIC_SYSTEM_PROMPT || "";
const appendPrompt = process.env._ANTHROPIC_APPEND_PROMPT || "";

if (!prompt) {
  emit({ type: "error", error: { message: "No prompt provided" } });
  process.exit(1);
}

// ── Pricing ─────────────────────────────────────────────────────────

const PRICING = {
  "claude-opus-4-5-20250514": [15, 75],
  "claude-sonnet-4-5-20250514": [3, 15],
  "claude-haiku-3-5-20241022": [0.8, 4],
};

function getCost(tokensIn, tokensOut) {
  const p = PRICING[model] || [3, 15];
  return (tokensIn * p[0] + tokensOut * p[1]) / 1_000_000;
}

// ── Stream-json emitter ─────────────────────────────────────────────

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// ── Tool definitions ────────────────────────────────────────────────

const tools = [
  {
    name: "bash",
    description:
      "Execute a bash command in the working directory. Use for running tests, installing packages, git operations, building code, etc. Commands time out after 60 seconds by default.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        timeout_ms: { type: "number", description: "Timeout in ms (default: 60000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to working dir or absolute)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List files in a directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: '.')" },
      },
      required: [],
    },
  },
  {
    name: "search_code",
    description:
      "Search for a pattern in files (grep). Returns matching lines with paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Directory to search (default: '.')" },
        include: { type: "string", description: "File glob (e.g., '*.ts')" },
      },
      required: ["pattern"],
    },
  },
];

// ── Tool execution ──────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case "bash": {
      const command = input.command;
      const timeout = input.timeout_ms || 60000;
      return new Promise((resolve) => {
        const proc = spawnFn("bash", ["-c", command], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout,
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("close", (code) => {
          const out = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
          resolve(
            code !== 0 ? `Exit code: ${code}\n${out}`.slice(0, 50000) : out.slice(0, 50000)
          );
        });
        proc.on("error", (err) => resolve(`Error: ${err.message}`));
      });
    }

    case "read_file": {
      const filePath = path.resolve(cwd, input.path);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        return content.length > 100000
          ? content.slice(0, 100000) + "\n... (truncated)"
          : content;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    case "write_file": {
      const filePath = path.resolve(cwd, input.path);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content);
        return `Written: ${filePath}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    case "list_dir": {
      const dirPath = path.resolve(cwd, input.path || ".");
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    case "search_code": {
      const searchPath = path.resolve(cwd, input.path || ".");
      return new Promise((resolve) => {
        const args = ["-rn", "--color=never"];
        if (input.include) args.push("--include", input.include);
        args.push(input.pattern, searchPath);
        const proc = spawnFn("grep", args, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
        let output = "";
        proc.stdout.on("data", (d) => (output += d.toString()));
        proc.on("close", () => resolve(output.slice(0, 50000) || "No matches found."));
        proc.on("error", () => resolve("grep not available"));
      });
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Main agentic loop ───────────────────────────────────────────────

async function main() {
  const client = new Anthropic();
  const startTime = Date.now();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;
  let turnCount = 0;
  const maxTurns = 200; // Safety limit

  // Build system prompt
  let system =
    "You are an expert software engineer. Complete the task described by the user. " +
    "Use the provided tools to read, write, and search code. " +
    "When done, provide a brief summary of what you changed.";
  if (systemPrompt) system = systemPrompt;
  if (appendPrompt) system += "\n\n" + appendPrompt;

  // Build initial messages
  const messages = [{ role: "user", content: prompt }];

  // Emit session start
  emit({ type: "system", session_id: `sdk-${Date.now()}` });

  try {
    while (turnCount < maxTurns) {
      turnCount++;

      // Check budget
      if (totalCost >= budgetUsd) {
        emit({
          type: "error",
          error: { message: `Budget exhausted: $${totalCost.toFixed(2)} >= $${budgetUsd}` },
        });
        break;
      }

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        emit({
          type: "error",
          error: { message: "Timeout exceeded" },
        });
        break;
      }

      // Truncate conversation if too long (keep system + first + last N messages)
      if (messages.length > 40) {
        const first = messages.slice(0, 2);
        const last = messages.slice(-20);
        messages.length = 0;
        messages.push(...first, { role: "user", content: "[Earlier conversation truncated for context window management]" }, ...last);
      }

      // Call API with retry
      let response;
      let retries = 0;
      const maxRetries = 5;

      while (retries < maxRetries) {
        try {
          response = await client.messages.create({
            model,
            max_tokens: 8192,
            system,
            tools,
            messages,
          });
          break;
        } catch (err) {
          if (
            err.status === 429 ||
            err.status === 529 ||
            (err.status >= 500 && err.status < 600)
          ) {
            retries++;
            const delay = Math.min(1000 * Math.pow(2, retries), 60000);
            emit({
              type: "rate_limit_event",
              rate_limit_info: {
                status: "rate_limited",
                rateLimitType: `HTTP ${err.status}`,
              },
            });
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw err;
        }
      }

      if (!response) {
        emit({ type: "error", error: { message: "Max retries exceeded" } });
        break;
      }

      // Track usage
      const usage = response.usage || {};
      const turnIn = usage.input_tokens || 0;
      const turnOut = usage.output_tokens || 0;
      totalTokensIn += turnIn;
      totalTokensOut += turnOut;
      totalCost = getCost(totalTokensIn, totalTokensOut);

      emit({
        type: "token_usage",
        usage: { input_tokens: turnIn, output_tokens: turnOut },
        cost_usd: getCost(turnIn, turnOut),
      });

      // Process response content
      const assistantContent = response.content;
      let hasToolUse = false;
      const toolResults = [];

      for (const block of assistantContent) {
        if (block.type === "text") {
          emit({ type: "assistant", message: { content: [{ type: "text", text: block.text }] } });
        } else if (block.type === "tool_use") {
          hasToolUse = true;
          emit({
            type: "tool_use",
            tool_name: block.name,
            input:
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input),
          });

          // Execute tool
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      // Add assistant message to conversation
      messages.push({ role: "assistant", content: assistantContent });

      // If there were tool calls, add results and continue
      if (hasToolUse && toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // No tool use and stop_reason is "end_turn" — we're done
      if (response.stop_reason === "end_turn") {
        break;
      }

      // stop_reason is something else (e.g., max_tokens) — continue
      if (response.stop_reason === "max_tokens") {
        messages.push({
          role: "user",
          content: "Continue from where you left off.",
        });
        continue;
      }

      break;
    }
  } catch (err) {
    emit({
      type: "error",
      error: { message: err.message || String(err), retryable: false },
    });
  }

  // Emit final result
  emit({
    type: "result",
    result: "Task completed",
    usage: { input_tokens: totalTokensIn, output_tokens: totalTokensOut },
    cost_usd: totalCost,
    total_cost_usd: totalCost,
  });

  process.exit(0);
}

main().catch((err) => {
  emit({ type: "error", error: { message: err.message || String(err) } });
  process.exit(1);
});
