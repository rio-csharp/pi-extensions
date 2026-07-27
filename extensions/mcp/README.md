# MCP Extension for Pi

A Pi extension that connects remote Model Context Protocol servers through the standard Streamable HTTP transport.

## Features

- Official `@modelcontextprotocol/sdk` client
- Standard MCP JSON-RPC over Streamable HTTP
- User-scoped and project-scoped server configuration
- OAuth 2.1 authorization-code flow with PKCE
- Persistent OAuth identity with refresh-token renewal
- Dedicated `~/.pi/agent/.credentials.json` credential store
- Bearer-token authentication
- Automatic tool and resource discovery
- Immediate tool deactivation when a server is disabled or removed
- Cached tool restoration during `/reload`
- Background MCP reconnection during `/reload`
- Paginated tool and resource discovery
- Secure configuration-file permissions

Only Streamable HTTP is currently supported. Stdio servers are not supported.

## Installation

The extension is auto-discovered from:

```text
~/.pi/agent/extensions/mcp/index.ts
```

Install its dependencies from the extension directory:

```bash
npm install
```

Reload Pi after changing the extension:

```text
/reload
```

## Quick start

Add an OAuth-protected user-scoped server:

```text
/mcp add --transport http --scope user cafe https://api.codes.cafe/mcp --auth oauth
```

If authentication is required, Pi asks whether to open the browser. Authentication can also be started explicitly:

```text
/mcp auth cafe
```

Inspect the connection:

```text
/mcp list --details
```

## Commands

### List servers

```text
/mcp
/mcp list
/mcp list --details
```

The detailed view includes configuration paths, scope, authentication type, connection state, discovered tool count, resource count, and the most recent error.

### Add a server

```text
/mcp add --transport http --scope <user|project> <name> <url> [options]
```

Options:

- `--auth none` — no authentication; this is the default.
- `--auth oauth` — use OAuth discovery and PKCE.
- `--auth bearer` — use a bearer token.
- `--oauth-scope <scope>` — request an explicit OAuth scope.
- `--token <token>` — set an initial bearer token.

Examples:

```text
/mcp add --transport http --scope user public https://example.com/mcp
/mcp add --transport http --scope user cafe https://api.codes.cafe/mcp --auth oauth
/mcp add --transport http --scope project internal https://example.com/mcp --auth bearer
```

For bearer authentication, prefer entering the token interactively instead of including it in command text:

```text
/mcp auth internal
```

### Connect or refresh discovery

```text
/mcp connect <name>
```

This reconnects the server and refreshes its cached tools and resources.

### Authenticate

```text
/mcp auth <name>
```

- Bearer servers prompt for a token.
- Other servers are switched to OAuth and start the browser authorization flow.

### Enable or disable

```text
/mcp enable <name>
/mcp disable <name>
```

Disabling a server closes its connection and immediately deactivates its tools while retaining its configuration.

### Remove

```text
/mcp remove <name>
```

Removal closes the connection, deactivates the tools, and persists immediately. Removing the final server correctly writes an empty `servers` object; `/reload` is not required.

### Test an endpoint

```text
/mcp-test <url>
```

Typical results:

- `Valid MCP endpoint; authentication is required` — the endpoint is valid; add it with OAuth or bearer authentication.
- `Valid MCP endpoint: N tools, M resources` — the endpoint connected successfully.
- `MCP test failed: ...` — inspect the message for URL, TLS, network, or protocol errors.

## Configuration scopes

### User scope

Stored in:

```text
~/.pi/agent/mcp-config.json
```

User-scoped servers are available in every project.

### Project scope

Stored in:

```text
<project>/.pi/mcp-config.json
```

Project-scoped servers are available only in that project. Use unique server names across active user and project configurations.

A simplified configuration looks like this:

```json
{
  "servers": {
    "example": {
      "name": "example",
      "url": "https://example.com/mcp",
      "transport": "http",
      "scope": "user",
      "enabled": true,
      "authType": "oauth"
    }
  }
}
```

The configuration files store server definitions, discovered tool/resource metadata, connection timestamps, and non-secret OAuth options. Authentication secrets are kept separately in:

```text
~/.pi/agent/.credentials.json
```

