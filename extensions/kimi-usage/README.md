# kimi-usage

Shows the built-in `kimi-coding` provider's usage in the footer:

```
~/project (main) · 42.3%/200k · 5h:37% wk:12% · kimi-k2
```

## How it works

Fetches `https://api.kimi.com/coding/v1/usages` and publishes `5h:<n>% wk:<n>%` via `setStatus("kimi-usage")`. The credential is resolved by pi itself (stored OAuth/api key from `auth.json`, or `KIMI_API_KEY`) — this extension never reads credential files directly.

Refreshes on session start, on model switches, and after agent runs with a 5-minute throttle. Switching to a non-Kimi model clears the status.

## Notes

- Only works while a built-in `kimi-coding` model is active
- Requires a footer that renders extension statuses (e.g. compact-footer)
