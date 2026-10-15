# Providers

Facts verified against official docs on 2026-10-13. Anything not verified
below is marked **UNVERIFIED**.

## Endpoints, auth, key facts

| Provider | Chat endpoint | Auth | Verified |
|---|---|---|---|
| OpenAI | `POST {base}/chat/completions` (`https://api.openai.com/v1`) | `Authorization: Bearer` | [Chat docs](https://platform.openai.com/docs/api-reference/chat) 2026-10-13 |
| Anthropic | `POST {base}/v1/messages` (`https://api.anthropic.com`) | `x-api-key` + `anthropic-version: 2023-06-01` | [Messages docs](https://docs.anthropic.com/en/api/messages) 2026-10-13 |
| Gemini | `POST {base}/v1beta/openai/chat/completions` (OpenAI-compat) | `Authorization: Bearer` | **UNVERIFIED** (compat page did not render; path mirrors prior code) |
| Compatible | `POST {base}/chat/completions` (default `http://localhost:11434/v1`) | `Bearer` when a key is set, omitted otherwise | **UNVERIFIED** (server-dependent: Ollama/LM Studio/vLLM) |

## Per-provider behavior

- **OpenAI**: newer reasoning models (`o1`/`o3`/`gpt-5`/`gpt-6` family) use
  `developer` instead of `system` ([docs](https://platform.openai.com/docs/api-reference/chat) 2026-10-13),
  want `max_completion_tokens`, and reject sampling params — the adapter's
  regex→caps table encodes this; unknown models get the conservative default
  (`max_completion_tokens`, temperature sent only when set). `gpt-6-luna` /
  `gpt-6-sol` tool calls force `reasoning_effort: 'none'`; other models send
  `reasoning_effort` only when tools are present and the caller sets it
  ([GPT-6 Sol and Luna intro](https://openai.com/index/introducing-gpt-6-sol-and-luna/),
  [October 2026 update PDF](https://cdn.openai.com/pdf/gpt-6-october.pdf) 2026-10-07).
  Streaming sends `stream_options: {include_usage: true}`.
- **Anthropic**: `max_tokens` is **required**; system prompt is top-level
  `system` (no `system` role in messages); only `user`/`assistant` roles;
  tools use `input_schema`, results come back as `tool_use` blocks and stream
  as `content_block_delta` events; temperature+`top_p` together is rejected,
  so temperature wins ([docs](https://docs.anthropic.com/en/api/messages) 2026-10-13).
- **Gemini**: native request shape uses `generationConfig` /
  `systemInstruction` with a thinking budget — **UNVERIFIED** for the native
  API; Nexio uses the OpenAI-compat endpoint, so the adapter mirrors the
  OpenAI shape and marks thinking models reasoning-aware (small limits, no
  sampling assumptions).
- **Compatible**: limit param `auto` (defaults `max_tokens`, retry swaps on
  400/422); temperature sent only when set — turn it off per-provider with
  `sendTemperature: false` in settings (Settings shows the toggle for Custom);
  tools are always offered but text-only replies are accepted (tool detection
  fallback for servers without tool support).

**UNVERIFIED list**: Gemini native `generationConfig`/`systemInstruction`/
thinking-budget fields; Gemini compat `/v1beta/openai/models` listing path;
exact `max_tokens` vs `max_completion_tokens` support per OpenAI model (retry
auto-corrects); Anthropic list-models (none exists — suggestions skipped);
rate-limit header names per provider (`Retry-After` honored generically);
precise sampling-combo rejections per Anthropic/Gemini model.

## Recovery (retry.ts)

- `400`/`422` with a param-shaped error: drop/swap **once**
  (`temperature`, `top_p`, `top_k`, `stop`, `stream_options`,
  `response_format`, `reasoning`, `stop_sequences`, `tool_choice`, limit swap),
  cached per provider/base URL/model for 30 days (in-memory — forgotten on
  restart, re-learned on next 400/422). **Reset fixes** button clears it.
- `429`/`5xx`: up to 2 backoffs honoring `Retry-After` + jitter,
  non-streaming only. Streaming never replays output.
- Debug log records param names + action only — never keys or bodies.

## Errors

Normalized kinds (`src/main/ai/errors/provider-error.ts`): `auth`,
`forbidden`, `model_not_found`, `unsupported_parameter`, `context_too_long`,
`content_filtered`, `rate_limited`, `quota_exceeded`, `overloaded`,
`bad_request`, `network`, `timeout`, `aborted`, `unknown`. Each carries a
friendly message + user action; technical detail is redacted and truncated to
500 chars for the log/Details view. A failed run stops with the error — never
a placeholder answer.

## Attachments (native file input + refusal notices)

Neutral requests carry `text` / `image` / `document` / `file_ref` parts
(`src/main/ai/providers/types.ts`, `vision.ts`, `attachments.ts`).
`getAttachmentCapabilities(provider, model)` is the per-provider map:
images + PDF are `native`, everything else `unsupported`, with per-file
and per-request size caps (base64 inflation counted) and documented page
caps where published.

| Provider | Mapping | Caps |
|---|---|---|
| OpenAI | `text` blocks + `image_url: {url: dataUrl}`; PDFs as Chat Completions `file` parts (`filename` + base64 `file_data`); `file_ref` → text only | vision on vision models, 5 imgs / 20MB / 2048px / png·jpeg·gif·webp ([Vision docs](https://platform.openai.com/docs/guides/vision) 2026-10-13); **Chat Completions file shape UNVERIFIED beyond unit tests** |
| Anthropic | `text` + `image/source base64` blocks; PDFs as Messages `document` blocks (`base64` source); `file_ref` → text only; system stays top-level | same image caps ([Vision docs](https://docs.anthropic.com/en/docs/build-with-claude/vision) 2026-10-13); PDFs 32MB request / 100 pages under 1M context, 600 above ([PDF docs](https://docs.anthropic.com/en/docs/build-with-claude/pdf-support) 2026-10-15); plain text also fits document blocks, `.docx`/`.xlsx` do not |
| Gemini | OpenAI-compat shape, same as OpenAI | same caps ([Vision docs](https://ai.google.dev/gemini-api/docs/vision) 2026-10-13 — endpoint mapping **UNVERIFIED** beyond the compat path) |
| Compatible | OpenAI-compat shape; `compatibleImages` setting: `auto` (probe, default) / `on` / `off` | images only when vision-capable; every file type is `unsupported` (same caps; local vision support is server-dependent ([Ollama vision models](https://ollama.com/blog/vision-models) — per-server support **UNVERIFIED**)) |

Rules:

- Images keep the shared pipeline (EXIF-strip, 2048px cap — sanitizing,
  not OCR). Plain text files (`text/*`, json, md, csv, code) send inline
  as UTF-8 with BOM decoding and secrets masking; the 200KB truncation
  stays and the sent text carries its `[truncated to 200KB]` marker.
- Unencrypted PDFs send as the original bytes in the provider's native
  document input — no text-layer extraction, no OCR (the old pdf.js +
  tesseract worker is deleted, dependencies removed).
- Oversize/overcount/over-request-cap throws inline naming the hit limit
  (never silent). Non-vision models throw `VisionNotSupportedError`
  **before** any request is built, so image bytes are never sent and never
  fail silently — the UI shows
  "This model does not support images. Switch model to send images — image
  bytes were not sent." with a one-click "Switch model" that recovers once.
- Provider-unsupported types (Office, media, archives on most providers)
  throw `UnsupportedAttachmentError` **before** any request is built —
  bytes never sent. The chip shows an "Unsupported" badge and the UI shows
  "<provider> can't read .docx directly" with the same one-click
  "Switch model" flow (confirm first, re-attach after switching).
  Opt-in `localTextFallback` (Settings, default off) re-enables local
  text extraction for those types only, labelled "text extracted locally".
- Attachments send on the first turn only (the staging claim is consumed);
  later turns carry no files. A temp file deleted before sending (Clear,
  delete, 7-day sweep) becomes an "attachment no longer available" note
  while the rest of the message sends normally. Streaming, tools and usage
  reporting are unchanged (string messages behave exactly as before).

## Test button

Settings → Test uses the **unsaved** panel values (key never logged):
`listModels` (best-effort) → tiny completion (16 tokens, 128 for
reasoning-aware models) → trivial tool probe (`reasoning_effort: 'none'`). Success shows `Works: <provider> <model> <ms> tools ok`;
failure shows the friendly message + action. Disabled during the run; main
aborts at 15 s. Model input suggests names from `listModels`.

## Add a provider

1. Copy `src/main/ai/providers/compatible/` to `<id>/` and fill
   `adapter.ts` / `capabilities.ts` / `errors.ts`.
2. Register in `src/main/ai/providers/index.ts` + `PROVIDERS` in
   `src/main/store/settings.ts` + `ProviderId` in `src/shared/types.ts`.
3. Add the id to `REASONING_MODEL` + one `adapter specifics` case in
   `tests/unit/providers-conformance.test.ts`. The literal-contract test
   enforces that request/response literals stay inside `providers/<id>/`
   (`retry.ts` exempt as generic recovery).
