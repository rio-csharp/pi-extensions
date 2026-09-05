# relay-balance

Shows the active relay provider's balance in the footer:

```
~/project (main) · 42.3%/200k · $72.87 · (ai-pixel) gpt-5.6-sol
```

## How it works

Looks the current model's provider up in `~/.pi/agent/relay-providers.json` (owned by the relay-providers extension) and polls `GET {baseUrl}/usage` with its apiKey, publishing the amount via `setStatus("relay-balance")`. Built-in providers (not listed in that file) are ignored.

Refreshes on session start, on model switches, and on a 5-minute timer.

## Notes

- Only the generic `{ "remaining": <number>, "unit": "USD" }` response shape is supported (`balance` also accepted)
- apiKey values resolve literals and `$ENV_VAR`; a leading `!command` is never executed by this probe
- Requires a footer that renders extension statuses (e.g. compact-footer)
