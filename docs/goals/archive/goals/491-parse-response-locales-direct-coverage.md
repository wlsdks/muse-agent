# 491 — direct coverage for `parseResponseLocales` (test-only; 458/477/479/480/485/487 class)

## Why

`parseResponseLocales` (`apps/api/src/server-input-utils.ts:138`)
is the env parser for `MUSE_RESPONSE_LOCALES` — the list of
locales the API server promises to respond in (`server-routes.ts:510`
wires it onto the public capabilities advertisement). Its
contract:

- undefined / empty / whitespace-only → `["ko", "en"]` fallback.
- a comma-separated list of supported locales is normalised
  (case-insensitive, trim) and deduped.
- unsupported entries (`fr`, `de`, …) are silently filtered out.
- **if EVERY entry is unsupported, fall back to `["ko", "en"]`**
  — otherwise the published capabilities would silently
  advertise an empty `locales.response`, breaking every
  language-aware downstream client.

The "all-unsupported → fallback" clause was the *easy
regression*: a future "simplification" PR that drops the
`parsed.length > 0 ? … : fallback` check would silently
publish `[]`. The module had **no direct test coverage**: the
only test importing from `server-input-utils.ts` (`parse-
runtime-setting-type.test.ts`) didn't exercise this function.
458/477/479/480/485/487 sanctioned class — real
publication-contract zero-coverage helper, multi-clause
contract, mutation-provable. No `.ts` source change.

## Slice

- `apps/api/test/parse-runtime-setting-type.test.ts` —
  extended (existing describes untouched) with a focused
  `parseResponseLocales` describe: undefined / empty /
  whitespace → fallback; case + whitespace insensitive parse
  preserving first-seen order; unsupported entries filtered +
  dedupe; **all-unsupported → fallback** (the central clause).
- `apps/api/src/server-input-utils.ts` — **unchanged**
  (`git diff --stat` empty; test-only iteration mirroring
  goals 458/477/479/480/485/487 verbatim).

## Verify

- New 4 tests green; full `@muse/api` suite green (212 passed,
  +4, 0 failed); tsc strict (api) EXIT=0.
- **Clean-mutation-proven** (Edit-based): dropping the
  `parsed.length > 0 ? … : fallback` clause so the function
  always returns the deduped parsed array makes the
  all-unsupported test fail with the precise pre-fix symptom
  (`expected [] to deeply equal [ 'ko', 'en' ]` — the public
  capabilities surface would silently advertise an empty
  locales list) while the other three tests stay green; source
  restored byte-identical, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended test file (src is unchanged).
- Pure deterministic parsing — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The locales-publication contract on every `MUSE_RESPONSE_LOCALES`
env read is now pinned by direct tests; the central
"all-unsupported → fallback" clause is mutation-proven against
the easy `parsed.length > 0` simplification.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458-class direct coverage addition
on a zero-coverage publication-contract helper, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Mutation-proved the all-unsupported fallback specifically
  rather than the case-fold / dedupe paths: the fallback is
  the easy-regression clause (a future PR would argue the
  `parsed.length > 0` check is redundant when `parsed` is
  always an array, not realising the empty-parsed case
  exists); the case-fold + dedupe are positively pinned by
  the other three assertions.
- Extended the existing `parse-runtime-setting-type.test.ts`
  rather than adding a new file: both tests cover
  `server-input-utils.ts`, and a sibling describe keeps the
  coverage co-located with its module — same pattern the file
  already follows.
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `server-input-utils.ts`) —
  mirrors the 458/477/479/480/485/487 protocol exactly.
