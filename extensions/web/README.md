# web

Adds two LLM-callable tools backed by `curl` (8.4+ required on PATH):

- `web_search` — search via pluggable providers, tried in configured order until one answers; no API key required
- `web_fetch` — fetch a URL and return readable, tag-stripped text (follows up to 5 redirects)

```
1. pi coding agent — GitHub
   https://github.com/earendil-works/pi-coding-agent
   A terminal coding agent with extensions ...
```

## Configure

`~/.pi/agent/web.json` (everything optional; defaults shown):

```json
{
  "searchProviders": ["duckduckgo", "bing"]
}
```

Provider entries are strings for the keyless built-ins (`"duckduckgo"`, `"bing"`), or an object for a self-hosted [SearXNG](https://github.com/searxng/searxng) instance:

```json
{ "id": "searxng", "endpoint": "https://searxng.example.com", "basicAuth": "$SEARXNG_AUTH" }
```

`basicAuth` may be a literal `user:password` or a `$ENV_VAR` reference. Array order is the fallback order; the first provider that answers is reused for the rest of the session. A provider that errors or returns no parseable results falls through to the next. To serve JSON, SearXNG needs `formats: [html, json]` in its `settings.yml` — and don't expose an instance without auth.

Optional fetch relay for unreachable sites:

```json
"fetchRelay": { "endpoint": "https://fetch-relay.example.com", "token": "$FETCH_RELAY_TOKEN" }
```

When `web_fetch` fails at the transport level (timeout, connection reset), it retries once through `GET {endpoint}?url={target}` with a bearer token and pipes the body through the same pipeline. A ready-made Cloudflare Worker relay script lives in [config-examples/fetch-relay-worker.js](../config-examples/fetch-relay-worker.js).

## Notes

- SSRF protection: fetches block loopback/private/reserved addresses, and DNS results are pinned in curl (`--resolve`) so a rebinding race cannot swap the address after validation. Proxies are forcibly disabled so validation cannot be bypassed.
- The SearXNG endpoint must resolve to a public address; LAN instances are rejected by the SSRF guard. Plain-HTTP endpoints are allowed for self-hosted instances, but pair basicAuth with HTTPS whenever possible — credentials over plain HTTP travel in cleartext.
- Responses are capped (1 MiB readable text) and control sequences are stripped before reaching the UI.
- DuckDuckGo is unreachable from some restrictive networks; the default order falls back to Bing automatically after a one-time ~12s timeout.
