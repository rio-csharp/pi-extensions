# Subagent Extension

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Quiet timeline**: The conversation records one start line and one completion/failure line per invocation
- **Live footer status**: Running agents, their models, elapsed time, input/output/cache tokens, and cost update in the footer
- **Parallel streaming**: Parallel task progress is collected continuously without flooding the conversation
- **Usage tracking**: Completion lines distinguish input (`↑`), output (`↓`), cache read (`R`), and cache write (`W`) tokens
- **Abort support**: Pi's interrupt signal propagates to terminate subagent processes

## Structure

```
subagent/
├── README.md              # This file
├── index.ts               # Tool execution and orchestration
├── agents.ts              # Agent discovery logic
├── schema.ts              # Tool parameter schemas
├── status-publisher.ts    # Publishes live state for the active footer
├── timeline-renderer.ts   # Quiet start/completion rows
└── types.ts               # Shared extension-local types
```

## Installation

From this repository's root, copy the extension and provider-neutral agent definition:

```powershell
$Agent = "$HOME\.pi\agent"
New-Item -ItemType Directory -Force "$Agent\extensions", "$Agent\agents" | Out-Null
Copy-Item .\extensions\subagent "$Agent\extensions\" -Recurse -Force
Copy-Item .\agents\general.md "$Agent\agents\general.md" -Force
```

```bash
AGENT="$HOME/.pi/agent"
mkdir -p "$AGENT/extensions" "$AGENT/agents"
cp -R extensions/subagent "$AGENT/extensions/"
cp agents/general.md "$AGENT/agents/general.md"
```

Run `/reload` after copying.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

Project-local agents require Pi's project-trust decision when a job is created. Persisted jobs are different: their recorded cwd can be unrelated to the current session, while Pi's extension context can report trust only for the current cwd. Therefore **every** resume of a project-scope job is refused outside TUI mode and requires an interactive confirmation that prints the exact persisted project-agent source cwd and every effective per-task child execution path in a reversible quoted form. This resume-path gate cannot be disabled. If `confirmProjectAgents` is enabled, a second confirmation names the freshly discovered project-agent files because they may have changed while the job was stopped.

## Usage

### Single agent
```text
Use general to inspect the authentication code
```

### Parallel execution
```text
Run two general agents in parallel: one to inspect models and one to inspect providers
```

### Chained workflow
```text
Use a chain: first have general inspect the read tool, then have general propose improvements using {previous}
```

## Tool Modes

Background supervision is enabled by default. Starting a job returns immediately with a `jobId`; call `subagent` again whenever another independent child should be created. Use `subagent_jobs` to list, inspect, cancel, or resume jobs. Resumed work reuses the child's persisted Pi session and the recorded effective `provider/model` selected when that child first ran, even if the parent model or agent definition later changes. Legacy snapshots that did not record a model omit the override and let Pi restore the child session's model.

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
- Compact live format: `1: title · agent · provider/model · start time · elapsed · ↑input ↓output Rcache-read · cost`
- Up to five status rows total: four individual agents plus one `… N more subagents running` summary when needed

Cache-write (`W`) usage remains available in completion rows but is omitted from the live footer to preserve horizontal space.

Partial output, child tool calls, final answers, and full supervisor notification bodies are not rendered in the conversation. Start and finish stay as compact one-line timeline rows even when Ctrl+O is enabled. Automatic completion, interruption, and cancellation messages render as a single count-and-elapsed-time row (for example, `✓ subagent job completed · 45/45 succeeded · 29m05s`). Their bounded full notification content still participates in the parent model's context so completion can steer or wake the main agent.

`subagent_jobs` also has a dedicated compact renderer for `list`, `status`, `resume`, and `cancel`. Default `list`/`status` model results contain job metadata, aggregate succeeded/failed/pending/running counts, elapsed time, and at most five short failure diagnostics; they do not include successful task output. `list` is bounded to the 50 newest jobs. Structured tool `details` retain bounded result metadata and child session IDs used by rendering and supervision, while full child message arrays are omitted. The TUI always stays compact and never expands task output through Ctrl+O.

For explicit diagnostics, call:

```text
subagent_jobs { action: "status", jobId: "sub-...", includeOutput: true }
```

