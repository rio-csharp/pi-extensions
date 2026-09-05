# subagent

Runs pi subprocesses as supervised background agents from the main session.

## What you get

Two tools for the parent agent:

- `subagent` — start one run, a parallel batch, or a sequential chain of tasks
- `subagent_jobs` — list, inspect, steer, resume, or cancel running jobs

While work runs, each subagent publishes a live `footer-row-` status line (title, agent, model, elapsed time, tokens, cost). Starts and completions appear as compact one-line rows in the conversation timeline.

## Configuration

Agent definitions come from `~/.pi/agent/agents/` (pi's standard agent files).

## Notes

- Jobs survive interruption: interrupted background jobs can be resumed
- Full notification bodies still reach the parent model's context, so completions can steer the main agent
