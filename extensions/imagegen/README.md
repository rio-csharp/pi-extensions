# imagegen

Adds two LLM-callable tools for an OpenAI-compatible `/v1/images/generations` and `/v1/images/edits` provider, plus the SenseNova `sensenova-u1.x` image API:

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
  "defaultModel": "flare",
  "providers": {
    "ai-pixel": {
      "api": "openai",
      "baseUrl": "https://api.ai-pixel.online/v1",
      "apiKey": "$IMAGEGEN_API_KEY"
    }
  },
  "models": {
    "flare": { "provider": "ai-pixel", "id": "gpt-image-2.6-flare", "quality": "medium" }
  },
  "defaultQuality": "medium",
  "defaultSize": "1024x1024",
  "pricePerImage": 0.02,
  "outputDir": "generated",
  "timeoutSeconds": 600
}
```

`providers` is the whole credential story: one entry per vendor, each with its own `api`, `baseUrl` and `apiKey`. Nothing is inherited between entries and no other file is read — `relay-providers.json` is not consulted at all. `apiKey` accepts a `$ENV_VAR` reference, so no secret has to be stored here; an unset reference counts as missing rather than being used literally.

`baseUrl` must include the API version segment, for example `https://api.ai-pixel.online/v1`. The extension appends the image route to the URL path, preserves query parameters, and discards the fragment.

### Providers

| Key | Meaning |
|---|---|
| `api` | `"openai"` (default) or `"sensenova"` — which request shape and size rules this endpoint speaks. |
| `baseUrl` | Required. The endpoint, including the version segment. |
| `apiKey` | The key for this endpoint. `"$ENV_VAR"` / `"${ENV_VAR}"` is expanded. |

There is no `defaultProvider`: every model entry names its own `provider`, so the default model and the default endpoint cannot disagree. A model without a provider is reported by name rather than guessed onto somebody else's endpoint. A provider with an invalid `baseUrl` is skipped with a warning, and a model pointing at a provider that is not defined is reported by name too.

### Models

`models` maps an alias to a `provider`, a model id, and a **`description` that is sent to the model**, so it can choose the right one on its own:

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

### Two vendors in one file

Each `api` value lives in its own file, and everything that API decides on its own — size rules, request payload, the argument check — is in that file rather than in the tools:

| File | API |
|---|---|
| `dialects/openai.ts` | OpenAI-compatible `/v1/images/generations` and `/v1/images/edits`, JSON for generations and multipart for edits. |
| `dialects/sensenova.ts` | SenseNova `sensenova-u1.x`, JSON only, references inlined as data URLs. |

They implement the contract in `dialects/types.ts`, and `client.ts` holds only transport, retries and response parsing.

Keeping vendors apart is just two provider entries. This is the shape that runs SenseNova beside an OpenAI relay:

```json
{
  "defaultModel": "nova",
  "providers": {
    "ai-pixel": {
      "api": "openai",
      "baseUrl": "https://api.ai-pixel.online/v1",
      "apiKey": "$IMAGEGEN_API_KEY"
    },
    "sensenova": {
      "api": "sensenova",
      "baseUrl": "https://token.sensenova.cn/v1",
      "apiKey": "$SENSENOVA_API_KEY"
    }
  },
  "models": {
    "flare":    { "provider": "ai-pixel",  "id": "gpt-image-2.6-flare",   "quality": "medium" },
    "sunburst": { "provider": "ai-pixel",  "id": "gpt-image-2.6-sunburst", "quality": "high" },
    "nova":     { "provider": "sensenova", "id": "sensenova-u1.6-lite",   "pricePerImage": 0 }
  }
}
```

A key never crosses providers: the `ai-pixel` key cannot reach `token.sensenova.cn`, because a model only ever sees the endpoint and key of the provider it names.

## Parameters

