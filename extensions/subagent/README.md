# subagent

Runs pi subprocesses as supervised background agents from the main session.

## What you get

Two tools for the parent agent:

- `subagent` — start one run, a parallel batch, or a sequential chain of tasks
- `subagent_jobs` — list, inspect, steer, resume, or cancel running jobs

While work runs, each subagent publishes a live `footer-row-` status line (title, agent, model, elapsed time, tokens, cost). Starts and completions appear as compact timeline rows in the conversation, and completions are delivered to the parent model automatically.

## Configuration

`~/.pi/agent/subagent.json` — read on every job start, so edits apply without a reload:

```json
{ "concurrency": 4 }
```

`concurrency` caps how many child pi processes run at once (default 4, range 1–32); extra tasks queue.

## Agents

Agent definitions come from pi's standard agent files in `~/.pi/agent/agents/` (and project-local `.pi/agents/` with `agentScope: "both"`). Omitting `agent` runs the child with pi defaults. See [agents/general.md](../../agents/general.md) for an example agent file.

## Notes

- Jobs survive interruption: interrupted background jobs can be resumed from their persisted child sessions
- Children receive only the environment variables their selected provider needs
- A child never waits on UI prompts (they are auto-cancelled) and nested subagents stop at depth 5
