# 538 — `muse feeds refresh --id "  weather  "` trims to match the existing feed instead of silently no-opping (within-function trim asymmetry)

## Why

`apps/cli/src/commands-feeds.ts` had a **trim asymmetry within
one command's flow**:

```ts
// gate (line 199-208): trims --id before existence check
if (options.id !== undefined) {
  const trimmed = options.id.trim();
  const exists = store.feeds.some((f) => f.id === trimmed);
  if (!exists) { /* error + suggestion */ }
}

// filter (line 210): uses the UNTRIMMED options.id
const targets = options.id ? store.feeds.filter((f) => f.id === options.id) : store.feeds;
```

Concrete failure mode: user runs
`muse feeds refresh --id "  weather  "` against a store with
feed `id = "weather"`:

1. Gate: `trimmed = "weather"` → `exists = true` (passes)
2. Filter: `f.id === "  weather  "` → no match → `targets = []`
3. Render: `"(no feeds to refresh)"` printed → silent no-op
   exit 0

The two paths through the same command disagree about what
`--id` means — the gate says "you have weather, here we go,"
the filter says "no, that exact string isn't here." The
operator sees a green-looking no-op even though they typed
something the CLI just told them was valid.

Same within-function asymmetry defect class as goals 528 / 529
(--user trim asymmetry between add and list) and 536
(coerceStringSet csv-vs-array trim asymmetry). The convention
across the codebase is: trim the input ONCE, use the trimmed
value EVERYWHERE downstream.

## Slice

- `apps/cli/src/commands-feeds.ts` — replace the filter to use
  the same trimmed value the gate uses, by introducing a
  `targetId` local that's visible to both:
  ```ts
  const targetId = options.id?.trim();
  const targets = targetId && targetId.length > 0
    ? store.feeds.filter((f) => f.id === targetId)
    : store.feeds;
  ```
  Behaviour byte-identical for every clean (already-trimmed)
  `--id` invocation. Only the padded-input path now correctly
  reaches `refreshSingleFeed` instead of silently no-opping.
- `apps/cli/src/commands-feeds.test.ts` — added one new
  `it(...)` block: seed a store with `"weather"`, run
  `muse feeds refresh --id "  weather  "`, assert stdout
  contains `Refreshed 1 feed(s)` and does NOT contain
  `(no feeds to refresh)`.

## Verify

- New test 1/1 green; full `@muse/cli` suite green (914
  passed, +1 vs baseline 913, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  filter to the bare `options.id ?` truthy check makes the
  new test fail with the precise pre-fix symptom — `padded
  --id must reach refreshSingleFeed and produce a real
  refresh output, not the empty-target silent no-op: expected
  '(no feeds to refresh)\n' not to contain '(no feeds to
  refresh)'`. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI filter — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the `muse
  feeds refresh --id` user command, not the model loop.

## Status

Done. The two paths through `muse feeds refresh --id` (the
exists-check gate and the target-filter) now use the same
trimmed value. The within-function trim asymmetry is closed.

The trim-symmetry convention now reads identically across the
codebase's paired-flow CLI commands:

- `muse objectives {add,list}` (goal 528) — gate and filter
- `muse actions --user` (goal 529) — match and filter
- `coerceStringSet` csv vs array (goal 536) — two branches
- `muse feeds refresh --id` (this goal) — gate and filter

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a within-function trim
asymmetry `fix:` on `muse feeds refresh`, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the tiebreaker run (533 / 537) to a
  fresh trim-symmetry defect class on a fresh CLI surface.
  Productive variation, not same-area churn.
- Introduced a `targetId` local (vs. inlining `options.id?.
  trim()` at the filter site) so the trimmed value is named
  once and the call site reads as "do we have an id, and if
  so use it." Mirrors the `ownerBucket` local introduced by
  goal 528 for the same reason.
- Used the `targetId && targetId.length > 0` explicit length
  check rather than the truthy-only check from the pre-fix
  shape: this matches the convention established by goal 534
  (`workerIds && workerIds.length > 0`) and avoids the
  empty-string truthy-leak class on the next iteration.
- The mutation reverts only the one-line filter expression
  to its pre-fix shape; the test failure (`expected '(no
  feeds to refresh)\n' not to contain '(no feeds to
  refresh)'`) reproduces the pre-fix observable byte-for-
  byte — the operator gets a silent no-op instead of a real
  refresh.
- Did NOT touch the gate at lines 199-208 — it already trims
  correctly. The fix is purely about the filter using the
  trimmed value the gate already validated.
