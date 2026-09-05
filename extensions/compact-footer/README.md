# compact-footer

Replaces pi's default footer with a single compact line:

```
~/project (main) · 42.3%/200k · $72.87 · (ai-pixel) gpt-5.6-sol · high
```

Left to right: cwd (home-relative) + git branch + session name, context usage (warning color above 70%, error above 90%), inline statuses published by other extensions, and the active model with its thinking level.

## Status conventions

Other extensions publish text through pi's `setStatus()` API; this footer never fetches anything itself.

- Keys in `INLINE_STATUS_KEYS` (`relay-balance`, `kimi-usage`) render inline on the main line
- Keys starting with `footer-row-` each get a dedicated line below
- Everything else shares one compact line at the bottom

## Notes

- Untrusted status text is sanitized (control sequences stripped); only pi theme colors survive
- Only one extension may own the footer — don't combine with another footer extension
