# 087 — `muse vision <image>` via Ollama vision model

## Why

JARVIS sees Tony's workshop. Muse currently has zero visual input —
every prompt is text. Pull in Ollama's local vision models
(`llama3.2-vision`, `llava`) so `muse vision <image>` returns a
description without leaving the laptop. Pure HTTP to Ollama's
existing endpoint; no new native deps, no cloud roundtrip.

## Scope

- New `apps/cli/src/commands-vision.ts` with `muse vision <path|url>
  [--prompt "..."] [--model <tag>] [--json]`.
- File path or `http(s)://` URL accepted. URL downloads to a temp
  buffer; both paths base64-encode and POST to `/api/generate` with
  `{ model, prompt, images: [<b64>] }`.
- Default model `MUSE_VISION_MODEL` env, fallback
  `llama3.2-vision:latest`.
- Fail-soft when Ollama is unreachable: clear "muse vision needs a
  running Ollama instance — `ollama serve` then `ollama pull
  llama3.2-vision`" stderr hint, exit 1.

## Verify

- cli +1 unit test on the request-builder (stub fetch; assert URL,
  body shape, base64 encoding).
- Dogfood (best-effort, skip if Ollama not running):
  ```
  echo -n "test" | base64 -d 2>/dev/null || true
  # Create a tiny test PNG via Node:
  node -e "const f=require('fs'); f.writeFileSync('/tmp/muse-vision-test.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f80f000001010001b4070ffe0000000049454e44ae426082','hex'))"
  node apps/cli/dist/index.js vision /tmp/muse-vision-test.png --json
  ```
  Pass if the response contains a non-empty `description` OR cleanly
  reports "Ollama unreachable".

## Status

open
