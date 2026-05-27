# 531 — `suggestPatternHints` adds a patternId-asc tiebreaker for hints sharing firings (goal-519/530 sibling on `muse status --suggestions`)

## Why

`apps/cli/src/commands-status.ts:449` sorted the pattern-hint
candidates by `b.firings - a.firings` (most-fired first) and
`.slice(0, maxHints)` to cap the displayed count, with no
tiebreaker on equal firings:

```ts
return candidates.sort((a, b) => b.firings - a.firings).slice(0, maxHints);
```

When two patterns share the same firing count (a common case
when the user has multiple equally-active habits, or every
pattern still has the same starter count of 3 firings),
JavaScript's stable sort yields to **input-array order** —
which is the insertion order of the `buckets` Map at line
437. That order is determined by `Map`'s iteration semantics,
which preserve insertion order from however the upstream
`fired` array happened to be filled.

The user-visible defect: two `muse status --suggestions`
invocations against the same data can show the same hints in
**different orders** if anything upstream reorders the `fired`
events — and worse, with `maxHints` clamping the result, the
hints that survive the slice depend on the same non-
deterministic input order. A pattern that should appear
hint-1 sometimes appears hint-2 and gets dropped.

Same sibling-asymmetry defect class as goals 519 (vacuumEpisodes
tiebreaker) and 530 (action-log tiebreaker). The id-tiebreaker
convention now reads identically across three sites: persistent
episode vacuum, accountability-log render, and the recently-
shipped `muse status --suggestions` (goal 095).

## Slice

- `apps/cli/src/commands-status.ts` — replaced:
  ```ts
  candidates.sort((a, b) => b.firings - a.firings)
  ```
  with:
  ```ts
  candidates.sort((a, b) => b.firings - a.firings || a.patternId.localeCompare(b.patternId))
  ```
  Behaviour byte-identical for every input where firings are
  all distinct — only the tied path now has a deterministic
  asc-by-patternId order. The asc direction (alphabetical
  for the human reader) differs from the desc direction used
  for id-based tiebreakers on time-keyed sorts (goals 519,
  530) because the primary key here is a numeric count, not
  a timestamp; the deterministic shape matters more than the
  direction, and alphabetical-asc gives the most-readable
  output.
- `apps/cli/test/program.test.ts` — extended the existing
  `suggestPatternHints surfaces patterns` test with a new
  assertion: build a `reordered` input where pattern `"y"`
  precedes pattern `"x"` in the events array, both with 5
  firings; assert the hints come back `["x", "y"]` (asc by
  patternId) regardless of insertion order.

## Verify

- New assertion green within the existing `it(...)` block;
  full `@muse/cli` suite green (893 passed, +1 vs baseline
  892, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  tiebreaker to a bare `(a, b) => b.firings - a.firings`
  makes the new assertion fail with the precise pre-fix
  symptom — `ties on firings resolve by patternId asc —
  independent of input insertion order: expected [ 'y', 'x'
  ] to deeply equal [ 'x', 'y' ]` (insertion-order leaks
  through the stable sort). Fix restored, suite back to all
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the `muse status
  --suggestions` render, not the model loop.

## Status

Done. Two pattern hints sharing the same `firings` count now
have a deterministic display order across reload cycles; the
`maxHints` slice doesn't drop one hint or the other based on
upstream `fired`-array insertion order.

The tiebreaker-determinism convention now reads identically
across three sites:

- personal-episodes vacuum (goal 519, time desc, id desc)
- queryActionLog (goal 530, time desc, id desc)
- suggestPatternHints (this goal, count desc, patternId asc)

Different directions are honest — the primary key direction
drives display intuition, but every comparator now ends in a
deterministic identity-key fallthrough.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry comparator-
determinism `fix:` on the `muse status` suggestions surface,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 530 onto a different surface
  (CLI status command's pattern-hint suggestion) but same
  defect class — productive sibling sweep, not same-area
  churn.
- Used asc by patternId (alphabetical, human-readable) rather
  than desc: the comparator is for a UI render, not a
  newest-first persistence cap. Operators reading
  `muse status --suggestions` will see hints with the same
  firing count grouped alphabetically, which is the obvious
  display convention.
- Did NOT change the primary key direction (`b.firings - a.
  firings`): it's still most-fired-first (more evidence =
  higher confidence per the comment at line 448). Only the
  fall-through is deterministic.
- The mutation reverts the single `|| a.patternId.localeCompare
  (...)` token rather than the whole line shape; the test
  failure (`expected [ 'y', 'x' ] to deeply equal [ 'x', 'y'
  ]`) reproduces the pre-fix observable byte-for-byte —
  insertion-order leaking through.
- The new assertion explicitly constructs a `reordered` input
  where the array starts with `"y"` then `"x"` — this is
  necessary because building both in the natural `[x, y]`
  order would also produce `[x, y]` under stable sort (the
  pre-fix code's "happens to be right" path). The fix is
  visible only when the input order opposes the intended
  output.
