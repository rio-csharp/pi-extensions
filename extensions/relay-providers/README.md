# relay-providers

Registers manually configured providers and models from `~/.pi/agent/relay-providers.json`, so relays (OpenAI-compatible gateways, etc.) appear in pi's model picker alongside built-in providers.

## Configuration

The config file is local-only — never commit it. See [config-examples](../../config-examples/) for the structure.

Per provider: `id`, `baseUrl`, `apiKey` (literal, `$ENV_VAR`, or a trusted local `!command`), `api` (a built-in pi API family such as `openai-completions` or `openai-responses`), and `models[]`. `hidden: true` on a provider or model keeps it in the file without registering it.

Optional `quotaRetry` (only for `openai-completions` providers) retries matching failures that happen before output starts, with fixed or exponential backoff; the wait is shown as a status and Esc cancels it.

## Notes

- Invalid config never blocks pi: the extension logs an error and registers nothing
- Unknown root/provider keys only produce startup warnings, so companion extensions (e.g. relay-balance) can read extra fields from the same file
- Relay error bodies are passed through, but API-key-like tokens are redacted before display
- To make a relay model the default, set `defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json` (pi core settings)
