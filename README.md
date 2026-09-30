# pi-extensions

Standalone extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Each one is self-contained: copy or hardlink its directory into `~/.pi/agent/extensions/` and `/reload` pi.

## Extensions

- [compact-footer](extensions/compact-footer/) — one-line status footer (pure renderer)
- [compact-tool-ui](extensions/compact-tool-ui/) — compact tool-call and thinking rendering
- [keep-model-on-new](extensions/keep-model-on-new/) — carries the active model into `/new` sessions
- [kimi-usage](extensions/kimi-usage/) — built-in Kimi usage percentages as a status
- [mcp-sanitize](extensions/mcp-sanitize/) — strips hostile characters from built-in MCP tool results
- [relay-balance](extensions/relay-balance/) — active relay provider's balance as a status
- [relay-providers](extensions/relay-providers/) — registers providers/models from local config
- [subagent](extensions/subagent/) — background pi subprocesses with supervision
- [web](extensions/web/) — configurable web_search / web_fetch tools

Example configs live in [config-examples](config-examples/).

## Development

`npm run check` — typecheck all extensions and run security tests.

## License

MIT, see [LICENSE](LICENSE).
