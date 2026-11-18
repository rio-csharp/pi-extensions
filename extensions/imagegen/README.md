# imagegen

Adds two LLM-callable tools for an OpenAI-compatible `/v1/images/generations` and `/v1/images/edits` provider:

- `generate_image` queues a background job and returns a `jobId` immediately. Pi can keep responding while the provider works.
- `imagegen_result` takes a `jobId` and returns the status without waiting. A completed job returns its image, path, and actual dimensions so the model can inspect it or make an edit.

Pi notifies the user with the file path when the job completes (or reports failure), without starting another model turn. Jobs run one at a time per session. The queue accepts up to eight unfinished jobs, and the last eight finished jobs are available to query. These tools are intended for a live TUI or RPC session; new sessions, reload, and exit discard pending work and cancel the active request locally. Already saved images remain on disk.

Example completed result:

```
D:\project\generated\20261118-142033-flare-9f3ac1.png · 1254x1254 · 1812KB
```

## Configure

`~/.pi/agent/imagegen.json` (everything optional; defaults shown):

```json
{
  "provider": "ai-pixel",
  "defaultModel": "flare",
  "defaultQuality": "medium",
  "defaultSize": "1024x1024",
  "pricePerImage": 0.02,
  "outputDir": "generated",
  "timeoutSeconds": 600
}
```

Credentials come from an existing `relay-providers.json` entry when `provider` names one; `baseUrl` and `apiKey` set here override it. Without either, `$IMAGEGEN_BASE_URL` and `$IMAGEGEN_API_KEY` are used. `apiKey` accepts a `$ENV_VAR` reference, so no secret has to be stored in the file.

`baseUrl` must include the API version segment, for example `https://api.ai-pixel.online/v1`.

### Models

`models` maps an alias to a provider model id plus a **`description` that is sent to the model**, so it can choose the right one on its own:

```json
{
  "models": {
    "flare": {
      "id": "gpt-image-2.6-flare",
      "description": "Fast iteration: quicker, better finished-looking layout; good for drafts.",
      "quality": "medium"
    },
    "sunburst": {
      "id": "gpt-image-2.6-sunburst",
      "description": "Slower but more literal: exact element placement, finer detail, stable edits.",
      "quality": "high"
    }
  }
}
```

Both entries ship as defaults. Aliases you add are appended; `defaultModel` picks the one used when the model omits `model`. A per-entry `quality` becomes that model's default, and a per-entry `pricePerImage` overrides the top-level price. The tool description and the `model` argument description are generated from these entries at extension load, so `/reload` after editing them.

## Parameters

| Parameter | Notes |
|---|---|
| `prompt` | Required, up to 32k characters. Quote text that must appear verbatim and say where it goes. |
| `model` | Alias from `models`, defaults to `defaultModel`. |
| `size` | `1024x1024`, `1024x1536`, `1536x1024`, `auto`, or `WIDTHxHEIGHT` with multiples of 16, max edge 3840, ≤3:1 ratio, 0.65–8.3 MP. Validated locally. |
| `quality` | `low`, `medium`, `high` (default `medium`), plus `xhigh`/`max` on 2.6. |
| `background` | `auto`, `transparent`, `opaque`; transparency needs png/webp. |
| `outputFormat` | `png` (default), `jpeg`, `webp`. |
| `compression` | 0–100, jpeg/webp only. |
| `moderation` | `auto`, `low`. |
| `complexity` | `low`, `medium`, `high` — planning depth on 2.6. |
| `images` | 1–16 reference paths; switches to the edit endpoint. |
| `outputDir` | Overrides `outputDir` for one call. |

`/imagegen` prints the effective configuration.

## Provider quirks this handles

Measured against `api-pixel.online` on 2026-11-18 with `gpt-image-2.6-*`:

- **Unknown parameter values are silently ignored, not rejected.** `size: "bogus"` and `quality: "bogus"` both returned a normal image. Everything is therefore validated locally before the request.
- **Small sizes are rounded up.** `1024x1024` came back as `1254x1254` (the ~1.57 MP bucket), while `1024x1536` and `2048x2048` were honored exactly. The tool reports the real pixel size; do not assume the request was used verbatim.
- **`resolution: "2K"` / `"4K"` is ignored.** Use `size` instead.
- **`output_format` is honored** (jpeg bytes came back for `jpeg`) but the response carries no MIME type, so the format is sniffed from magic bytes and the file extension follows the bytes, not the request.
- **Latency varies a lot:** 45s–155s for generations and up to 264s for an edit. `timeoutSeconds` defaults to 600 and the abort signal is wired through, so a slow call is not mistaken for a hang.
- **Transient `401 Invalid token` under parallel requests.** The background queue runs one request at a time per session, and selected HTTP errors are retried with backoff (up to three attempts total).
- **Token usage is returned but billed per image**, so `usage` carries the provider's token counts with the configured per-image price instead of a catalog estimate. Check the provider dashboard for real spend.

## Cost

`pricePerImage` (USD, default `0.02`) is the configured price for **one generated image**; a model entry may override it. The first successful `imagegen_result` for a completed job reports `pricePerImage × images` in the result header and as `usage.cost.total`, which Pi includes in its footer and `/session` totals. Repeated lookups do not add the charge again. Jobs that are never retrieved do not appear in Pi's totals; check the provider dashboard for actual spend, including requests the provider may finish after local cancellation.

## Notes

- Files are written with `withFileMutationQueue()` and the `wx` flag, so concurrent calls cannot overwrite each other; names are `<timestamp>-<alias>-<random>.<ext>`.
- Reference images are read from disk when the job starts, capped at 32 MB each, and checked for format. Keep reference files in place while the job is queued.
- `imagegen_result` sends a completed image to the model as an image content block. The text block includes the file path and actual pixel size.
