# 715 — fix: `muse vision <url>` rejects non-image responses instead of base64-encoding garbage; + first tests for the vision image loader

## Why

`muse vision` (sensory input, goal 087) accepts a path / http(s) URL /
data URL. The data-URL branch carefully validates the base64 payload,
but the **http(s) branch base64-encoded whatever bytes came back** — a
200 HTML error / login / paywall page (very common when a link isn't a
direct image) was silently handed to the vision model as "image bytes",
producing confident nonsense with no signal to the user. And
`loadImageAsBase64` — despite being exported "for direct unit-test
coverage" — had no tests at all.

Picked as a deliberately non-actuator surface (PROCEDURE Step 8: the
last several iterations churned the actuator/channel/setup surface).

## Slice

- `apps/cli/src/commands-vision.ts`: in the http(s) branch of
  `loadImageAsBase64`, read `response.headers.get("content-type")` and
  throw a clear "not an image" error when it is clearly textual
  (`text/*`, `application/json|xml|xhtml+xml`). Permissive by design:
  `image/*`, `application/octet-stream`, and an **absent** content-type
  still pass, since some image hosts omit it — so the guard catches the
  garbage case without false-rejecting odd-but-valid image servers.
- `apps/cli/src/commands-vision.test.ts` (new): the loader/helpers had
  zero coverage.

## Verify

- `@muse/cli` commands-vision.test.ts (1249 cli tests): resolveVisionModel
  flag/env/default; buildOllamaVisionBody shape (think:false, stream:false);
  formatOllamaVisionFailure 404→`ollama pull` hint vs raw body;
  loadImageAsBase64 — data-URL valid/non-base64-SVG/empty/malformed; http
  image-bytes; non-OK status; **textual content-type rejected**;
  octet-stream + absent type allowed; local file.
- **Mutation-proven**: removing the content-type guard fails the
  "rejects a 200 textual response" test. Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — `loadImageAsBase64` is pure byte
  handling driven by an injected fetch; the Ollama `/api/generate` call
  is unchanged.

## Decisions

- **Reject only clearly-textual content-types** — an allowlist (`image/*`
  only) would false-reject hosts that serve images as
  `application/octet-stream` or omit the header; a denylist of textual
  types catches the real failure (an HTML/JSON page) while staying
  permissive for genuine images.
- **`fix:` not `feat:`** — the core change closes a silent-garbage
  robustness hole; the new tests ride along (testing.md mandates direct
  coverage for the exported helpers).