The credential store uses a Claude-style `mcpOAuth` map keyed by server name and a hash of the server URL. It contains OAuth client registration, access/refresh tokens, token expiry, PKCE state while authentication is in progress, and cached OAuth discovery metadata. Bearer tokens are stored in the adjacent `mcpBearer` map. Existing credentials embedded in `mcp-config.json` are migrated automatically on startup.

## OAuth behavior

The extension supports the standard MCP OAuth flow:

1. Discover RFC 9728 protected-resource metadata.
2. Discover RFC 8414 or OpenID Connect authorization-server metadata.
3. Dynamically register the OAuth client when supported.
4. Generate a PKCE verifier and authorization request.
5. Open the authorization URL in the browser.
6. Receive the callback on:

   ```text
   http://127.0.0.1:33418/oauth/callback
   ```

7. Exchange the authorization code for access and refresh tokens.
8. Persist identity in `~/.pi/agent/.credentials.json`.
9. Reuse the access token on later Pi sessions and refresh it without opening a browser when it expires.

Pi requests `offline_access` in addition to the MCP resource scopes so compatible authorization servers issue a refresh token. If a server does not issue one, Pi can reuse the access token until it expires but must authenticate interactively again afterward.

If port `33418` is occupied, stop the process using that port and retry `/mcp auth <name>`.

## MCP protocol requirements

A Streamable HTTP MCP server exposes one MCP endpoint, such as:

```text
https://example.com/mcp
```

All operations are JSON-RPC methods sent to that same endpoint. The extension does **not** append REST paths such as:

```text
/tools/list
/tools/call
/resources/list
/resources/read
```

A typical request is conceptually:

```http
POST /mcp
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

An authentication-protected endpoint should return HTTP `401` with a Bearer challenge. OAuth-capable servers should publish protected-resource and authorization-server metadata.

## Tool naming

Discovered tools are registered in Pi using this format:

```text
mcp_<server-name>_<remote-tool-name>
```

Unsupported characters are replaced with underscores.

If a server exposes resources, the extension also registers:

```text
mcp_<server-name>_read_resource
```

## Startup and reload behavior

Pi startup and `/reload` do not wait for MCP network requests:

1. Cached tool definitions are read from the local configuration and registered immediately.
2. Startup or reload returns without waiting for remote servers.
3. Enabled servers reconnect and refresh discovery in the background.
4. A cached tool invoked during reconnection waits for that in-flight attempt instead of starting a duplicate connection.
5. Pending transports are cancelled if another reload, session switch, or shutdown occurs.

Connection, tool-discovery, and resource-discovery requests time out after 15 seconds by default. Set `PI_MCP_REQUEST_TIMEOUT_MS` to a positive millisecond value to override this limit.

## Security

The MCP credential store contains secrets.

- Never commit `~/.pi/agent/.credentials.json` or a legacy configuration containing OAuth/bearer tokens.
- Prefer `/mcp auth <name>` over placing a token in command text.
- Project configuration no longer contains newly entered credentials; legacy embedded credentials are migrated automatically.
- The extension applies mode `0600` on Unix-like systems to both configuration and credential files.
- On Windows, it restricts both files' ACLs to the current user, SYSTEM, and Administrators.
- Review MCP servers before enabling their tools; MCP tools can perform remote actions.

## Troubleshooting

### HTTP 404 on `/tools/list`

The client or server is using an incorrect REST-style path. Configure the actual MCP endpoint, such as `https://example.com/mcp`, and let the SDK send `tools/list` as a JSON-RPC method.

### HTTP 401 or authentication required

Run:

```text
/mcp auth <name>
```

Then inspect the server with:

```text
/mcp list --details
```

### Server reappears after removal

The current implementation persists an empty configuration when the final server is removed. Run `/mcp remove <name>`, then verify with `/mcp list --details`. If it still appears, check whether a server with the same name exists in the other scope.

### Tools are temporarily unavailable after reload

Cached tools are restored immediately. The underlying connection still refreshes in the background, so calls made before reconnection completes may report that the server is not connected. Wait for the connection notification or run:

```text
/mcp connect <name>
```

### OAuth callback cannot start

Check whether another process is using `127.0.0.1:33418`, stop it, and retry authentication.

### Validate the extension

Run the TypeScript check from this directory:

```bash
npm test
```
