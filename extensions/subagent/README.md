# subagent

Runs pi subprocesses as supervised background agents from the main session.

## What you get

Two tools for the parent agent:

- `subagent` — start one run, a parallel batch, or a sequential chain of tasks
- `subagent_jobs` — list, inspect, steer, resume, or cancel running jobs

While work runs, each subagent publishes a live `footer-row-` status line: the title, then `provider/model name`, start time, elapsed time, tokens, and cost. Only the title scrolls when it is too long for the terminal; the fields behind it keep their position. Starts and completions appear as compact timeline rows in the conversation, and completions are delivered to the parent model automatically.

## Configuration

`~/.pi/agent/subagent.json` — read on every job start, so edits apply without a reload:

```json
{ "concurrency": 4, "defaultModel": "provider/model-id" }
```

`concurrency` caps how many child pi processes run at once (default 4, range 1–32). Extra tasks queue.

Replace `provider/model-id` with an available model from your Pi catalog. `defaultModel` also accepts a bare model ID and an optional `:thinkingLevel` suffix. New jobs choose the item override, the call-level override, the configured default, then the parent model, in that order. A configured model that is missing from the catalog or lacks configured authentication blocks calls that need the default. Changing the default affects new jobs. Resuming without overrides keeps the model already recorded for the job.

When `subagent` is active, Pi shows the model the available model references and recommends omitting `model` for routine delegation. A minimal call is `{"title":"Review module","task":"Review src/ for regressions."}`. For `subagent_jobs`, only `resume` accepts `model`, `thinking`, and `tools`.

## Per-call overrides

Every mode accepts four optional overrides, so one call can steer each child independently. In `tasks[]`/`chain[]` they go on the item; at the top level they apply to single mode and act as the item default:

| Field | Effect |
| --- | --- |
| `model` | Target model as `provider/id` or bare `id`, with an optional `:thinkingLevel` suffix (`qfg/claude-opus-5.5:high`, `deepseek-v4.1-flash`, `amr-link/deepseek-v4.1-flash:low`). Defaults to `defaultModel` or the parent model. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Works with the inherited parent model too; wins over a `:suffix` on `model`. Defaults to `medium`. |
| `tools` | Passed to the child as `--tools`. Omit it to inherit the child's complete default tool set, and pass it only to deliberately restrict permissions (for example a read-only reviewer with `["read", "grep"]`). Plain names replace the selection; entries that are all `+name`/`-name` adjust the defaults, and pi rejects mixed forms. |
| `systemPrompt` | Extra instructions appended to the child's system prompt. |

A blank optional model, thinking level, working directory, system prompt, or tool selection is treated as omitted. The supervisor ignores arguments its current action does not use.

Overrides that supply a value are validated. An explicit override that cannot be honored aborts the call. That covers an unknown model id (the error lists candidate `provider/id` entries), a provider without configured credentials, an unknown thinking level, malformed `tools` entries, an unknown tool name, mixing plain names with `+name`/`-name`, and a wildcard inside a `+name`/`-name` entry. Wildcards stay legal for plain allowlist names. A background start that fails validation registers no job.

Thinking, tools, and system prompt are recorded with the job definition, so a background job and its resume replay the same overrides.

## Resuming a job

`subagent_jobs action=resume` continues an interrupted job from its persisted child sessions, so the child keeps its full conversation history. Resume also accepts `model`, `thinking`, and `tools` (and only resume accepts them): the supplied fields replace the recorded values for every task of the job, are validated through the same resolver, and are persisted with the job definition. An explicit `--model` wins over the model recorded in the resumed session.

Because the history is kept, a smaller target model may not fit it: if a task recorded context usage larger than the new model's context window, the resume is refused with an instruction to start a fresh subagent instead. Unknown usage never blocks a resume.

## Notes

- Children use Pi's default tools unless the call overrides them
- Jobs survive interruption: interrupted background jobs can be resumed from their persisted child sessions
- Children receive only the environment variables their selected provider needs
- A child never waits on UI prompts (they are auto-cancelled) and nested subagents stop at depth 5
