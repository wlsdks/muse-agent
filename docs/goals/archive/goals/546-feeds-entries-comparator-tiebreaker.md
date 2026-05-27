# 546 — `compareFeedEntriesNewestFirst` adds an id-desc tiebreaker so ties on `publishedAt` are deterministic across reload cycles (goal-519/530/531/533/537 sibling on the feeds-store comparator)

## Why

`apps/cli/src/feeds-store.ts` had two near-identical comparator
sites:

```ts
// inline merge at line 252:
const merged = [...byId.values()].sort((a, b) => {
  const ta = Date.parse(a.publishedAt);
  const tb = Date.parse(b.publishedAt);
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
  if (!Number.isFinite(ta)) return 1;
  if (!Number.isFinite(tb)) return -1;
  return tb - ta;
});

// canonical comparator at line 276 (used by feeds today + filter):
export function compareFeedEntriesNewestFirst(...) {
  // same shape — returns 0 / 1 / -1 / (tb - ta)
}
```

Both lacked an id tiebreaker on the final return. When two
feed entries share the same `publishedAt` (very common — a
publisher batch-publishes three articles at the same minute,
two RSS items share a "1 day ago" pubDate, or two entries
both lack a publishedAt), the comparator returns 0 and
yields to **input-array order**. That order is the file-read
sequence from `feeds.json`, which can shuffle across reload
cycles → `muse feeds today` shows the same items in
different orders run-to-run.

Same sibling-asymmetry defect class as goals 519 / 530 / 531
/ 533 / 537. The id-tiebreaker convention has landed across
six paired persistence-render paths; this is the seventh
outlier closed.

## Slice

- `apps/cli/src/feeds-store.ts` — widen
  `compareFeedEntriesNewestFirst`'s signature from
  `{publishedAt}` to `{publishedAt; id}` and add the id-desc
  tiebreaker:
  ```ts
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return b.id.localeCompare(a.id);
  if (!Number.isFinite(ta)) return 1;
  if (!Number.isFinite(tb)) return -1;
  return tb - ta || b.id.localeCompare(a.id);
  ```
  Also DRY'd up the inline merge at line 252 to use the
  canonical comparator (the merge was structurally identical
  pre-fix, now both share one implementation that gets the
  tiebreaker consistently).
- `apps/cli/src/commands-feeds.ts:259-265` — added `id:
  entry.id` to the projection passed to `compareFeedEntries
  NewestFirst` so the new typed signature is satisfied. The
  `rolled` object now carries the id alongside feedId, title,
  link, etc.
- `apps/cli/src/feeds-store.test.ts` — added one new
  `describe(...)` block with 3 focused tests:
  - ties on publishedAt → id desc (deterministic
    regardless of input order)
  - clean distinct timestamps still sort newest-first (regression pin)
  - undated entries sink AFTER dated; two undated resolve by
    id desc
- `apps/cli/test/program.test.ts` — updated the existing
  goal-181 "consistent total order incl. undated" test
  fixtures: added `id: "n"`, `"o"`, `"ua"`, `"ub"` so the
  new typed signature is satisfied. The "two undated compare
  EQUAL" assertion became "two undated compare
  antisymmetrically by id" — same antisymmetry contract,
  stronger guarantee (deterministic order, not just
  consistent direction).

## Verify

- New tests 3/3 green; full `@muse/cli` suite green (961
  passed, +11 vs baseline 950 — 3 feeds-store + 5 goal 545's
  reminder + 1 the test-fixture update + 2 the still-not-yet-
  rolled-in baseline drift, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the id
  tiebreaker back to `return tb - ta;` makes the new test
  fail with the precise pre-fix symptom — `id desc puts
  lexicographically-larger first: expected […(3)] to deeply
  equal […(3)]` (insertion order leaks). Fix restored, suite
  back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the four intended files.
- Pure comparator + structural refactor — no LLM request-
  response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9). The defended paths
  are the feeds-store merge and `muse feeds today` render,
  not the model loop.

## Status

Done. Three sites (the inline merge, the canonical
`compareFeedEntriesNewestFirst`, and `muse feeds today`'s
rolled-entries sort) now share one comparator with a
deterministic id-desc tiebreaker. The id-tiebreaker
convention now reads identically across seven sibling sites:

- vacuumEpisodes (519, time desc + id desc)
- queryActionLog (530, time desc + id desc)
- suggestPatternHints (531, count desc + id asc)
- today-routes API (533, mixed asc/desc)
- muse followup list + muse today --local CLI (537)
- compareFeedEntriesNewestFirst (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry comparator-
determinism `fix:` on the feeds-store comparator,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the CLI did-you-mean sweep (543/544/
  545) back to the comparator-determinism class on a fresh
  surface. Productive variation across distinct defect
  classes — the did-you-mean convention is fully covered;
  this class still had outliers.
- Widened the canonical comparator's signature rather than
  duplicating two implementations (one with id, one
  without). The inline merge at line 252 was already
  byte-identical except for the missing id tiebreaker; DRY'ing
  it to the canonical helper is a coincident cleanup.
- The goal-181 test that asserted "two undated compare
  EQUAL" was actually asserting antisymmetry-direction
  (compare(a,b) and compare(b,a) must be sign-consistent).
  The new test pins the same antisymmetry contract with a
  stronger guarantee (id-desc deterministic) — strictly
  more behavior pinned.
- Updated `muse feeds today`'s rolled-entries projection to
  include `id: entry.id` (the new signature requires it).
  Carrying the id alongside is harmless extra metadata that
  consumers can use; the JSON output now includes it too.
- Mutation reverts only the tiebreaker tokens; the test
  failure (`expected […(3)] to deeply equal […(3)]`)
  reproduces the pre-fix observable byte-for-byte — input
  order leaks where the tiebreaker would have placed
  lexicographically-larger first.
