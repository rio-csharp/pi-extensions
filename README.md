# pi-extensions

Standalone extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Each one is self-contained: copy or hardlink its directory into `~/.pi/agent/extensions/` and `/reload` pi.

## Extensions

- [compact-footer](extensions/compact-footer/) — one-line status footer (pure renderer)
- [compact-tool-ui](extensions/compact-tool-ui/) — compact tool-call and thinking rendering
- [kimi-usage](extensions/kimi-usage/) — built-in Kimi usage percentages as a status
- [mcp](extensions/mcp/) — remote Streamable HTTP MCP servers
- [relay-balance](extensions/relay-balance/) — active relay provider's balance as a status
- [relay-providers](extensions/relay-providers/) — registers providers/models from local config
- [subagent](extensions/subagent/) — background pi subprocesses with supervision
- [web](extensions/web/) — keyless web_search / web_fetch tools

Example configs live in [config-examples](config-examples/).

## Development

`npm run check` — typecheck all extensions and run security tests.

## License

MIT, see [LICENSE](LICENSE).
