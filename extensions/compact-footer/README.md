# compact-footer

Replaces pi's default footer with a single compact line:

```
~/project (main) · 42.3%/200k · $72.87 · (ai-pixel) gpt-5.6-sol · high
```

Left to right: cwd (home-relative) + git branch + session name, context usage (warning color above 70%, error above 90%), inline statuses published by other extensions, and the active model with its thinking level.

## Status conventions

Other extensions publish text through pi's `setStatus()` API; this footer never fetches anything itself.

- Keys in `INLINE_STATUS_KEYS` (`relay-balance`, `kimi-usage`, `opendesign-usage`) render inline on the main line
- Keys starting with `footer-row-` each get a dedicated line below
- Everything else shares one compact line at the bottom

## Long dedicated rows

A dedicated row wider than the terminal scrolls sideways instead of being cut off: 3 columns every 500 ms, looping, and the timer runs only while a row actually overflows.

A publisher can mark where the scrollable part ends with a zero-width space (`U+200B`). Only the text before the marker scrolls; everything after it keeps its exact position, so the fields behind a title never move while it animates. Rows without the marker scroll as a whole.

## Notes

- Untrusted status text is sanitized (control sequences stripped); only pi theme colors survive
- Only one extension may own the footer — don't combine with another footer extension
