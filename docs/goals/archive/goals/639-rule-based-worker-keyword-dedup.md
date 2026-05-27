# 639 — `RuleBasedAgentWorker` constructor dedupes keywords (after the existing trim+blank-filter) so a duplicate keyword in the operator's config can't double-count in both numerator and denominator and inflate dispatch confidence beyond intent

## Why

`packages/multi-agent/src/index.ts:RuleBasedAgentWorker` is the
keyword-driven worker the supervisor agent routes to. The
constructor already drops empty/whitespace-only keywords (goal
619); the matcher then computes confidence as:

```ts
canHandle(input: AgentRunInput): number {
  const text = joinMessages(input.messages).toLowerCase();
  const matched = this.keywords.filter((keyword) => text.includes(keyword)).length;
  return this.keywords.length === 0 ? 0 : matched / this.keywords.length;
}
```

Pre-fix the constructor stored every keyword (after trim/lowercase/
blank-filter) without deduping. A duplicate keyword counts in
both the numerator (when matched) and the denominator (always),
shifting the ratio away from the operator's intent.

### Concrete shapes

| Configured keywords          | Text contains | Pre-fix confidence | Post-fix confidence |
| ---------------------------- | ------------- | ------------------ | ------------------- |
| `["foo", "bar"]`             | "foo"         | 0.5                | 0.5 (unchanged)     |
| `["foo", "foo", "bar"]`      | "foo"         | **0.67**           | **0.5** (intent)    |
| `["foo", "FOO", "foo"]`      | "foo"         | **1.0**            | **1.0** (intent — one keyword matched, all variants collapse) |
| `["foo", "FOO"]`             | "bar"         | **0**              | **0** (no match)    |
| `["foo", "FOO", "bar"]`      | "foo bar"     | **1.0**            | **1.0** (both unique keywords match) |
| `["foo", "  foo  ", "FOO"]`  | "foo"         | **1.0**            | **1.0** (collapses to ["foo"]) |

### Reachability

The defect surfaces in two realistic operator scenarios:

