# 675 — `loadImageAsBase64` validates the actual base64 payload of a `data:…;base64,…` image URL (charset + non-empty), not just that the media-type segment declares `;base64`, so `muse vision` rejects an SVG / `%`-escaped / empty payload with a clear error instead of feeding garbage to the vision model

## Why

`apps/cli/src/commands-vision.ts:loadImageAsBase64` handled
a `data:` image source by:

```ts
if (!/;base64$/iu.test(trimmed.slice("data:".length, comma))) {
  throw new Error("data: URL must be base64-encoded image bytes …");
}
return trimmed.slice(comma + 1);   // ← payload returned unchecked
```

The guard only checks that the **media-type segment** ends
with `;base64` — it asserts the declared encoding, not that
the bytes after the comma are actually base64. A source like:

- `data:image/png;base64,<svg/>` — an SVG body mislabeled
  as base64,
- `data:image/png;base64,%3Csvg%3E` — a `%`-escaped string,
- `data:image/png;base64,` — an empty payload,

passes the `;base64` check and is returned verbatim. It then
flows into `buildOllamaVisionBody({ ..., imageBase64 })` and
out to Ollama's `/api/generate`, which base64-decodes it into
garbage bytes — the model receives a corrupt "image" and
either errors opaquely or hallucinates. The user gets no
clear signal that their data URL was malformed.

The fix validates the payload's charset (`[A-Za-z0-9+/]` +
optional `=` padding, whitespace stripped since data URLs may
wrap) and rejects empty / non-base64 payloads with an
actionable error before they reach the model. Whitespace-
wrapped valid base64 is tolerated (Buffer's decoder ignores
it anyway; stripping keeps the returned value clean).

### Defect class

**Base64 input-shape validation** — sibling-class to goal
637 (loopback-crypto base64 decode validation,
`^[A-Za-z0-9+/]*={0,2}$` + length guard), but a distinct
site (vision data-URL) and a fresh area (CLI vision, not
touched recently). Goal 637 was ~38 iters ago — far outside
the 10-iter window.

Recent 10-iter window:

- 674: strict ?limit= parse (api history)
- 673: Math.min/max spread RangeError (calendar)
- 672: HTTP timeout (LINE)
- 671: asymmetric validation (web-search)
- 670: calendar local-timezone render
- 669/668: HTTP timeout (messaging)
- 667/666: route to synthesizeAndPlay
- 665: scheduler clamp

Deliberately a different area than the recent calendar (670,
673), messaging (668, 669, 672), and api-routes (674) runs.

## Slice

- `apps/cli/src/commands-vision.ts`:
  - After the existing `;base64` media-type check, the `data:`
    branch now strips whitespace from the payload and rejects
    it (`length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u`) with
    `"data: URL base64 payload is empty or not valid base64 —
    expected image bytes after the comma"`. The validated,
    whitespace-stripped payload is returned (clean base64 for
    the model).
- `apps/cli/test/program.test.ts`:
  - Extended the existing `muse vision helpers` test with
    four new assertions: `<svg/>` payload → rejected;
    `%3Csvg%3E` payload → rejected; empty payload → rejected
    (`empty or not valid base64`); and a whitespace-wrapped
    valid base64 (`QUJD\n  REVG`) → accepted as `QUJDREVG`.

## Verify

- `pnpm --filter @muse/cli test`: 1147 passed (existing test
  extended with 4 assertions; no count change since they
  ride the existing `it`). Full `pnpm check`: every workspace
  green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the validation back to
  the bare `return trimmed.slice(comma + 1)` makes the
  `<svg/>`-payload assertion fail — the malformed payload
  passes through unchecked (no throw) instead of being
  rejected. The pre-existing data-URL assertions (valid
  payload, missing-comma, non-`;base64` media-type) pass
  either way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched — this validates
  a CLI image source before it's ever sent. `smoke:live`
  doesn't apply (and the vision path targets Ollama's vision
  endpoint, not the chat round-trip).

## Status

Done. `muse vision` now fails fast on a malformed data-URL
payload:

| `data:` source                              | Pre-fix                          | Post-fix                       |
| ------------------------------------------- | -------------------------------- | ------------------------------ |
| `…;base64,iVBORw0KGgo=`                     | passes through                   | passes through                 |
| `…;base64,QUJD\n  REVG` (wrapped)           | passes through (with newlines)   | accepted, whitespace stripped  |
| `…;base64,<svg/>`                           | **garbage to model**             | **clear "not valid base64"**   |
| `…;base64,%3Csvg%3E`                        | **garbage to model**             | **clear error**                |
| `…;base64,` (empty)                         | **empty image to model**         | **"empty or not valid base64"**|
| `data:image/svg+xml,…` (no `;base64`)       | rejected (unchanged)             | rejected (media-type check)    |

## Decisions

- **Validate charset, not strict length%4** — the `[A-Za-z0-9+/]`
  + `={0,2}` pattern catches the real failure modes (SVG
  `<`/`>`, `%`-escapes, raw text). Some encoders omit padding,
  so a hard `length % 4 === 0` check would reject valid
  unpadded base64; the charset check is the right granularity
  for "is this base64 or garbage."
- **Strip whitespace before validating AND return the
  stripped form** — data URLs can wrap base64 across lines.
  `Buffer.from(b64, "base64")` ignores whitespace, but
  returning the stripped payload keeps the value the model
  receives clean and the validation regex simple (no `\s` in
  the charset class).
- **Empty payload rejected** — `data:image/png;base64,` with
  nothing after the comma would otherwise send an empty
  "image." The `length === 0` check folds it into the same
  clear error.
- **Reused the existing `it` block** — the vision-helpers
  test already exercises every `loadImageAsBase64` branch;
  the new payload cases belong there, not in a new describe.
- **Mutation choice** — reverted to the bare slice-and-return.
  The `<svg/>` assertion fails (passes through); the valid /
  missing-comma / media-type assertions pass. Surgical proof.

## Remaining risks

- **`data:` URL with a valid-base64 but non-image payload**
  (e.g., base64-encoded text) still passes — charset
  validation can't tell base64-encoded PNG from base64-encoded
  garbage. The vision model would reject a non-image; a magic-
  byte sniff (PNG/JPEG/WebP header) after decode would catch
  it, but that's heavier and out of scope.
- **http(s) and local-file image branches** read raw bytes and
  base64-encode them — no validation needed there (the bytes
  are whatever the file/server holds; the model decides if it's
  a valid image). The data-URL branch was the only one
  trusting a user-declared encoding.
- **The error doesn't echo the bad payload** (could be huge /
  contain a pasted secret) — it stays generic, which is the
  right call for a CLI error on user-pasted data.
