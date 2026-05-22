# 790 — fix: strip a zero-width byte from the 789 test + regression sweep

## Why

The mandated regression sweep (overdue — 16 iterations since the last)
re-ran every CAPABILITIES check and FOUND a regression: 789's new
`macos-ambient-source.test.ts:33` carried a raw zero-width space
(U+200B) inside a test name, tripping `repo-byte-hygiene` (goal-227:
no tracked file may carry a raw control / zero-width / BOM byte).

Why 789's own `pnpm check` missed it: `repo-byte-hygiene` scans
`git ls-files` (TRACKED files only). At 789 commit-time the test file
was newly written but not yet tracked, so the byte scan didn't see it;
it became tracked on commit and the sweep caught it the next tick.
This is exactly the cross-iteration falsification the sweep exists for.

## Slice

`@muse/mcp` macos-ambient-source.test.ts — rewrite the offending test
name in plain ASCII ("a failing or throwing osascript run yields
undefined, never throws"), removing the zero-width space.

## Verify

- `@muse/shared` repo-byte-hygiene.test.ts green (was red).
- `@muse/mcp` macos-ambient-source.test.ts 6/6 (behaviour unchanged).
- **Regression sweep (this tick)**: full `pnpm check` EXIT 0 across
  every workspace suite, `pnpm lint` 0/0, `pnpm smoke:broad` 51/0. The
  byte-hygiene regression was the ONLY finding; all other CAPABILITIES
  checks green. `smoke:live` deferred — Ollama down + no request/
  response path changed (tagged not-applicable, not a skipped duty).

## Decisions

- **Sweep finding fixed in the same tick** — Step 2 (a red check
  means repairing it is the iteration) applied mid-sweep: the fix IS
  this tick. No new capability / bullet flip.
- **Pre-commit gap noted**: byte-hygiene only covers tracked files, so
  a brand-new file's bytes aren't verified until after commit — the
  10-iter regression sweep is the safety net that closes it.
