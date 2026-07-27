# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Quiet timeline**: The conversation records one start line and one completion/failure line per invocation
- **Live footer status**: Running agents, elapsed time, input/output/cache tokens, and cost update in the footer
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

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

The conversation is intentionally quiet and acts as a timeline:

```text
[18:40:12] → subagent started · Review authentication · reviewer · user
[18:41:05] ✓ subagent completed · Review authentication · reviewer · 53.2s · 4 turns · ↑8.0k ↓1.3k R3.0k W0 · $0.0214
```

While work is running, the extension publishes status entries with `ctx.ui.setStatus()`. The active footer (such as `relay-footer`) remains the sole footer renderer and shows the live details:

- Status title and agent name
- Start time and elapsed time
- Token usage split into input (`↑`), output (`↓`), cache read (`R`), and cache write (`W`), plus cost
- One row per active agent in parallel mode

Partial output, child tool calls, and the final answer are not rendered in the conversation. They remain in the tool result sent to the parent model. Ctrl+O therefore does not expand subagent output.

For parallel calls, each completed task's model-visible output is capped at 50 KB. Full structured results remain in tool details, and failure diagnostics are returned to the parent model.

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

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