1. **Hand-curated keyword list with accidental duplicates.**
   An operator who writes `[ "calendar", "schedule", "Calendar",
   "Schedule" ]` for the "calendar worker" expects 2 unique
   keywords. Pre-fix the list collapses to 4 distinct entries
   (case differs even after `.toLowerCase()` because the trim
   runs on each entry; identical strings still aren't deduped).
   Wait — actually `.toLowerCase()` IS applied per-keyword,
   so `"Calendar"` → `"calendar"` → matches the first one
   literally. Pre-fix this collapsed in `text.includes("calendar")`
   ALL FOUR times for the matching path, scoring 4/4 = 1.0.
   Post-fix the Set collapses them at construction.
2. **YAML/JSON config drift.** An operator merging two
   environment-specific configs that both define `["foo"]`
   ends up with `["foo", "foo"]`. Pre-fix the duplicate
   inflates the denominator AND the numerator on match,
   skewing the ratio. Post-fix the Set normalizes regardless
   of merge order.
3. **Programmatic builders.** Code that synthesises
   keyword lists from heterogeneous sources (per-skill tags,
   inferred keywords) can produce duplicates as a side effect
   of the join, without the author intending to.

This iter's defect class — **keyword list lacks dedup;
duplicates inflate match confidence** — is sibling-parity to
goal 619 (blank-keyword filter), 20 iters back. Fresh against
the recent window:

- 638: lenient base64url decode (auth bypass)
- 637: lenient base64 decode (loopback tool)
- 636: HTTP timeout
- 635: per-file concurrent write (memory store)
- 634: sort tiebreaker
- 633: surrogate-pair truncation
- 632: tilde-expansion
- 631: per-file concurrent write (messaging)
- 630: mkdtemp directory cleanup
- 629: per-entry validation

## Slice

- `packages/multi-agent/src/index.ts:RuleBasedAgentWorker`:
  - The map+filter chain at the constructor stays, but the
    result is wrapped in `new Set(...)` and spread back to a
    readonly array. Since `.toLowerCase().trim()` already
    normalises case + whitespace, the Set dedupes on the
    normalised form — `"Calendar"`, `"calendar"`, `"  calendar  "`
    all collapse to a single `"calendar"`.
  - One short WHY comment extends the existing blank-filter
    comment with the dedup rationale so a maintainer reading
    the constructor sees both invariants together.
- `packages/multi-agent/test/multi-agent.test.ts`:
  - One new test in the existing `SupervisorAgent` describe,
    three assertions:
    1. **Duplicate "foo" + blank + case variants** —
       `["foo", "FOO", "foo", "  foo  ", "", "bar", "Bar"]`
       collapses to `["foo", "bar"]`. Text `"foo"` only matches
       one of two → confidence 0.5. Pre-fix would have been
       4/5 or higher.
    2. **Both unique keywords matched** — text `"foo and bar"`
       scores 1.0 against the deduped `["foo", "bar"]`.
    3. **Neither matched** — unrelated text scores 0.

## Verify

- `@muse/multi-agent` suite green (49 passed, +1 vs the
  pre-iter baseline of 48, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  `[...new Set(...)]` wrap back to the bare map+filter makes
  the new test fail with the EXACT pre-fix symptom:
  `Received: 0.6666666666666666` (4 matches / 6 entries —
  the duplicates double-count: `"foo"`/`"FOO"`/`"foo"`/`"  foo  "`
  all match against text "foo", plus `"bar"`/`"Bar"` survive
  but don't match, giving 4/6 instead of the deduped 1/2).
  Vs. `Expected: 0.5`. The pre-existing blank-filter test
  (goal 619's pin) passes pre- AND post-fix because its input
  has unique keywords — confirms the fix is purely additive.
- `pnpm check` green: apps/api 261/261, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched — pure
  in-process keyword matching. `smoke:live` doesn't apply.

## Status

Done. `RuleBasedAgentWorker.canHandle` now reports confidence
based on UNIQUE matched keywords / UNIQUE keywords, regardless
of how the operator structured the input list:

| Configured keywords          | Text contains | Before        | After        |
| ---------------------------- | ------------- | ------------- | ------------ |
| `["foo", "bar"]`             | "foo"         | 0.5           | unchanged    |
| `["foo", "foo", "bar"]`      | "foo"         | **0.67**      | **0.5** (**fixed**)  |
| `["foo", "FOO", "bar"]`      | "foo"         | **0.67**      | **0.5** (**fixed**)  |
| `["foo", "foo"]` (all dup)   | "foo"         | 1.0           | 1.0 (1 unique kw matches itself) |
| `["foo", "FOO", "bar"]`      | "foo bar"     | 1.0           | 1.0          |
| `["", "  ", "foo"]`          | "foo"         | 1.0 (post-619)| 1.0          |
| `["foo", "FOO", "", "bar"]`  | "unrelated"   | 0             | 0            |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ keyword-normalisation `fix:` on the supervisor dispatch
layer. Recorded honestly with this backlog row.

## Decisions

- **`new Set(...)` after the trim+lowercase**, not before. If
  the dedup ran on raw inputs, `"Calendar"` and `"calendar"`
  would survive as distinct entries. After the normalisation
  pass they collapse — matching the matcher's actual
  comparison (`text.includes(keyword)` is case-sensitive but
  `text` is `.toLowerCase()`'d and `keyword` is too, so the
  effective comparison is case-insensitive).
- **Set preserves insertion order**, so the operator's
  first-mention order is kept. A future iter that surfaces
  the keyword list in diagnostics will see the predictable
  ordering.
- **Did NOT also dedupe inside `canHandle`.** Construction-
  time normalisation is the right home — the matcher runs on
  every dispatch tick and shouldn't re-do the Set work. One-
  shot at construction is O(n); per-call would be O(n) per
  matcher invocation.
- **Did NOT change `text.includes(keyword)` to a word-
  boundary regex.** That's a SEPARATE defect class (substring-
  match inflation: "calendar" matches "calendaring"). Out-of-
  scope for the dedup fix.
- **Did NOT add a "wow, this list is suspiciously
  duplicated" warning.** Operator could legitimately rely on
  dedup behavior; a warning would be noise. Silent dedup is
  the right posture, same as the silent blank-filter from 619.
- **Mutation choice.** Reverted only the `[...new Set(...)]`
  wrap (the surrounding `.map().filter()` is unchanged).
  One test fails with the exact pre-fix `0.67` symptom; the
  five other tests in the file pass pre- AND post-fix. Tight
  proof.

## Remaining risks

- **Other workers** with keyword-driven dispatch don't
  exist in the codebase yet — `RuleBasedAgentWorker` is the
  only `AgentWorker` impl that uses substring matching. If a
  future worker copies the pattern without the dedup, the
  defect could resurface. Documenting in the inline comment
  helps; a future "AgentWorker base class" extraction could
  hoist the dedup as shared infrastructure.
- **The `text.includes(keyword)` substring match itself**
  carries the well-known substring-inflation hazard ("ai"
  matches "email", "rag" matches "fragment"). The
  `topic-drift.ts` policy already uses word-boundary regex
  for non-CJK keywords; `RuleBasedAgentWorker` doesn't. A
  future iter could port the same word-boundary check here —
  out of scope for the dedup fix.
- **`Set` dedup is byte-level** (`"Calendar"`.toLowerCase()
  === `"calendar"` — yes). Unicode normalisation (NFC vs.
  NFD) for non-ASCII keywords is NOT applied; `"café"`
  written two different ways (`é` U+00E9 vs. `e` + U+0301)
  would NOT dedupe. Possible future tightening; not
  exercised by any current operator config.
- **`text.includes("")` is universally true**, but the
  blank filter from 619 already drops empties before the
  dedup. The order of operations matters: filter blanks →
  THEN dedup. Got that right.
