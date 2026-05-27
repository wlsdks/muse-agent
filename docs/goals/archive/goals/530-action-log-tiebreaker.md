# 530 — `queryActionLog` adds an id-desc tiebreaker for entries sharing `when` (goal-519 sibling on the accountability-log read)

## Why

`packages/mcp/src/personal-action-log-store.ts:110` sorted the
accountability-log entries newest-first by parsed `when`, with
no tiebreaker on equal timestamps:

```ts
return [...scoped].sort((a, b) => {
  const aMs = Date.parse(a.when);
  const bMs = Date.parse(b.when);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
    if (aMs !== bMs) {
      return bMs - aMs;
    }
  } else if (a.when !== b.when) {
    return b.when.localeCompare(a.when);
  }
  return 0;
});
```

When two log entries share the exact same `when` (a tight loop
where the autonomous-action evaluator fires multiple actuators
in the same millisecond, or two refused-because-no-consent
entries appended back-to-back during a single tick), the
comparator returns 0 and JavaScript's stable sort preserves
**input array order**. That input order is:

- determined by `readActionLog`'s file-read parse order, which is
- determined by the previous `writeActionLog` write order, which is
- ultimately seeded by `appendActionLog` insertion sequence.

This makes the displayed order of tied entries **non-
deterministic across reload cycles** — two `muse actions`
invocations in the same session could show the same entries
in different orders if anything reorders the array on the way
through serialization. Operators auditing what Muse did on
their behalf get a less-trustworthy timeline.

Same sibling-asymmetry defect class as goal 519 (vacuumEpisodes
tiebreaker) — single-key time sort missing the id-desc
tiebreaker that pins the comparator output to entry identity.

## Slice

- `packages/mcp/src/personal-action-log-store.ts` — replace
  the trailing `return 0;` (which yields to input-array order)
  with the id-desc tiebreaker matching the primary key
  direction (newest-first):
  ```ts
  return b.id.localeCompare(a.id);
  ```
  Behaviour byte-identical for every input where no two
  entries share `when` — only the tied path now has a
  deterministic, reload-independent order. The tiebreaker
  fires both for parsed-finite ties AND for the unparseable-
  string-equal case (no `when` to compare further), giving
  ONE consistent fall-through.
- `packages/mcp/src/personal-action-log-store.test.ts` —
  added one new `it(...)` block that appends three entries
  with identical `when`, then asserts `queryActionLog`
  returns them in `["c", "b", "a"]` order (id-desc) instead
  of insertion order (`["a", "c", "b"]`).

## Verify

- New test 1/1 green; full `@muse/mcp` suite green (526
  passed, +1 vs baseline 525, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting back to
  `return 0;` makes the new test fail with the precise pre-
  fix symptom — `ties on \`when\` resolve by id desc —
  deterministic regardless of insertion order: expected
  [ 'a', 'c', 'b' ] to deeply equal [ 'c', 'b', 'a' ]`
  (the order depends on appendActionLog insertion sequence,
  exactly the non-determinism the tiebreaker closes). Every
  other test stays green. Fix restored, suite back to 1
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the `muse actions`
  newest-first render (and any future `/api/actions` route),
  not the model loop.

## Status

Done. Two accountability-log entries sharing `when` now have
a deterministic display order across reload cycles. The id-
desc tiebreaker convention now reads identically across the
two newest-first persistence-render paths in the codebase:

- personal-episodes vacuum (goal 519)
- personal-action-log queryActionLog (this goal)

Both share the same "primary-key time desc, tiebreaker by id
desc" shape.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry comparator-
determinism `fix:` on the accountability-log read,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the `--user` bucket-symmetry run
  (528 / 529) to the comparator-determinism class on a
  different concern (sort tiebreaker). Same package as goal
  529 but a different defect class — productive sibling
  pivot.
- Placed the tiebreaker at the trailing `return` so it fires
  uniformly for BOTH the parsed-finite-tie path and the
  unparseable-string-equal path. A future maintainer who
  changes either branch's early return doesn't need to
  remember to mirror the tiebreaker; it's the function's
  final word in every flow.
- Used `b.id.localeCompare(a.id)` (desc) to match the
  primary key direction (`bMs - aMs` is newest-first;
  the tiebreaker should also be id-newer-first by lex sort).
  Same shape as goal 519's `right.id.localeCompare(left.id)`
  decision — cross-package convention.
- The mutation reverts the single `return` statement; the
  test failure (`expected [ 'a', 'c', 'b' ] to deeply equal
  [ 'c', 'b', 'a' ]`) reproduces the pre-fix observable
  byte-for-byte — three entries in insertion order instead
  of id-desc order.
- Did NOT change the `serializeActionLogEntry` order, the
  storage shape, or the existing test for mixed-precision
  ISO ordering (line 68): those are orthogonal concerns
  that remain byte-identical.