| Parameter | Notes |
|---|---|
| `prompt` | Required, up to 32k characters. Quote text that must appear verbatim and say where it goes. |
| `model` | Alias from `models`, defaults to `defaultModel`. |
| `size` | OpenAI models: `1024x1024`, `1024x1536`, `1536x1024`, `auto`, or `WIDTHxHEIGHT` with multiples of 16, max edge 3840, ≤3:1 ratio, 0.65–8.3 MP. SenseNova models: `auto` or `WIDTHxHEIGHT` with multiples of 32, 512–4096 per side, ≤3:1; recommended `2048x2048`, `2720x1536`, `1536x2720`, `1664x2496`, `2496x1664`, `4096x4096` (4K). Validated locally per dialect. |
| `quality` | `low`, `medium`, `high` (default `medium`), plus `xhigh`/`max` on 2.6. OpenAI models only. |
| `background` | `auto`, `transparent`, `opaque`; transparency needs png/webp. OpenAI models only. |
| `outputFormat` | `png` (default), `jpeg`, `webp`. |
| `compression` | 0–100, jpeg/webp only. OpenAI models only. |
| `moderation` | `auto`, `low`. OpenAI models only. |
| `complexity` | `low`, `medium`, `high` — planning depth on 2.6. OpenAI models only. |
| `watermark` | SenseNova only: draw the official SenseNova logo. Off by default here (the provider's own default is on); pass `true` when the logo is wanted. |
| `promptExtend` | SenseNova only: let the provider enrich the prompt (provider default `true`). |
| `selfCorrection` | SenseNova only: self-correction pass for text accuracy and quality (provider default `true`). |
| `images` | 1–16 reference paths on OpenAI models; 1–5 on SenseNova. Switches to the edit endpoint. |
| `outputDir` | Overrides `outputDir` for one call. |

Passing an argument the selected dialect does not support fails fast with a message naming it, instead of silently sending a field the provider ignores.

`/imagegen` prints the effective configuration.

## SenseNova dialect

Measured against `token.sensenova.cn` on 2026-11-24 with `sensenova-u1.6-lite`:

- **It is a separate images API, not Chat Completions.** `/v1/images/generations` for text-to-image and `/v1/images/edits` for image-to-image; the model id is also listed by `/v1/models` with `output_modalities: ["image"]`.
- **Edits are JSON, not multipart.** `{"images": [{"image_url": "data:image/png;base64,..."}]}`, first image is the primary edit target, at most five per request. Local files are read from disk and inlined as data URLs, so no upload endpoint is involved.
- **`response_format` defaults to `b64_json`** and the extension always requests that. The alternative, `url`, returns a signed link that expires after 24 hours; the tool refuses a URL-only response rather than saving a link that will rot.
- **`size` is either `auto` or `WIDTHxHEIGHT`** with multiples of 32, 512–4096 per side, at most 3:1. Recommended: `2048x2048` (1:1 2K), `2720x1536` (16:9 2K), `1536x2720` (9:16 2K), `1664x2496` (2:3 2K), `2496x1664` (3:2 2K), `4096x4096` (1:1 4K). `512x512` is legal here even though the OpenAI dialect rejects it.
- **Extra knobs:** `watermark` (the provider defaults to `true`, but this extension sends `false` unless you pass `watermark: true`, because a logo is rarely what was asked for), `prompt_extend` (default `true`), `self_correction` (default `true`). The docs mark watermark-free output as free during public beta and likely to become paid, so the flag is always sent explicitly.
- **`n` only accepts 1**, and there is no `quality`, `background`, `compression`, `moderation`, or `complexity`.
- **Usage is token-based** (`input_tokens`/`output_tokens`, with image tokens counted for edits) and is reported in the result; billing is whatever the plan says, so set `pricePerImage` accordingly (the Token Plan is `0`).
- **Latency:** ~17s for a 2048x2048 generation and ~23s for a 2048x2048 edit in testing. Jobs stay in the same background queue as OpenAI requests.

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
