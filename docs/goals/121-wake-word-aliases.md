# 121 — `TextScanWakeWordDetector` supports alias phrases

## Why

The wake-word detector matched a single phrase. A user who wanted
to say either "Hey Muse" OR "OK Muse" OR a bare "Muse" had to
either pick one or compose multiple detectors. JARVIS-class
voice surface should accept the user's natural wake variants
without forcing them into one canonical phrasing.

## Scope

- `packages/voice/src/wake-word.ts`:
  - `TextScanWakeWordDetectorOptions` gains optional
    `aliases: readonly string[]`. Each alias is normalised the
    same way as `phrase`; empty / whitespace-only entries drop
    silently so a stray `""` doesn't degrade into a "wake on
    every input" disaster.
  - Constructor builds an ordered `needles` array (canonical
    `phrase` first, then aliases) and dedupes after
    normalisation so callers can supply punctuation variants
    without surprising the matcher.
  - `scan()` iterates needles in order — first match wins, so
    the caller should list specific phrases before generic ones
    (a bare `"Muse"` before `"Hey Muse"` would otherwise steal
    the prompt residual).
  - `describe()` lists every alias in the original spelling
    (dedup only applies to matching, not display).

## Verify

- New `packages/voice/test/voice.test.ts` cases:
  - Canonical + alias both trigger; residuals carry the right
    suffix.
  - None of the aliases → no detection.
  - Empty / whitespace alias entries drop silently.
  - Aliases that normalise to the same needle as `phrase`
    collapse without changing behaviour.
  - `describe()` lists all phrases.
- `pnpm --filter @muse/voice test` — 58 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (wake-word detector is text-only +
  pure).

## Status

done — `muse listen --wake` can now match multiple phrasings
from one detector.
