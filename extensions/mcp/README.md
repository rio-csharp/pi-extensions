# mcp

Connects remote Streamable HTTP MCP servers and exposes their tools to pi, with OAuth, bearer-token, or no authentication.

## Install

This extension has runtime dependencies. After copying this directory:

```sh
cd extensions/mcp && npm ci --omit=dev
```

## Configuration

`~/.pi/agent/mcp-config.json` (see [config-examples](../../config-examples/) for the file structure). Servers can be scoped `user` or `project`.

## Notes

- Use the `/mcp` command to manage servers and start OAuth flows
- OAuth tokens are stored in `~/.pi/agent/.credentials.json`
- Remote server responses are sanitized before they reach the UI
