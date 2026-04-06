# burn-harness User Manual

## Table of Contents

1. [Getting Started](#getting-started)
2. [Interactive Mode](#interactive-mode)
3. [Task Management](#task-management)
4. [Agent Loop](#agent-loop)
5. [Brainstorming](#brainstorming)
6. [AI-Assisted Planning](#ai-assisted-planning)
7. [Configuration](#configuration)
8. [Cost Management](#cost-management)
9. [Git Workflow](#git-workflow)
10. [Recovery & Resilience](#recovery--resilience)
11. [Safety & Guardrails](#safety--guardrails)
12. [Command Reference](#command-reference)
13. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **Git** (with a remote configured)
- **At least one AI coding CLI** installed and authenticated:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
  - [Codex](https://github.com/openai/codex): `npm install -g @openai/codex`
  - [Aider](https://github.com/paul-gauthier/aider): `pip install aider-chat`
- **GitHub CLI** (`gh`): required for PR creation

### Installation

```bash
npm install -g burn-harness
```

### Initialize in your project

```bash
cd your-project
burn init
```

This creates:
- `burn.yaml` — project configuration (commit this)
- `.burn/` — database, logs, worktrees (gitignored)

### Your first task

```bash
# Add a task
burn add "Fix the null pointer exception in auth.ts"

# Start the agent loop
burn start
```

Or use **interactive mode** (recommended for first-time users):

```bash
burn
```

---

## Interactive Mode

Interactive mode is the primary way to use burn-harness. Just run `burn` with no arguments:

```
$ burn

  ╔══════════════════════════════════════╗
  ║  burn-harness v0.1.0                 ║
  ║  AI coding agent orchestrator         ║
  ╚══════════════════════════════════════╝

  3 pending · 0 running · 2 done · $1.23 today

  Type /help for commands, or just describe a task to add it.

burn >
```

### Quick task entry

Just type a task description — no command prefix needed:

```
burn > Fix the login form validation
  + Task ABC123 added — [bug/P3] Fix the login form validation
```

burn-harness auto-detects the task type and priority from your description:
- Words like "fix", "bug", "crash" → type: `bug`
- Words like "add", "create", "implement" → type: `feature`
- Words like "critical", "urgent" → priority: 1
- Words like "nice to have" → priority: 4

### Slash commands

All commands start with `/`. Type `/help` for the full list.

```
burn > /queue
  Task Queue — 3 pending, 1 running, 2 done, 0 failed

  ABC123  pending     P1 [bug]          Fix null pointer in auth
  DEF456  executing   P2 [feature]      Add dark mode toggle
  GHI789  pending     P3 [test]         Add unit tests for UserService

burn > /status
  System Status

  Agent loop:   RUNNING
  Pending:      2
  Executing:    1
  Done:         2
  Today's cost: $1.23 / $50.00
```

---

## Task Management

### Adding tasks

**Quick add** (interactive mode):
```
burn > Add OAuth2 authentication
```

**CLI add** (from shell):
```bash
burn add "Add OAuth2 authentication"
burn add -t feature -p 2 "Add OAuth2 authentication"
burn add -t bug -p 1 -c small --files "src/auth.ts" "Fix auth bypass"
```

**Guided wizard** (interactive mode):
```
burn > /add-interactive

  Task Creation Wizard

  Title: Add OAuth2 login
  Description: Implement OAuth2 flow with Google and GitHub providers
  Type [bug, feature, ...] (default: chore): feature
  Priority 1-5 (default: 3): 2
  Complexity [trivial/small/medium/large/epic] (default: medium): large
  Target files (comma-separated): src/auth/oauth.ts, src/routes/login.ts
  Budget cap in USD (or Enter for default): 8

  + Task XYZ789 created!
```

### Task types

| Type | When to use |
|------|-------------|
| `bug` | Fix something broken |
| `feature` | Add new functionality |
| `refactor` | Restructure without changing behavior |
| `test` | Add or improve tests |
| `docs` | Documentation, comments, README |
| `performance` | Speed, memory, bundle size improvements |
| `security` | Fix vulnerabilities, add auth, input validation |
| `chore` | Everything else |

### Task lifecycle

```
pending → planning → executing → reviewing → done
                         ↓            ↓
                    (rate-limit)   (reject)
                         ↓            ↓
                    (backoff+retry)  pending (with feedback)
                         ↓
                    (max attempts)
                         ↓
                       failed
```

- **pending**: Waiting in queue
- **planning**: Agent is analyzing the task
- **executing**: AI CLI is running
- **reviewing**: Changes made, draft PR created, awaiting human review
- **done**: Human approved / merged
- **failed**: Exceeded max retries

### Managing tasks

```
burn > /promote ABC123        # Move to front of queue
burn > /cancel ABC123         # Cancel a task
burn > /retry ABC123          # Reset a failed task for retry
burn > /rollback ABC123       # Undo changes (delete branch + close PR)
```

---

## Agent Loop

### Starting and stopping

```
burn > /start                  # Start agents in background
burn > /stop                   # Gracefully stop all agents
```

Or from the shell:
```bash
burn start                     # Foreground (Ctrl+C to stop)
burn start --workers 3         # Multiple concurrent agents
burn start --profile aggressive # Use a named profile
burn start --no-brainstorm     # Disable brainstorming
```

### What happens when you start

1. **Recovery check**: Detects and recovers orphaned tasks from any previous crash
2. **CLI detection**: Verifies at least one AI CLI is available
3. **Worker spawn**: Starts N worker threads (default: 1)
4. **Main loop begins**: Workers start pulling tasks

### How a task executes

For each task, the agent:

1. **Claims** the task (atomic database operation — no double-claiming)
2. **Creates a git branch**: `burn/<type>/<id>/<title-slug>`
3. **Creates a worktree**: Isolated copy of the repo at `.burn/worktrees/worker-N/`
4. **Invokes the AI CLI** with the task description as the prompt
5. **Monitors** the CLI's output stream for:
   - Progress events (tool use, file edits)
   - Rate limit detection (429, "overloaded", etc.)
   - Token usage and cost tracking
   - Completion or failure
6. **On success**: Commits changes, pushes branch, creates draft PR
7. **On failure**: Logs error, retries (up to 3 attempts), or marks as failed

### Multi-agent mode

Run multiple agents simultaneously:

```yaml
# burn.yaml
execution:
  maxConcurrentAgents: 3
```

Each agent gets its own git worktree, so they never interfere with each other or your working directory.

---

## Brainstorming

When the task queue empties, burn-harness can analyze your codebase and suggest improvements.

### On-demand brainstorm

```
burn > /brainstorm

  Analyzing codebase for improvements...
  ...........

  Found 5 suggestions:

  1. [test/P3/small] Add unit tests for UserService.updateProfile
     Files: src/services/user.ts, tests/services/user.test.ts

  2. [security/P2/trivial] Remove hardcoded API key in config.example.ts
     Files: config.example.ts

  3. [refactor/P4/medium] Extract email validation into shared utility
     Files: src/auth/register.ts, src/profile/edit.ts

  4. [docs/P5/small] Add JSDoc to exported functions in src/utils/
     Files: src/utils/*.ts

  5. [performance/P3/small] Memoize expensive computation in Dashboard
     Files: src/components/Dashboard.tsx

  Use /review to approve suggestions.
```

### Reviewing suggestions

```
burn > /review

  Review 5 brainstormed suggestions

  For each: [a]pprove  [r]eject  [e]dit  [s]kip  [q]uit

  Add unit tests for UserService.updateProfile
  Type: test | Files: src/services/user.ts...
  Action [a/r/e/s/q]: a
  + Approved → Task ABC456

  Remove hardcoded API key
  Action [a/r/e/s/q]: a
  + Approved → Task DEF789

  Extract email validation
  Action [a/r/e/s/q]: e
  New title [Extract email validation]: Extract and unify all validation utilities
  New description: Consolidate validation functions from auth and profile into src/shared/validators.ts
  + Edited & approved → Task GHI012
```

### Auto-approve rules

For low-risk task types, you can skip manual review:

```yaml
# burn.yaml
brainstorm:
  autoApprove:
    - type: test
      maxComplexity: small     # Auto-approve small test tasks
    - type: docs
      maxComplexity: trivial   # Auto-approve trivial doc tasks
```

### Brainstorm categories

The brainstormer rotates through these focus areas:
- **Tests**: Missing coverage, untested edge cases
- **Docs**: Missing JSDoc, outdated documentation
- **Security**: Hardcoded secrets, injection risks, outdated deps
- **Performance**: N+1 queries, missing memoization, bundle bloat
- **Code quality**: Duplication, high complexity, dead code
- **Error handling**: Bare catches, unhandled rejections
- **Type safety**: `any` types, missing null checks

Configure which areas to focus on:

```yaml
brainstorm:
  focusAreas: [tests, security, performance]
  ignoreAreas: [vendor/, dist/, node_modules/]
  intervalMinutes: 60           # Don't brainstorm more than once per hour
```

---

## AI-Assisted Planning

### `/plan` — Break goals into tasks

Got a big goal? Let the AI analyze your codebase and break it into executable tasks:

```
burn > /plan Add user authentication with OAuth2 and JWT

  Planning with AI agent...
  .................

  Plan: 6 tasks

  1. [feature/medium] Create JWT token utility functions
     Implement sign, verify, and refresh token functions...

  2. [feature/medium] Add OAuth2 provider configuration
     Create OAuth client configuration for Google and GitHub...

  3. [feature/large] Implement OAuth2 callback handler (after: #1, #2)
     Handle the OAuth redirect callback, exchange code for tokens...

  4. [feature/small] Add authentication middleware (after: #1)
     Create Express middleware that validates JWT from Authorization header...

  5. [feature/medium] Add login/logout routes (after: #3, #4)
     Create /auth/login, /auth/callback, /auth/logout endpoints...

  6. [test/medium] Add auth integration tests (after: #5)
     Test the full OAuth flow with mocked providers...

  Add all tasks to queue? [y/n/edit]: y

  + 6 tasks added to queue with dependency chain.
  Run /start to begin execution.
```

The planner:
- Analyzes your codebase to understand the existing architecture
- Breaks the goal into small, agent-executable tasks
- Sets up dependency chains (task 3 waits for tasks 1 and 2)
- Estimates complexity for each task
- Identifies target files

### `/chat` — Ask questions

```
burn > /chat How does the authentication middleware work?

The authentication middleware in src/middleware/auth.ts uses JWT tokens...
(full AI response streamed in real-time)
```

### `/refine` — Improve task descriptions

Make an existing task more specific and actionable:

```
burn > /refine ABC123

  Refining: Fix the login bug
  Current description: Fix the login bug

  Analyzing...

  Refined description:

  The login form in src/components/Login.tsx has a race condition when
  submitting rapidly. The handleSubmit function doesn't prevent double
  submission. Fix by:
  1. Add a loading state to disable the submit button during API call
  2. Use an AbortController to cancel in-flight requests on unmount
  3. Add error boundary for network failures
  Files: src/components/Login.tsx, src/hooks/useAuth.ts

  Update task with refined description? [y/n]: y
  + Task description updated.
```

---

## Configuration

### Config file

`burn.yaml` in your project root (created by `burn init`):

```yaml
# Which AI CLIs to use, in preference order
cli:
  preference: [claude, codex]

  claude:
    model: sonnet                    # Default model
    fallbackModel: haiku             # On rate-limit, use cheaper model
    appendSystemPrompt: |
      Follow the project's ESLint config.
      Use TypeScript strict mode.
      Prefer functional components.

  codex:
    model: o3

# Git settings
git:
  baseBranch: main
  branchPrefix: burn
  autoCreatePR: true
  draftPR: true                      # Always draft
  reviewers: [alice, bob]

# Execution
execution:
  maxConcurrentAgents: 1             # Workers (1 for solo, 2-4 for teams)
  taskTimeoutMinutes: 30
  pollIntervalSeconds: 10
  maxAttemptsPerTask: 3

# Budget limits
safety:
  maxBudgetPerTaskUsd: 5.00
  maxBudgetPerDayUsd: 50.00
  maxBudgetTotalUsd: 500.00
  maxFilesModifiedPerTask: 20
  maxLinesChangedPerTask: 1000
  requireApprovalForTypes: [security]
  forbiddenPaths:
    - "*.env*"
    - "credentials.*"
    - ".github/workflows/*"

# Brainstorming
brainstorm:
  enabled: true
  focusAreas: [tests, docs, security, performance]
  model: sonnet
  maxSuggestionsPerRun: 5
  intervalMinutes: 60
  autoApprove:
    - type: test
      maxComplexity: small

# Coding preferences (injected into AI prompts)
preferences:
  language: TypeScript
  style: |
    - Use functional programming patterns
    - Prefer immutable data
    - Write tests for new functions
  testFramework: vitest
  linter: eslint
```

### Config layering

Three layers, merged in order (later overrides earlier):

| File | Purpose | Git? |
|------|---------|------|
| `~/.config/burn/config.yaml` | Your personal defaults across all projects | N/A |
| `burn.yaml` | Project settings (shared with team) | Yes |
| `burn.local.yaml` | Your local overrides | No (gitignored) |

### Profiles

Define named presets for different work modes:

```yaml
profiles:
  aggressive:
    execution:
      maxConcurrentAgents: 4
    brainstorm:
      autoApprove:
        - type: test
        - type: docs
        - type: refactor
          maxComplexity: small

  conservative:
    execution:
      maxConcurrentAgents: 1
    safety:
      requireApprovalForTypes: [bug, feature, refactor, security]
    brainstorm:
      enabled: false

  tests-only:
    brainstorm:
      focusAreas: [tests]
      autoApprove:
        - type: test
```

```bash
burn start --profile aggressive
```

---

## Cost Management

### Budget controls

Three levels of budget protection:

| Level | Config key | Default | What happens when exceeded |
|-------|-----------|---------|--------------------------|
| Per-task | `safety.maxBudgetPerTaskUsd` | $5 | Task stops, marked needs-review |
| Per-day | `safety.maxBudgetPerDayUsd` | $50 | All workers pause until midnight |
| Total | `safety.maxBudgetTotalUsd` | $500 | All workers stop permanently |

### Viewing costs

```
burn > /report

  Cost Report (last 7 days)

  Date        Cost      Tokens     Requests
  2026-04-06  $  3.45     125000         12
  2026-04-05  $  8.21     298000         24
  2026-04-04  $  1.02      45000          6
  Total       $ 12.68

burn > /status
  Today's cost: $3.45 / $50.00
  Total cost:   $12.68 / $500.00
```

### Cost optimization tips

1. **Use cheaper models for brainstorming**: Set `brainstorm.model: haiku`
2. **Set per-task budgets**: `burn add --budget 2 "Simple fix"`
3. **Use the right tool**: Aider for targeted file edits (cheaper), Claude for broad features
4. **Limit brainstorm frequency**: `brainstorm.intervalMinutes: 120`

---

## Git Workflow

### Branch naming

All branches follow: `burn/<type>/<task-id-short>/<title-slug>`

```
burn/bug/abc123/fix-null-pointer-auth
burn/feature/def456/add-dark-mode-toggle
burn/test/ghi789/add-user-service-tests
```

### Worktree isolation

Each worker agent gets its own git worktree:

```
your-project/
  .burn/
    worktrees/
      worker-0/     # Agent 0's isolated copy
      worker-1/     # Agent 1's isolated copy
```

Your main working directory is **never modified** by burn-harness.

### PR workflow

1. Agent completes a task
2. Changes are committed to the task's branch
3. Branch is pushed to origin
4. **Draft PR** is created via `gh pr create --draft`
5. You review the PR at your leisure
6. You mark as ready-for-review and merge (burn-harness never merges)

---

## Recovery & Resilience

### Every interruption is recoverable

burn-harness is designed so that **no state is ever lost**:

| Scenario | What happens |
|----------|-------------|
| **Rate limit (429)** | Exponential backoff (30s→600s), retry automatically. Doesn't count as a failed attempt. |
| **Process crash** | On restart: detects orphaned tasks, saves uncommitted work as checkpoint commits, re-queues. |
| **Power loss / kill -9** | Same as crash — SQLite WAL ensures database integrity. |
| **Network failure** | Retry with backoff. After 5 failures, pause worker and alert. |
| **Budget exceeded** | Graceful stop. Partial work is saved. Task paused for human decision. |
| **CLI not found** | Falls back to next configured CLI in preference order. |
| **Git conflict** | Task marked failed with "git-conflict" reason. Fix base branch and `/retry`. |

### PID file protection

burn-harness writes a PID file at `.burn/burn.pid`. If you try to start a second instance, it detects the existing one and refuses to start (preventing database corruption and worktree conflicts).

### Session resume

When a task is interrupted mid-execution, burn-harness stores the CLI's session ID. On retry, it attempts to resume the session (`claude --resume <session-id>`) rather than starting from scratch.

### Checkpoint commits

If a crash happens while an agent has uncommitted work:

1. On restart, burn-harness detects the dirty worktree
2. Commits the partial work: `burn(checkpoint): partial work on ABC123 [auto-saved on recovery]`
3. Re-queues the task with context about what was already done

---

## Safety & Guardrails

### Hard rules (cannot be overridden)

- **Never force-push** (`git push --force` is blocked)
- **Never push to main/master** (all work on branches)
- **Never merge PRs** (human-only operation)
- **Never modify secrets** (`.env`, `credentials.*` are blocked)
- **Always create draft PRs** (never auto-mark as ready)
- **Never delete non-burn branches** (only `burn/*` branches can be deleted)

### GAN-like critic

After an agent completes a task, a second AI pass reviews the changes:

1. **Generator** (worker): Produces code changes
2. **Discriminator** (critic): Reviews the diff, scores 1-10

If score < 7, the task is **rejected** and re-queued with the critic's feedback appended to the prompt. This creates an adversarial improvement loop — each iteration should produce better code.

### Configurable safety

```yaml
safety:
  requireApprovalForTypes: [security, feature]  # Pause before executing these
  forbiddenPaths:
    - "*.env*"
    - "credentials.*"
    - ".github/workflows/*"     # Don't modify CI
    - "package-lock.json"       # Don't mess with lockfiles
  maxFilesModifiedPerTask: 20   # Reject over-broad changes
  maxLinesChangedPerTask: 1000  # Reject huge diffs
```

---

## Command Reference

### Shell commands

| Command | Description |
|---------|-------------|
| `burn` | Start interactive mode (default) |
| `burn init` | Initialize burn-harness in current project |
| `burn add <desc>` | Add a task |
| `burn add -t <type> -p <priority> <desc>` | Add with type and priority |
| `burn queue` | Show task queue |
| `burn start` | Start agent loop (foreground) |
| `burn start --workers 3` | Multi-agent mode |
| `burn start --profile <name>` | Use a config profile |
| `burn status` | Show system status |
| `burn report` | Cost and usage analytics |
| `burn promote <id>` | Move task to front of queue |
| `burn retry <id>` | Reset a failed task |
| `burn cancel <id>` | Cancel a task |
| `burn rollback <id>` | Undo changes (delete branch, close PR) |
| `burn interactive` | Explicitly start interactive mode |

### Interactive mode commands

| Command | Description |
|---------|-------------|
| `/add <desc>` | Add a task |
| `/add-interactive` | Guided task creation wizard |
| `/queue` or `/q` | Show task queue |
| `/status` | System status |
| `/start` | Start agent loop in background |
| `/stop` | Stop agent loop |
| `/brainstorm` | AI analyzes codebase for improvements |
| `/review` | Review brainstormed suggestions |
| `/plan <goal>` | AI breaks a goal into executable tasks |
| `/chat <question>` | Ask AI about the codebase |
| `/refine <id>` | AI refines a task's description |
| `/report` | Cost report |
| `/config` | Show current configuration |
| `/promote <id>` | Prioritize a task |
| `/retry <id>` | Retry a failed task |
| `/cancel <id>` | Cancel a task |
| `/rollback <id>` | Undo a task's changes |
| `/clear` | Clear screen |
| `/help` or `/?` | Show help |
| `/exit` or `Ctrl+C` | Exit |

---

## Troubleshooting

### "No AI CLI available"

Make sure at least one CLI is installed and authenticated:
```bash
claude --version    # Claude Code
codex --version     # Codex
aider --version     # Aider
```

### "Another burn-harness instance is already running"

A previous instance may have crashed without cleanup:
```bash
rm .burn/burn.pid   # Remove stale PID file
burn start          # Try again
```

### Tasks stuck in "executing" status

This means a previous instance crashed mid-task. Just restart:
```bash
burn start   # Auto-recovers orphaned tasks
```

### Rate limits

burn-harness handles these automatically. If you see frequent rate limiting:
1. Reduce `maxConcurrentAgents` to 1
2. Add a fallback CLI: `cli.preference: [claude, codex]`
3. Set longer brainstorm intervals: `brainstorm.intervalMinutes: 120`

### High costs

1. Set lower budgets in `burn.yaml`
2. Use cheaper models: `cli.claude.model: haiku`
3. Use `/report` to identify expensive task types
4. Set per-task budgets: `burn add --budget 2 "Small fix"`

### Git issues

burn-harness never modifies your working directory. If you see git issues:
```bash
# Clean up worktrees
git worktree prune

# Remove burn branches
git branch | grep "burn/" | xargs git branch -D

# Reset the database
rm -rf .burn/burn.db
burn init
```
