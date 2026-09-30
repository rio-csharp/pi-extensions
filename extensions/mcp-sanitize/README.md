# mcp-sanitize

Strips hostile characters from the results of the built-in MCP integration's tools (`mcp__*`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) before they reach the model, the UI, or codemode scripts:

- ANSI escape sequences
- terminal control characters (C0/C1)
- zero-width characters (U+200B–U+200F)
- bidi override and isolate characters (U+202A–U+202E, U+2060–U+206F, the Trojan Source vectors)
- BOM (U+FEFF)

Text is NFC-normalized. Newlines, carriage returns, and tabs are kept; nothing is truncated, so codemode scripts still receive full results. `structuredContent` is sanitized alongside `content`, because replacing `content` alone would drop it.

The built-in MCP support already strips ANSI sequences for display; this extension extends that protection to the model-facing content and the invisible-character vectors.

## Install

Copy or hardlink this directory into `~/.pi/agent/extensions/` and `/reload` pi. No configuration.