This opt-in adds task output to the **model-visible** status result with hard limits of 4 KB per task and 20 KB total. The TUI row remains compact; use the model to inspect or summarize the returned diagnostics. Background supervisor notifications have a 50 KB total cap, and synchronous parallel calls have a 50 KB per-task model-output cap.

Background persistence is append-only and delta-based: one immutable job definition is followed by small job/task state entries, rather than repeatedly embedding every prior result. This avoids quadratic session growth. Resume requires the child session id, effective model, original delegated prompt, job default cwd, and any per-task cwd, so those prompt/cwd fields are persisted **verbatim** in the parent session JSONL. Treat the parent session file as sensitive: delegated prompts can contain source, instructions, paths, or secrets. Raw prompts are omitted from structured background tool details and timeline rendering, but not from persistence because resumes explicitly restate the original task and chain templates need `{previous}` substitution. Each persisted task output is redacted on a best-effort basis and capped at 50 KB; complete in-memory output is still passed to the next step of a chain during the active run, while a chain reconstructed after restart can use only the bounded persisted handoff. Legacy full-snapshot `subagent-supervisor-job` entries remain readable.

## Child Process Environment

Subagents no longer inherit the parent's full environment. The child receives only:

- launch/runtime and OS basics: `PATH`, `PATHEXT`, Windows system/program/profile directories, home/user/temp/shell/terminal/locale (`LC_*` included), timezone, TLS certificate paths, Node/Bun runtime settings;
- Pi configuration: `PI_CODING_AGENT`, config/session/package directory overrides, offline/version-check/telemetry/cache/share/terminal/experimental settings;
- networking: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`;
- only the selected built-in provider's documented credentials/configuration (for example, an OpenAI child gets `OPENAI_API_KEY`, while a Bedrock child gets the AWS credential chain variables); provider credentials for unrelated providers are dropped;
- for a selected custom provider, conventional names derived from its provider id (`<PROVIDER>_{API_KEY,AUTH_TOKEN,OAUTH_TOKEN,BASE_URL,ENDPOINT,ACCOUNT_ID,GATEWAY_ID,PROJECT,LOCATION,REGION}`) plus exact environment names referenced by `$NAME`/`${NAME}` in Pi's registered provider config (API key/header templates);
- child-owned `PI_SUBAGENT_ACTIVE` and `PI_SUBAGENT_DEPTH` markers.

Everything else is dropped. In particular, unrelated repository/CI/cloud/application secrets and all parent `PI_SESSION_*`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` values are not inherited. Pi injects the child's own current session/model metadata into its bash tool at command execution time.

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

## Included Agent

The repository ships `agents/general.md`, a provider-neutral general-purpose definition that inherits the parent Pi model and all default tools. Provider- or model-pinned definitions should remain in the user's local `~/.pi/agent/agents/` directory unless intentionally made portable.

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: A Pi interrupt or supervisor cancellation terminates the subprocess and returns an error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Timeline, supervisor notification, and `subagent_jobs` rows remain compact and do not reveal child output through Ctrl+O
- Persisted output, supervisor messages, status diagnostics, and background result diagnostics apply best-effort secret redaction; this is defense in depth, not a guarantee, so agents should not print credentials
- Persisted output is capped at 50 KB per task; opt-in `status includeOutput` diagnostics are capped at 4 KB per task and 20 KB total
- Synchronous parallel model-visible output is capped at 50 KB per task; supervisor notifications are capped at 50 KB total
- A live chain passes the complete ephemeral output through `{previous}`; after process/session restart, only the redacted 50 KB persisted handoff is available for already completed steps
- Shutdown waits up to 7.5 seconds for child teardown, preserves the interrupted resumable state, and rejects late writes from the retired runtime
- Agents discovered fresh on each invocation (allows editing mid-session)
- Project agent discovery can walk upward only to an explicitly supplied trusted project boundary; current tool/resume paths use cwd itself as that boundary because Pi exposes no arbitrary-path temporary-trust boundary. Directories and markdown files are canonicalized, and symlinks escaping the selected project-agent directory are ignored
- Untrusted terminal controls (ANSI/OSC, C0/C1, and bidi controls) are removed from rendered title, agent, model, status, error, diagnostic, and timeline metadata
- Parallel mode is limited to 100 tasks per call, with up to 20 concurrent processes globally across supervised jobs
- Subagents may recursively spawn children for up to 3 child levels; agents at the third child level are leaves
