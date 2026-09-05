# Pi Extensions

A collection of independent extensions and agent definitions for the [Pi agent harness](https://github.com/earendil-works/pi).

These extensions target the `@earendil-works/pi-*` packages published from that upstream repository. This repository is an independent extension collection, not the upstream Pi project. Substantial portions are adapted from Pi's official extension examples; see [Upstream derivation and license](#upstream-derivation-and-license). The extensions are intentionally distributed as ordinary files, not as an npm or Pi package; copy only the folders you want into your local Pi directory.

> **Security:** Pi extensions execute with the full permissions of the Pi process. Review every extension before using it. The MCP and subagent extensions can start processes or perform remote operations.

## Included

### `compact-tool-ui`

Compact timestamped rendering for built-in tools. Invocation rows are capped at three display lines, tool results stay hidden, and running calls show a spinner, elapsed time, and shell output-line counts.

This extension overrides the built-in tool definitions for `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls` only for rendering/execution delegation. It does not replace the underlying tool behavior.

### `web`

Adds two keyless web tools:

- `web_search` — DuckDuckGo HTML search
- `web_fetch` — fetches a public HTTP/HTTPS page and converts it to readable text

The web tools apply destination and transfer-size safeguards. Search queries and requested URLs are still disclosed to the relevant remote service. The web extension has its own renderer and does not depend on `compact-tool-ui`.

### `subagent`

Runs specialized subagents in isolated Pi subprocesses with background supervision enabled by default. A call returns a job ID immediately; completion or interruption is delivered automatically, and `subagent_jobs` can steer running children or list, inspect, cancel, and resume persisted child sessions. Synchronous execution remains available with `background: false`.

Live progress is published through `setStatus()` and includes the agent name, active model, elapsed time, token usage, and cost. The extension does not call `setFooter()`, remains compatible with `compact-footer`, and uses the `subagent-status-*` status-key prefix. See [`extensions/subagent/README.md`](./extensions/subagent/README.md) for modes, limits, and security details.

### `compact-footer`

Renders a compact single-line footer (`path/branch · context% · balance/usage · model`). It is a pure renderer: it performs no network requests and reads no provider configuration. Balance/usage text is published by `relay-balance` and `kimi-usage` through Pi's public status API and rendered inline; every other extension status is sanitized and shown on its own line below.

### `relay-providers`

Registers manually configured providers and models from the user's local `relay-providers.json`; entries can be kept hidden, and compatible relays can opt into bounded, cancelable pre-output quota retries. It owns the shared config file: unknown root/provider keys only produce warnings, so companion extensions (such as `relay-balance`) can define their own fields in the same file.

The repository contains no user relay-provider IDs, endpoints, model catalogs, or credential values. The checked-in example is provider-neutral.

### `relay-balance`

Companion to `relay-providers`: looks up the active model's provider in the same `relay-providers.json`, polls `GET {baseUrl}/usage` with its apiKey, and publishes the balance (e.g. `$72.87`) via `setStatus()` under the `relay-balance` key for compact-footer. Only the generic `{ remaining|balance, unit }` response shape is supported; refreshes happen on session start, model switches, and a 5-minute timer.

### `kimi-usage`

Polls the official usage endpoint of Pi's built-in `kimi-coding` provider and publishes 5-hour/weekly usage percentages via `setStatus()` for compact-footer to render inline. The credential is resolved through Pi's built-in auth (`auth.json` OAuth/api key or `KIMI_API_KEY`), and refreshes happen on session start, model switches, and throttled post-agent polls.

### `mcp`

Connects remote Streamable HTTP MCP servers, supports OAuth/bearer authentication, and exposes discovered tools. After copying this extension, run `npm ci --omit=dev` in `extensions/mcp/` before starting Pi.

## Local-only components

Private extensions and provider- or model-pinned agent definitions are intentionally excluded. Keep local agents in `~/.pi/agent/agents/` unless they are deliberately made portable.

## Requirements

- Pi coding agent `0.84.4` or a compatible newer release
- Node.js `22.19.0` or newer
- `curl` on `PATH` when using the `web` extension
- `npm` when installing the MCP extension

## Installation

Install from a clean clone. The commands below export Git's tracked `HEAD` tree first, so ignored or untracked development artifacts cannot be copied and exclusions cannot accidentally match only a leaf name. Review local uncommitted work separately; it is intentionally not installed. Keep the exported root `LICENSE` and `NOTICE` with redistributed copies. If you copy an extension directory alone, also copy those two files alongside it.

### Windows PowerShell

From the repository root:

```powershell
$Agent = "$HOME\.pi\agent"
$Export = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-extensions-" + [guid]::NewGuid())
$Archive = Join-Path $Export "source.zip"
New-Item -ItemType Directory -Force $Export, "$Agent\agents", "$Agent\extensions" | Out-Null
try {
    git archive --format=zip --output=$Archive HEAD
    if ($LASTEXITCODE -ne 0) { throw "git archive export failed" }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Export
    Remove-Item -LiteralPath $Archive -Force
    Get-ChildItem "$Export\agents" -Force | Copy-Item -Destination "$Agent\agents" -Recurse -Force
    Get-ChildItem "$Export\extensions" -Directory | ForEach-Object {
        $Target = Join-Path "$Agent\extensions" $_.Name
        New-Item -ItemType Directory -Force $Target | Out-Null
        Get-ChildItem $_.FullName -Force | Copy-Item -Destination $Target -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $Export "LICENSE") -Destination $Target -Force
        Copy-Item -LiteralPath (Join-Path $Export "NOTICE") -Destination $Target -Force
    }
} finally {
    Remove-Item $Export -Recurse -Force -ErrorAction SilentlyContinue
}
```

Install MCP's pinned third-party dependencies if you want to use it:

```powershell
Push-Location "$Agent\extensions\mcp"
npm ci --omit=dev
Pop-Location
```

### macOS/Linux

```bash
AGENT="$HOME/.pi/agent"
EXPORT="$(mktemp -d)"
trap 'rm -rf "$EXPORT"' EXIT
git archive --format=tar HEAD | tar -xf - -C "$EXPORT"
mkdir -p "$AGENT/agents" "$AGENT/extensions"
cp "$EXPORT"/agents/*.md "$AGENT/agents/"
for extension in "$EXPORT"/extensions/*/; do
  name="$(basename "$extension")"
  mkdir -p "$AGENT/extensions/$name"
  cp -R "$extension". "$AGENT/extensions/$name/"
  cp "$EXPORT/LICENSE" "$EXPORT/NOTICE" "$AGENT/extensions/$name/"
done
(cd "$AGENT/extensions/mcp" && npm ci --omit=dev)
```

Run `/reload` in Pi after copying the files.

## Contributor validation

The repository root and the standalone MCP extension have separate lockfiles. Install both development dependency sets before running the release checks:

```bash
npm ci
npm --prefix extensions/mcp ci
npm run check
npm run audit
npm audit
npm --prefix extensions/mcp audit
```

`npm run audit` is the release gate and audits production dependencies at both levels; it must stay clean. The two full-tree commands also report development dependencies and are expected to stay clean.

## Development setup with junctions

To avoid maintaining a separate runtime copy and repository copy, this checkout can be the source of truth. On Windows, create directory junctions from selected extension paths under `~/.pi/agent/extensions/` to matching repository paths. Pi then runs exactly the extension files tracked by Git.

Do **not** junction the entire `~/.pi/agent/agents/` directory when it also contains provider-specific or otherwise private agents. A directory junction makes every local agent appear inside the repository working tree. Keep `~/.pi/agent/agents/` as a real local directory and copy or link only intentionally public definitions such as `agents/general.md` into it.

Junctions keep linked runtime files and the local Git working tree synchronized, but they do not publish changes automatically. From your clone's repository root, review and publish local changes explicitly:

```powershell
Set-Location <path-to-your-pi-extensions-clone>
git diff
.\scripts\publish.ps1 "Describe the extension changes"
```

Publishing is intentionally two-phase and requires Windows PowerShell 5.1 or newer. The script requires a clean index, exactly one expected `origin` fetch URL and push URL (or an explicitly supplied and independently verified `-ExpectedRemote`), synchronized `main`/`HEAD` with no pre-existing outgoing commits, the required lockfiles and obsolete-file deletion in the release delta, clean root and MCP installs/checks, clean production audits, and only the narrowly acknowledged root dev advisory described above. It explicitly rejects `k12-general` and symlinks, scans staged index blobs—not mutable working-tree files—for private state and common credential patterns, and then records and displays the staged tree before doing anything irreversible. Inspect `git diff --cached`; only typing `PUBLISH` after reviewing that exact tree creates one commit and pushes it. Cancellation or pre-commit failure restores the initially clean index while retaining working-tree changes where practical. Automated checks are safeguards, not substitutes for review.

## Agent definitions

The repository includes only provider-neutral, portable agent definitions. Install them into the user-level agent directory:

```powershell
New-Item -ItemType Directory -Force "$HOME\.pi\agent\agents" | Out-Null
Copy-Item .\agents\*.md "$HOME\.pi\agent\agents\" -Force
```

A locally pinned agent may select a relay model in YAML frontmatter:

```markdown
---
name: local-general
description: General-purpose local coding agent.
model: your-local-provider/your-model
---
```

Keep definitions like this local when the provider or model is specific to your private relay configuration. The subagent extension discovers user agents from `~/.pi/agent/agents/*.md`; project agents under `.pi/agents/*.md` are loaded only when the requested `agentScope` allows them.

## Configuration examples

Examples are in `config-examples/`. They are safe templates only:

- `relay-providers.example.json`
- `mcp-config.example.json`
- `settings.example.json`

Do not blindly overwrite existing configuration. Merge the fields you need into your local files.

### Relay providers

The relay-provider configuration example does not include any specific relay. It uses placeholder values only. Copy and edit locally:

```powershell
Copy-Item .\config-examples\relay-providers.example.json "$HOME\.pi\agent\relay-providers.json"
```

Set the referenced environment variable (for example `YOUR_PROVIDER_API_KEY`) or replace the placeholder locally. Prefer environment-variable references over literal credentials. The real `relay-providers.json` must never be committed.

Balance checks are handled by the separate `relay-balance` extension (generic `GET {baseUrl}/usage` probes against providers from the local config). Compatible OpenAI-style relays can also opt into bounded quota retries, which occur only before output starts and remain cancelable. See the provider-neutral examples for the available fields. Do not add real credentials to this repository.

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
- `subagent` has its own timeline, background supervisor, job-management tool, and status publisher.
- No extension imports another extension's source files.
- `compact-footer` is a pure footer renderer; `relay-balance`, `kimi-usage`, and `subagent` communicate with it only through Pi's public status API: `setStatus()`.
- Relay extensions contain no user relay-provider configuration; built-in balance/usage adapters are explicitly documented.

You can copy, remove, or modify any extension independently.

## Permissions and behavior

| Extension | Main behavior | Important note |
|---|---|---|
| `compact-tool-ui` | Changes tool rendering | Overrides built-in tool definitions |
| `web` | Performs bounded public-web requests | Sends search queries/URLs to remote services and applies destination safeguards |
| `subagent` | Starts and supervises Pi subprocesses | Child agents inherit local permissions; background jobs can be resumed |
| `compact-footer` | Renders the compact status footer | No network access; sanitizes statuses published by other extensions |
| `relay-providers` | Registers models/providers from local config | Changes the active provider registry; opt-in retries may repeat a request before output starts |
| `relay-balance` | Polls the active relay's balance endpoint | Sends the provider's resolved API key to its `/usage` endpoint |
| `kimi-usage` | Queries the built-in Kimi usage endpoint | Sends provider-scoped Kimi credentials to the official Kimi usage endpoint |
| `mcp` | Connects remote MCP servers | Remote tools may perform actions |

## Private configuration policy

This repository contains no user relay-provider definitions or endpoints, real API keys, OAuth tokens, relay credentials, or MCP credentials. Keep these files local:

```text
~/.pi/agent/auth.json
~/.pi/agent/.credentials.json
~/.pi/agent/relay-providers.json
~/.pi/agent/mcp-config.json
```

If a credential is ever committed accidentally, revoke it immediately and rewrite Git history before making the repository public.

## Upstream derivation and license

Substantial portions of the compact tool rendering and subagent extensions are derived from and adapted from the official [Pi extension examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions), with repository-specific changes and additional functionality. Pi is maintained by Earendil Works; its upstream code and examples retain Mario Zechner's 2025 MIT notice.

This repository is MIT-licensed. See [LICENSE](./LICENSE) for the combined notices and [NOTICE](./NOTICE) for the upstream license and derivation details. Preserve both files when redistributing the repository or substantial derived portions.
