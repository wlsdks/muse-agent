# 465 — A corrupt firedAtMs can't crash the whole `muse pattern` fired list (453/459 sibling)

## Why

`formatFiredList` (`apps/cli` `commands-pattern.ts`) renders the
`muse pattern` fired-pattern listing: for each
`PatternFiredRecord` it did
`shortDateTime(new Date(record.firedAtMs).toISOString())` with
**no guard**. `PatternFiredRecord` comes from the persisted
`@muse/mcp` patterns-fired store (daemon-written); a corrupt,
partially-written, hand-edited, or missing `firedAtMs`
(`NaN` / `undefined` / out-of-range) makes `new Date(...)` an
Invalid Date and `.toISOString()` throw
`RangeError: Invalid time value` inside `records.map(...)` — so
**one bad record crashes the entire fired-pattern listing**,
hiding every other (valid) pattern from the user.

This is the exact 453 / 440 / 459 "an unguarded Invalid Date
flows into `.toISOString()` and crashes the whole listing"
class, on a user-facing CLI command, found by a systematic grep
for `new Date(<loaded>).toISOString()`. The fix lives in
`apps/cli` (not the `@muse/mcp` store — `PatternFiredRecord` is
only imported as a type), so this is a fresh area, distinct from
the recent mcp work (Step-8 satisfied). The existing
`commands-pattern.test.ts` covers `parseLimit` / `parseConfidence`
but never `formatFiredList` with a corrupt timestamp — **genuinely
uncovered**. Not manufactured: deterministic JS
(`.toISOString()` on Invalid Date throws) + a corruptible
persisted source, the codebase's own established 453/459 guard
pattern applied to the sibling that missed it.

## Slice

- `apps/cli/src/commands-pattern.ts` — `formatFiredList` builds
  the Date once and guards it (mirroring 453/459's
  `Number.isNaN(d.getTime())` check): an invalid Date renders
  `"(unknown time)"` and the rest of the list still renders;
  `.toISOString()` is only called when the Date is valid, so it
  can never throw. Behaviour byte-identical for any valid
  `firedAtMs` (the normal case). Exported (it was private) so
  the pure formatter can be unit-tested directly — the same
  module's `commands-pattern.test.ts` already tests its exported
  helpers (`parseLimit`/`parseConfidence`); the 091/430
  "exported for direct coverage" precedent.
- `apps/cli/src/commands-pattern.test.ts` — a new `describe`:
  a list mixing valid records with `firedAtMs = NaN` and
  `firedAtMs = 9e15` (beyond the ±8.64e15 Date range) →
  `formatFiredList` does NOT throw, the two valid records list
  their times, the two bad ones render `"(unknown time)"`; empty
  list unchanged.

## Verify

- New tests green; the pre-existing `parseLimit` /
  `parseConfidence` tests still green; full `@muse/cli` suite
  green (69 files, +2 it, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  unguarded `shortDateTime(new Date(record.firedAtMs)
  .toISOString())` makes the new test fail by THROWING
  `RangeError: Invalid time value` out of `formatFiredList` (the
  precise pre-fix whole-list crash); fix restored, suite back to
  green.
- `pnpm check` EXIT=0, every workspace green (cli, api …) — no
  regression; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure deterministic formatter — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. One corrupt `firedAtMs` in the persisted patterns-fired
store no longer throws a `RangeError` out of `muse pattern` and
hides every fired pattern; the bad record degrades to
`"(unknown time)"` and the listing renders. Valid records are
unchanged. The 453/459 Invalid-Date guard now covers this CLI
listing.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 453/440/459 sibling-asymmetry
robustness `fix:` to an existing CLI command, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Build the Date once and `Number.isNaN(d.getTime())`-guard
  (byte-parallel to 453/459), not a `Number.isFinite(firedAtMs)`
  pre-check: a finite-but-out-of-range ms (`9e15`) still yields
  an Invalid Date, so the canonical guard is on the constructed
  Date's time, exactly as 453/459 established.
- Exported `formatFiredList` rather than testing via the
  command action: this test file already directly tests the
  module's exported pure helpers; exporting one more pure
  formatter is the minimal, consistent, drift-free way to pin
  it (091/430 precedent), versus a heavier stubbed-store
  command-path test.
