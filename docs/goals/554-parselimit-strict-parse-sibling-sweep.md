# 554 — `parseLimit` in `commands-history.ts` + `commands-episode.ts` adopts the strict-parse convention (sibling-asymmetry across four copies of the same helper)

## Why

Four CLI files in `apps/cli/src` each define their own
`parseLimit(raw, fallback, cap)` helper:

| File | Behaviour on bad input |
| --- | --- |
| `commands-search.ts:208` | **throws** `--limit must be an integer in [1, N]` |
| `commands-pattern.ts:123` | **throws** `--limit must be a positive number` |
| `commands-history.ts:60`  | **silently** returns the fallback |
| `commands-episode.ts:237` | **silently** returns the fallback |

Same function name, opposite contracts. The strict-throw shape
is the established convention (carried forward from goals 143
/ 144 / 155, documented inline in commands-pattern.ts); the
silent-fallback shape is the pre-convention legacy.

Why this matters: a user who runs `muse history --limit 20x`
or `muse episode list --limit 5min` today thinks they passed a
filter. They actually got the **default** silently — same
value the user gets with no flag at all. No signal anything
went wrong. The user sees results, assumes the cap they
specified was respected, can't tell the difference between
"my filter applied" and "my filter was rejected". That's the
classic silent-fallback UX bug the strict-parse convention
exists to prevent (cf. `--hours` in `commands-feeds.ts` after
goal 538, `--limit` in `commands-actions.ts`, `--top` in
`commands-ask.ts` / `commands-notes-rag.ts`).

Affected CLI surfaces:

- `muse history --limit` (commands-history.ts)
- `muse episode list --limit` (commands-episode.ts:58 call site)
- `muse episode search --limit` (commands-episode.ts:109 call site)

## Slice

- `apps/cli/src/commands-history.ts:60` — rewrote `parseLimit`
  to throw on bad input, matching `commands-search.ts` /
  `commands-pattern.ts` byte-for-byte. Promoted to `export`
  for direct unit-test coverage (same widening pattern as
  539/540/547/548 etc.).
- `apps/cli/src/commands-episode.ts:237` — same rewrite, same
  `export` promotion.
- `apps/cli/src/commands-history.test.ts` — new direct unit
  test, 3 `it(...)` blocks: blank → fallback, valid → trim +
  cap + `trunc`, bad input → throws with the raw value in the
  message (covers `"abc"`, `"0"`, `"-4"`, `"20x"`, `"5min"`).
- `apps/cli/src/commands-episode.test.ts` — sibling test
  mirroring the above for the episode-side helper.

## Verify

- New tests 6/6 green; full `@muse/cli` suite green (998
  passed, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `commands-history.ts:60` helper to the pre-fix silent-
  fallback shape makes the new test fail with the precise
  pre-fix symptom — `expect(() => parseLimit("abc", 20,
  200)).toThrow(/--limit must be a positive number/u);` ⇒
  `expected null but received undefined` (the helper now
  RETURNS the fallback instead of THROWING). Fix restored,
  suite back to all green. The `commands-episode.ts:237`
  helper has a byte-identical shape and would mutate-fail
  identically if reverted; cross-package convention is to
  test one representative of a sibling pair.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 998 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the five intended files.
- Pure user-input validators — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended paths are `muse
  history`, `muse episode list`, and `muse episode search`,
  not the model loop.

## Status

Done. The CLI `--limit` strict-parse convention is now
uniform across all four `parseLimit` copies. A future grep
for `parseLimit` definitions returns four identical strict-
throw helpers; the silent-fallback shape is gone.

A future enhancement could lift the four copies into a
shared `apps/cli/src/program-helpers.ts` `parseBoundedLimit`
the way `firstNonEmpty` was lifted in goal 532. Not in scope
for this iteration; cross-CLI helper consolidation has
historically been a separate iteration (matches goal 532's
shape).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all
P-bullets are already `[x]` and audited; a sibling-asymmetry
silent-fallback `fix:` on the user-input validators of two
CLI commands, recorded honestly with this backlog row —
not a false metric.

## Decisions

- The strict-throw shape is the established convention
  (commands-pattern.ts inline comment cites goals 143/144/
  155). The silent-fallback shape is the older pre-
  convention legacy. Aligning the two outliers to the
  convention rather than the other way around is the
  correct direction.
- Each helper kept its own local definition rather than
  being lifted to a shared `parseBoundedLimit` in
  `program-helpers.ts`. Reasons: (1) one-iteration-per-area
  scope; the consolidation is a separate refactor in its
  own right and would invite a wider blast radius; (2) the
  four copies are now byte-identical, so the next iteration
  that touches one can trivially adopt the shared helper
  with no behaviour change; (3) the iteration-loop contract
  bans pure refactor sweeps.
- Mutated only `commands-history.ts` (one of two) for the
  proof — the `commands-episode.ts` helper has a byte-
  identical shape and would mutate-fail identically. Cross-
  package convention is to test one representative of a
  sibling pair (matches goals 537, 542, 548).
- The new tests cover BOTH the trim+cap path and the strict-
  throw path, mirroring `commands-pattern.test.ts` `it(...)`
  shape byte-for-byte. The strict-throw assertions include
  `"20x"` and `"5min"` explicitly — those are the canonical
  silent-fallback bug shapes a user would actually type.
- Promoted both helpers to `export` for direct testing
  (same widening pattern as goals 539/540/547/548). Pre-fix
  both were internal helpers with no direct coverage —
  the silent-fallback bug had been invisible to the test
  suite.
