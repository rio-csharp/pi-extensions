# Pi Extensions

A collection of independent extensions and agent definitions for the [pi coding agent](https://github.com/badlogic/pi-mono).

These are intentionally distributed as ordinary files, not as an npm or Pi package. Copy only the folders you want into your local Pi directory.

> **Security:** Pi extensions execute with the full permissions of the Pi process. Review every extension before using it. The MCP and subagent extensions can start processes or perform remote operations.

## Included

### `compact-tool-ui`

Compact timestamped rendering for built-in tools. Tool results stay hidden and running calls show a spinner, elapsed time, and bash output-line counts.

This extension overrides the built-in tool definitions for `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` only for rendering/execution delegation. It does not replace the underlying tool behavior.

### `web`

Adds two keyless web tools:

- `web_search` — DuckDuckGo HTML search
- `web_fetch` — fetches an HTTP/HTTPS page and converts it to readable text

The web extension has its own renderer and does not depend on `compact-tool-ui`.

### `subagent`

Runs specialized subagents in isolated Pi subprocesses. The conversation shows one start line and one completion/failure line. Live progress is published through `setStatus()` so another footer extension can render it.

The extension does not call `setFooter()` and is compatible with `relay-footer`. Its status keys use the `subagent-status-*` prefix.

### `relay-footer`

Shows balance/quota information in a compact footer. It reads provider definitions and credentials only from the user's local `relay-providers.json`; the repository contains no provider names, models, endpoints, or credentials. It also supports Kimi usage from the local `auth.json`.

### `relay-providers`

Registers manually configured providers and models from the user's local `relay-providers.json`. The repository contains only generic provider-loading code and a provider-neutral example.

### `mcp`

Connects remote Streamable HTTP MCP servers, supports OAuth/bearer authentication, and exposes discovered tools. After copying this extension, run `npm install` in `extensions/mcp/` before starting Pi.

## Not included

The following local extensions are intentionally excluded:

- `cheap-claude-retry`
- `grok-retry`

## Installation

### Windows PowerShell

From the repository root:

```powershell
$Agent = "$HOME\.pi\agent"
New-Item -ItemType Directory -Force "$Agent\agents", "$Agent\extensions" | Out-Null
Copy-Item .\agents\* "$Agent\agents\" -Recurse -Force
Copy-Item .\extensions\* "$Agent\extensions\" -Recurse -Force
```

Install MCP's third-party dependencies if you want to use it:

```powershell
Push-Location "$Agent\extensions\mcp"
npm install
Pop-Location
```

### macOS/Linux

```bash
AGENT="$HOME/.pi/agent"
mkdir -p "$AGENT/agents" "$AGENT/extensions"
cp -R agents/. "$AGENT/agents/"
cp -R extensions/. "$AGENT/extensions/"
(cd "$AGENT/extensions/mcp" && npm install)
```

Run `/reload` in Pi after copying the files.

## Development setup with junctions

To avoid maintaining a separate runtime copy and repository copy, this checkout can be the source of truth. On Windows, create directory junctions from selected paths under `~/.pi/agent/` to the matching repository paths. Pi then runs exactly the files tracked by Git.

Junctions keep the runtime and local Git working tree synchronized, but they do not publish changes automatically. Review and publish local changes explicitly:

```powershell
Set-Location D:\Development\pi-extensions
.\scripts\publish.ps1 "Describe the extension changes"
```

The publish script fetches `origin`, refuses to push when the remote branch is ahead, checks staged paths and common credential patterns, commits pending changes, and pushes `main`. Always inspect `git diff` as part of your review; automated secret checks are only a safeguard.

## Configuration examples

Examples are in `config-examples/`. They are safe templates only:

- `relay-providers.example.json`
- `mcp-config.example.json`
- `settings.example.json`

Do not blindly overwrite existing configuration. Merge the fields you need into your local files.

### Relay providers

The repository does not include any specific provider. The example uses placeholder values only. Copy and edit locally:

```powershell
Copy-Item .\config-examples\relay-providers.example.json "$HOME\.pi\agent\relay-providers.json"
```

Then replace every `PASTE_...` value with your own credentials. The real `relay-providers.json` must never be committed.

For a provider whose balance endpoint is not `/usage`, the local provider entry may use generic custom balance fields supported by your local configuration. Do not add real credentials to this repository.

### MCP

Copy the example only if you need a starting point:

```powershell
Copy-Item .\config-examples\mcp-config.example.json "$HOME\.pi\agent\mcp-config.json"
```

For OAuth or bearer authentication, credentials are stored locally in:

```text
~/.pi/agent/.credentials.json
```

Never commit that file.

## Independence

Each extension is self-contained:

- `compact-tool-ui` has its own renderer.
- `web` has its own renderer.
- `subagent` has its own timeline and status publisher.
- No extension imports another extension's source files.
- `relay-footer` and `subagent` communicate only through Pi's public status API: `setStatus()`.
- Relay extensions contain no specific provider configuration; all provider data comes from the user's local file.

You can copy, remove, or modify any extension independently.

## Permissions and behavior

| Extension | Main behavior | Important note |
|---|---|---|
| `compact-tool-ui` | Changes tool rendering | Overrides built-in tool definitions |
| `web` | Performs web requests | Can fetch arbitrary HTTP/HTTPS URLs |
| `subagent` | Starts Pi subprocesses | Child agents inherit the available local permissions |
| `relay-footer` | Queries configured balance endpoints and Kimi usage | Reads credentials only from local files |
| `relay-providers` | Registers models/providers from local config | Changes the active provider registry |
| `mcp` | Connects remote MCP servers | Remote tools may perform actions |

## Private configuration policy

This repository contains no provider definitions, provider endpoints, real API keys, OAuth tokens, relay credentials, or MCP credentials. Keep these files local:

```text
~/.pi/agent/auth.json
~/.pi/agent/.credentials.json
~/.pi/agent/relay-providers.json
~/.pi/agent/mcp-config.json
```

If a credential is ever committed accidentally, revoke it immediately and rewrite Git history before making the repository public.

## License

MIT. See [LICENSE](./LICENSE).
