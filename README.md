# burn-harness

Run AI coding CLIs (Claude Code, Codex, Aider) **non-stop** on a developer task queue.

burn-harness is an orchestrator that keeps AI agents working continuously — pulling tasks from a queue, creating branches, executing work, creating draft PRs, recovering from rate limits, and brainstorming new work when the queue empties.

## How it works

```
You define tasks → burn-harness runs AI agents → You get draft PRs

┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Task Queue  │────▶│  Agent Loop   │────▶│  Draft PRs   │
│              │     │  Claude/Codex │     │  for review  │
└─────────────┘     └──────────────┘     └──────────────┘
       ▲                    │
       │              Rate limit?
       │              Crash? Timeout?
       │                    │
       └────── Auto-recover + retry
```

**The core loop:**
1. Pick the highest-priority task from the queue
2. Create a git branch + worktree
3. Invoke the AI CLI (`claude --print`, `codex exec`, etc.)
4. Monitor output for rate limits, crashes, completion
5. On success: commit changes, push branch, create draft PR
6. On failure: exponential backoff, retry (up to 3 attempts)
7. When queue empty: brainstorm improvements (tests, docs, security, perf)
8. Repeat forever

## Quick start

```bash
# Install
npm install -g burn-harness

# Initialize in your project
cd your-project
burn init

# Add tasks
burn add -t bug -p 1 "Fix the null pointer in auth.ts"
burn add -t feature -p 2 "Add dark mode toggle to settings page"
burn add -t test -p 3 "Add unit tests for UserService"

# Start the agent loop
burn start

# Check progress
burn queue
burn status
burn report
```

## Commands

| Command | Description |
|---------|-------------|
| `burn init` | Initialize burn-harness in current project |
| `burn add <desc>` | Add a task to the queue |
| `burn queue` | Show the task queue |
| `burn start` | Start the agent loop |
| `burn status` | Show current status |
| `burn report` | Cost and usage analytics |
| `burn rollback <id>` | Undo a task's changes |
| `burn promote <id>` | Move task to front of queue |
| `burn retry <id>` | Reset a failed task |
| `burn cancel <id>` | Cancel a task |

### Adding tasks

```bash
burn add "Fix the login bug"                          # Basic
burn add -t bug -p 1 "Critical auth bypass"           # Typed + priority
burn add -t refactor -c large "Extract auth service"  # With complexity
burn add --files "src/auth.ts,src/login.ts" "Fix auth" # Target files
burn add --budget 10 "Complex refactor"               # Per-task budget cap
```

**Task types:** `bug`, `feature`, `refactor`, `test`, `docs`, `performance`, `security`, `chore`
**Priority:** 1 (critical) to 5 (nice-to-have)
**Complexity:** `trivial`, `small`, `medium`, `large`, `epic`

## Configuration

`burn init` creates a `burn.yaml` in your project root:

```yaml
cli:
  preference: [claude, codex]    # Fallback order
  claude:
    model: sonnet
    appendSystemPrompt: |
      Follow the project's ESLint rules strictly.

git:
  baseBranch: main
  autoCreatePR: true
  draftPR: true                  # Always draft — human reviews

execution:
  maxConcurrentAgents: 1
  taskTimeoutMinutes: 30
  maxAttemptsPerTask: 3

safety:
  maxBudgetPerTaskUsd: 5.00
  maxBudgetPerDayUsd: 50.00
  maxBudgetTotalUsd: 500.00
  forbiddenPaths:
    - "*.env*"
    - "credentials.*"

brainstorm:
  enabled: true
  focusAreas: [tests, docs, security, performance]
  autoApprove:
    - type: test
      maxComplexity: small
```

### Config layering

```
~/.config/burn/config.yaml    # User defaults
project-root/burn.yaml        # Project config (commit this)
project-root/burn.local.yaml  # Local overrides (gitignored)
```

### Profiles

```yaml
profiles:
  aggressive:
    execution:
      maxConcurrentAgents: 4
    brainstorm:
      autoApprove:
        - type: test
        - type: docs

  conservative:
    execution:
      maxConcurrentAgents: 1
    brainstorm:
      enabled: false
```

```bash
burn start --profile aggressive
```

## Features

### GAN-like Critic

Every completed task goes through a **critic pass** — a second AI review that scores the changes (1-10) and either approves or rejects with feedback. Rejected tasks are re-queued with the critic's feedback appended, creating an adversarial improvement loop.

### Brainstorming

When the queue empties, burn-harness analyzes your codebase and suggests improvements:

- **Test coverage** — untested functions, missing edge cases
- **Documentation** — missing JSDoc, outdated README
- **Security** — hardcoded secrets, injection risks
- **Performance** — N+1 queries, missing memoization
- **Code quality** — duplication, complexity, dead code

Low-risk suggestions (tests, docs) can be auto-approved. Everything else waits for your review.

### Rate Limit Recovery

When the AI CLI hits a rate limit, burn-harness:
1. Detects the limit from CLI output patterns
2. Applies exponential backoff (30s → 60s → 120s → 300s → 600s)
3. Falls back to alternative CLIs if configured
4. Retries automatically — rate limits don't count as failed attempts

### Crash Recovery

On restart after a crash:
1. Detects orphaned tasks stuck in "executing" state
2. Saves any uncommitted work as checkpoint commits
3. Re-queues all interrupted tasks
4. Resumes CLI sessions when possible (`--resume`)

### Safety Guardrails

**Hard rules (not configurable):**
- Never force-push
- Never push to main/master
- Never merge PRs (human only)
- Never modify secrets/credentials
- Always create draft PRs

**Configurable limits:**
- Per-task, daily, and total budget caps
- Max files/lines modified per task
- Forbidden file paths
- Required human approval for specific task types

## Architecture

```
src/
  cli/           # CLI entry point + commands
  core/          # Orchestrator, worker, task queue, critic
  adapters/      # Claude, Codex, Aider CLI adapters
  git/           # Branch, worktree, PR, safety
  brainstorm/    # Auto-task generation
  monitor/       # Output parsing, rate-limit, cost tracking
  config/        # YAML config loading + Zod validation
  db/            # SQLite schema + migrations
```

State lives in `.burn/burn.db` (SQLite). Each worker gets its own git worktree at `.burn/worktrees/worker-N/`.

## Supported CLIs

| CLI | Status | Features |
|-----|--------|----------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Full support | Streaming JSON, budget control, session resume |
| [Codex](https://github.com/openai/codex) | Supported | JSON output, full-auto mode |
| [Aider](https://github.com/paul-gauthier/aider) | Planned | File-scoped edits |

## Requirements

- Node.js >= 18
- Git
- At least one AI coding CLI installed (`claude`, `codex`, or `aider`)
- `gh` CLI (for PR creation)

## License

MIT
