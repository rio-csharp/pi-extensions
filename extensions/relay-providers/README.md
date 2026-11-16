# relay-providers

Registers manually configured providers and models from `~/.pi/agent/relay-providers.json`, so relays (OpenAI-compatible gateways, etc.) appear in pi's model picker alongside built-in providers.

## Configuration

The config file is local-only — never commit it. See [config-examples](../../config-examples/) for the structure.

Per provider: `id`, `baseUrl`, `apiKey` (literal, `$ENV_VAR`, or a trusted local `!command`), `api` (a built-in pi API family such as `openai-completions` or `openai-responses`), and `models[]`. `hidden: true` on a provider or model keeps it in the file without registering it.

Optional `quotaRetry` (for `openai-completions` and `openai-responses` providers) retries matching failures that happen before output starts, with fixed or exponential backoff; the wait is shown as a status and Esc cancels it.

## Model aliases

Some relays ship one upstream model ID per thinking strength (`-low`, `-medium`, `-high`), which floods the picker. `modelAliases` maps thinking levels onto upstream IDs so **one** picker entry covers the whole ladder, selected with `/thinking`:

```json
{
  "id": "gemini-4-carbon",
  "name": "Gemini 4 Carbon",
  "reasoning": true,
  "thinkingLevelMap": { "off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": null, "max": null },
  "modelAliases": { "low": "gemini-4-carbon-low", "medium": "gemini-4-carbon-medium", "high": "gemini-4-carbon-high" }
}
```

The registered ID (`gemini-4-carbon`) is what the picker, session history, and cost accounting see; the request body's `model` field is rewritten to the aliased upstream ID. Notes:

- A model with `modelAliases` **never** sends its registered ID upstream — that ID is synthetic and the relay does not serve it. Every request resolves to one of that model's own alias values. Resolution order is: exact match, then the next weaker configured level, then the next stronger one, then the weakest configured variant. pi never transmits `off` (it sends no level at all), so `off` and an unset level behave identically — both mean "no thinking" and resolve from the `off` entry first. The registered ID is only ever sent by models *without* aliases.
- Levels absent from `modelAliases` **do not** fail validation. They silently resolve to a neighbouring configured variant, so the strength shown by `/thinking` is then not the strength that is sent; config validation warns about those gaps at startup.
- With `modelAliases`, `thinkingLevelMap` values are cosmetic unless the upstream also reads `reasoning_effort`. Keep each listed level non-null so `/thinking` offers it.
- Aliases are rewritten through `onPayload` after any chained hook has run, so a hook that returns `undefined` ("keep the payload unchanged") cannot undo the rewrite. The rewritten field follows the API family: `model` everywhere except `bedrock-converse-stream`, which names it `modelId`.
- The footer keeps showing the picker entry and the thinking level; no resolved upstream ID is published to the UI.

Because the request is built for the picker ID, the caveats live in the model entry, not with the variant actually used:

- `cost` must be the maximum across the aliased variants, otherwise usage accounting under-reports.
- Keep the upstream family prefix in the picker ID where the relay or API gates behaviour on it — for example `anthropic/…` on OpenRouter, which is what enables `cache_control`.
- `/cost`, telemetry, and usage entries all report the picker ID, never the variant that served the request.

Setting a level to `null` in `thinkingLevelMap` marks it unsupported and **hides it from `/thinking`**. Omit the key entirely to keep a level at the provider default.

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
