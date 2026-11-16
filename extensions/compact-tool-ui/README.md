# compact-tool-ui

Compacts the conversation rendering of pi's tools and adds live activity feedback:

- **built-in-tools** — overrides the default renderers for tools like `read`/`bash`/`edit` into single-line summaries
- **codemode** — the same treatment for `codemode`: one line with the script's first meaningful line and its line count, instead of the whole script
- **thinking-renderer** — rolling display of the model's thinking output
- **working-status** — a live status line while the agent is working

## Expand and collapse

Every compact row still honours pi's expand toggle (`ctrl+o`, or left-clicking the row). A row that has more to show carries a `▸` before its content; expanded rows keep the same header line (now with `▾`) and print the original renderer underneath, so a `read` shows the file, an `edit` shows the diff, a `bash` row shows its output, and `codemode` shows the script, its nested tool calls, the model cost, and the script output. Rows with nothing to expand carry no glyph.

Thinking follows the same visual language, but through pi's own mechanism: with `hideThinkingBlock` enabled, a thinking run collapses into one `▸ thinking` line that expands on click. While thinking streams it is shown as a single rolling line.

## Notes

- No configuration
- Overrides built-in tool renderers, so don't combine with other extensions that re-render the same built-in tools
- `codemode` uses `registerToolRenderer`, so it replaces only the renderers and leaves the runtime's own tool implementation untouched
