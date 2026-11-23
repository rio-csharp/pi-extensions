# tps-stats

Shows the session's average output speed and average time-to-first-token in the footer:

```
~/project (main) · 42.3%/200k · 78t/s 0.7s · (ai-pixel) gpt-5.6-sol
```

Left number is tokens per second over the decode window, right number is seconds from request to first output.

## How it works

Publishes `78t/s 0.7s` via `setStatus("tps")`. Nothing is fetched and nothing is persisted. Units stay glued to their number (`78t/s`, `0.7s`, `450ms`, `32k`) so the status reads as close-packed values rather than spaced words.

- **Request start** - the `timestamp` the provider writes on the assistant message just before sending the request. It excludes pi's local preparation (context assembly, hooks), so the number is request-to-first-output.
- **First output** comes from the first nonempty text, thinking, or tool-argument delta, or from the generated name on a tool-call start. Empty block markers and final completion events are excluded. Thinking counts as output when the provider streams it.
- **Decode time** is `durationMs` (pi's monotonic request-to-done measurement) minus the observed time to first output. The result estimates how long generation took after the first output arrived.
- **Output tokens** - `usage.output`, which already includes reasoning and tool-call tokens.

## Averages

- **t/s** (written `78t/s`, glued like every other unit in the status row) is token weighted: total output over total decode time. A short answer therefore cannot skew it the way a mean of per-response rates would.
- **s** is the arithmetic mean of first-output times for the same responses.

Both averages require a successful response with positive output usage, a valid `durationMs`, and an observed first-output time strictly between request start and completion.

## Notes

- Averages cover the responses *this process* observed. `durationMs` and usage are in the session file, but the first-token time is not persisted, so nothing is backfilled after `/reload`, `/resume`, or `/new` — the status stays empty until a response completes.
- Time to first output depends on how a provider streams reasoning: one that withholds thinking until the end reports the first visible text instead.
- Requires a footer that renders extension statuses (e.g. compact-footer); it renders inline there.
