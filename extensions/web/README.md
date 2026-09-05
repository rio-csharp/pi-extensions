# web

Adds two LLM-callable tools, no API keys required:

- `web_search` — keyless search via the DuckDuckGo HTML endpoint
- `web_fetch` — fetch a URL and return readable, tag-stripped text (follows up to 5 redirects)

Both are backed by `curl` (8.4+).

## Notes

- SSRF protection: fetches block loopback/private/reserved addresses, and DNS results are pinned in curl (`--resolve`) so a rebinding race cannot swap the address after validation
- Responses are capped (1 MiB readable text) and control sequences are stripped before reaching the UI
