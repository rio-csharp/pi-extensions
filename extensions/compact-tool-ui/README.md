# compact-tool-ui

Compacts the conversation rendering of pi's built-in tools and adds live activity feedback:

- **built-in-tools** — overrides the default renderers for tools like `read`/`bash`/`edit` into single-line summaries
- **thinking-renderer** — rolling display of the model's thinking output
- **working-status** — a live status line while the agent is working

## Notes

- No configuration
- Overrides built-in tool renderers, so don't combine with other extensions that re-render the same built-in tools
