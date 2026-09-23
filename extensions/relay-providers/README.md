# relay-providers

Registers manually configured providers and models from `~/.pi/agent/relay-providers.json`, so relays (OpenAI-compatible gateways, etc.) appear in pi's model picker alongside built-in providers.

## Configuration

The config file is local-only — never commit it. See [config-examples](../../config-examples/) for the structure.

Per provider: `id`, `baseUrl`, `apiKey` (literal, `$ENV_VAR`, or a trusted local `!command`), `api` (a built-in pi API family such as `openai-completions` or `openai-responses`), and `models[]`. `hidden: true` on a provider or model keeps it in the file without registering it.

Optional `quotaRetry` (for `openai-completions` and `openai-responses` providers) retries matching failures that happen before output starts, with fixed or exponential backoff; the wait is shown as a status and Esc cancels it.

## Catalog filters

The optional root-level `catalogFilters` hides unlisted models of **built-in** (official catalog) providers, independent of `providers` and of pi's own `enabledModels` scoping:

```json
"catalogFilters": {
  "deepseek": ["deepseek-flash"],
  "kimi-coding": ["k3-256k"]
}
```

For each listed provider the extension re-registers it with only the kept models, copying full definitions from the `models-store.json` catalog cache. Authentication, streaming, and catalog refresh stay with the built-in provider layer, and unregistering restores the full built-in list, so nothing is permanently modified. Keep-listed models missing from the cache are skipped with a warning; a provider with no cached catalog data is left untouched.

Rules and caveats:

- Target only built-in catalog providers. Relay providers declared in `providers` are rejected here — use `hidden` on them instead.
- Run `pi update --models` first if the cache is missing or stale.
- After editing `catalogFilters`, restart pi (a plain `/reload` may not undo a removed filter).

## Notes

- Invalid config never blocks pi: the extension logs an error and registers nothing
- Unknown root/provider keys only produce startup warnings, so companion extensions (e.g. relay-balance) can read extra fields from the same file
- Relay error bodies are passed through, but API-key-like tokens are redacted before display
- To make a relay model the default, set `defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json` (pi core settings)
