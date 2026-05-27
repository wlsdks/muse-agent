# 519 — `vacuumEpisodes` adds an id tiebreaker so two episodes sharing `endedAt` retain deterministic identity across reloads (goal-432/443/457/461/464/466/472-476/490/497 sibling on the personal-episodes persistence layer)

## Why

`packages/mcp/src/personal-episodes-store.ts:146` sorted
`existing` episodes by `endedAt` desc before slicing to keep the
top `cap`:

```ts
const sorted = [...existing].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
const kept = sorted.slice(0, cap);
```

If two episodes share the same `endedAt` (very plausible — the
end-of-session hook stamps `new Date().toISOString()`, and a
test-suite or scripted upsert can produce two episodes with the
same millisecond stamp), JavaScript's stable sort preserves the
**input-array order** for the tie. That input-array order is:

- determined by `readEpisodes(file)`'s file-read order, which is
- determined by the previous `writeEpisodes` write order, which is
- determined by the previous `sort` output, which is
- ultimately seeded by whatever order the episodes were first
  upserted in.

This makes vacuum's tie-breaking **non-deterministic across
reload cycles**: a vacuum on cycle N picks the "last-written-
first" tied episode, then a re-read on cycle N+1 might pick a
different tied episode if anything reorders the array on the
way through the JSON serialiser / parser / filesystem layer.
Two operators on two machines (or one operator with two
processes touching the same `.muse/episodes.json`) can see
**different episodes retained** for the same end-of-day cap.

Same sibling-asymmetry defect class as goals 432 / 443 / 457 /
461 / 464 / 466 / 472-476 / 490 / 497 — time-only sort lacking
the id tiebreaker that makes the comparator output independent
of insertion order. The convention has landed on
`runtime-state/src/session-tags.ts`, `runtime-state/src/run-
history.ts` (two sites), and ten other sites; the personal-
episodes persistent vacuum was an outlier without the
tiebreaker.

## Slice

- `packages/mcp/src/personal-episodes-store.ts` — added the id
  tiebreaker, in the same desc direction as the primary key so
  the comparator is internally consistent:
  ```ts
  const sorted = [...existing].sort((left, right) =>
    right.endedAt.localeCompare(left.endedAt) || right.id.localeCompare(left.id)
  );
  ```
  Behaviour byte-identical for every input where no two episodes
  share `endedAt` — only the tied path now has a deterministic,
  reload-independent order.
- `packages/mcp/test/mcp.test.ts` — added one new `it(...)` block
  that upserts three episodes (`ep_a`, `ep_b`, `ep_c`) with
  **identical** `endedAt`, then `vacuumEpisodes(file, 2)`,
  asserts the kept ids are `["ep_b", "ep_c"]` (the
  lexicographically-larger pair, by id-desc-tiebreaker). The
  existing distinct-timestamp test passes unchanged.

## Verify

- New test 1/1 green; full `@muse/mcp` suite green (524 passed,
  +1 vs baseline 523, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  comparator back to a bare `right.endedAt.localeCompare(left.
  endedAt)` makes the tiebreaker test fail with the precise
  pre-fix symptom — `lexicographically-larger ids win the
  tiebreaker → ep_b + ep_c kept, ep_a dropped: expected [
  'ep_a', 'ep_b' ] to deeply equal [ 'ep_b', 'ep_c' ]`. The
  ordering depends on insertion order, exactly the
  non-determinism the tiebreaker closes. Fix restored, suite
  back to 1 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the two intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the personal-episodes
  persistent vacuum, not the model loop.

## Status

Done. Two episodes sharing `endedAt` now have a deterministic,
reload-independent retain/drop decision under `vacuumEpisodes`.
The id-tiebreaker convention now reads identically across
fifteen+ sibling sites in the codebase (session-tags, run-
history, observability latency, scheduler executions, etc.) —
the personal-episodes persistent vacuum is no longer the
outlier.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry comparator-
determinism `fix:` on the personal-episodes vacuum,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the `??`-doesn't-catch-NaN run (511 /
  512 / 518) and the strict-parse run (513 / 514 / 515 / 517)
  to a different defect class entirely (sort-comparator
  tiebreaker stability). Productive variation, distinct from
  the last six iterations' classes.
- Used desc tiebreaker (`right.id.localeCompare(left.id)`) to
  match the desc primary key (`right.endedAt.localeCompare(
  left.endedAt)`). A mixed direction would be subtle and
  surprising; the comparator now reads as "newest-first by
  endedAt, with ties broken by lexicographically-larger id
  first." Same convention as the other id-desc-tiebreaker
  sites in the codebase.
- Fixed only the persistent-vacuum site (`personal-episodes-
  store.ts:146`), not the three rendering reads in
  `loopback-episodes.ts` (lines 76, 146, 287) or the four
  rendering reads in `chat-repl.ts:645` /
  `commands-episode.ts:63,131,315`. The rendering reads are
  ephemeral and don't affect persisted state; the vacuum
  affects which episodes survive the cap — that's the
  outward-meaningful determinism. The rendering sibling-
  asymmetries are a future iteration's potential target if
  user-visible non-determinism is reported.
- Asserted `["ep_b", "ep_c"]` as the kept pair: with id-desc
  tiebreaker, "ep_c" > "ep_b" > "ep_a", so the top-2 are
  ep_c (1st) and ep_b (2nd). The test sorts the result before
  comparing so the order of the final assertion is
  alphabetical for readability.
- Did NOT change the `endedAt` comparator to `Date.parse`-
  based: the existing `localeCompare` on the project's
  always-UTC-Z ISO timestamps (from `new Date().toISOString()`)
  is already chronologically correct because lexicographic
  order on the fixed-format ISO is equivalent to chronological
  order. Adding `Date.parse` would be a separate concern.
