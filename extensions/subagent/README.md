# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Quiet timeline**: The conversation records one start line and one completion/failure line per invocation
- **Live footer status**: Running agents, their models, elapsed time, input/output/cache tokens, and cost update in the footer
- **Parallel streaming**: Parallel task progress is collected continuously without flooding the conversation
- **Usage tracking**: Completion lines distinguish input (`↑`), output (`↓`), cache read (`R`), and cache write (`W`) tokens
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md              # This file
├── index.ts               # Tool execution and orchestration
├── agents.ts              # Agent discovery logic
├── schema.ts              # Tool parameter schemas
├── status-publisher.ts    # Publishes live state for the active footer
├── timeline-renderer.ts   # Quiet start/completion rows
├── types.ts               # Shared extension-local types
├── agents/                # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

Background supervision is enabled by default. Starting a job returns immediately with a `jobId`; call `subagent` again whenever another independent child should be created. Use `subagent_jobs` to list, inspect, cancel, or resume jobs. Resumed work reuses the child's persisted Pi session.

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, title, task }` | Start one independent child; call again later to create another |
| Parallel | `{ tasks: [...] }` | Batch shortcut for multiple children (max 100, 20 concurrent globally) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |
| Synchronous compatibility | `background: false` | Wait for the invocation instead of returning a supervised job |

## Output Display

The conversation is intentionally quiet and acts as a timeline:

```text
[18:40:12] → subagent started · Review authentication · reviewer · user
[18:41:05] ✓ subagent completed · Review authentication · reviewer · 53.2s · 4 turns · ↑8.0k ↓1.3k R3.0k W0 · $0.0214
```

While work is running, the extension publishes status entries with `ctx.ui.setStatus()`. The active footer (such as `relay-footer`) remains the sole footer renderer and shows the live details:

- Status title and agent name
- Active model (the agent's configured model, or the inherited parent model)
- Start time and elapsed time
- Token usage split into input (`↑`), output (`↓`), cache read (`R`), and cache write (`W`), plus cost
- Up to five status rows total: four individual agents plus one `… N more subagents running` summary when needed

Partial output, child tool calls, final answers, and full supervisor notification bodies are not rendered in the conversation. Start and finish stay as compact one-line timeline rows even when Ctrl+O is enabled. Automatic completion, interruption, and cancellation messages render as a single count-and-elapsed-time row (for example, `✓ subagent job completed · 45/45 succeeded · 29m05s`). Their bounded full notification content still participates in the parent model's context so completion can steer or wake the main agent.

`subagent_jobs` also has a dedicated compact renderer for `list`, `status`, `resume`, and `cancel`. Default `list`/`status` model results contain job metadata, aggregate succeeded/failed/pending/running counts, elapsed time, and at most five short failure diagnostics; they do not include successful task output. `list` is bounded to the 50 newest jobs. Structured tool `details` retain each returned job's complete in-memory results and child session IDs used by rendering and supervision, while the TUI always stays compact and never expands task output through Ctrl+O.

For explicit diagnostics, call:

```text
subagent_jobs { action: "status", jobId: "sub-...", includeOutput: true }
```

This opt-in adds task output to the **model-visible** status result with hard limits of 4 KB per task and 20 KB total. The TUI row remains compact; use the model to inspect or summarize the returned diagnostics. Background supervisor notifications keep their existing 50 KB total cap, and synchronous parallel calls keep the 50 KB per-task model-output cap.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Timeline, supervisor notification, and `subagent_jobs` rows remain compact and do not reveal child output through Ctrl+O
- Opt-in `status includeOutput` diagnostics are capped at 4 KB per task and 20 KB total
- Synchronous parallel model-visible output is capped at 50 KB per task; supervisor notifications are capped at 50 KB total
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode is limited to 100 tasks per call, with up to 20 concurrent processes globally across supervised jobs
- Subagents may recursively spawn children for up to 3 child levels; agents at the third child level are leaves
