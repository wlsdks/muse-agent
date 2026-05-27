# 464 — `queryActionLog` orders by parsed instant, not lexicographic ISO (461 sibling)

## Why

`queryActionLog` (`@muse/mcp` `personal-action-log-store.ts`) is
the **P6-b1 accountability review surface** — "what did Muse do
on my behalf, newest first", rendered by `muse actions` /
`/api/actions` (the newest `CAPABILITIES.md` line). It sorted
with `[...scoped].sort((a, b) => b.when.localeCompare(a.when))` —
a **lexicographic** ISO string compare.

Goal 461 fixed the structurally-identical `queryVetoes` for
exactly this defect (lexicographic ISO order is wrong across
mixed precision — `"…00.500Z"` sorts before `"…00Z"` — and
timezone offsets; goal 418 established the standard with
`compareRemindersByDueAt`; the `advanceInboxInjectionCursor`
comment states it verbatim). `personal-veto-store`'s own
docstring describes `queryVetoes` as **"Parallel to
`queryActionLog`"** — so `queryActionLog` is the *named sibling*
461 left unfixed. `when` is the daemon-/actuator-written action
timestamp (caller-supplied; mixed precision/offset is reachable
via different actuators, REST, or a hand-edited log), so the
highest-trust surface in the product — the audit of what Muse
did unattended — could show the genuinely-newest action **last**.

Not manufactured: the codebase's own standing decision
(418 / 461 + the explicit "Parallel to queryActionLog"
cross-reference) applied to the sibling that carried the
identical concrete gap (the 432 / 443 / 457 / 461 sibling-fix
pattern). The existing newest-first test uses only canonical
`…000Z` stamps (lexicographic == instant), so the
mixed-precision/offset case was **genuinely uncovered**.

## Slice

- `packages/mcp/src/personal-action-log-store.ts` —
  `queryActionLog` now sorts by `Date.parse` instants
  (newest-first), **byte-parallel to goal 461's `queryVetoes`
  fix** and `compareRemindersByDueAt` (418): finite-vs-finite →
  `bMs - aMs`; deterministic `localeCompare` fallback for
  unparseable; equal → 0 (stable). `appendActionLog` /
  `readActionLog` (the append-only durability + quarantine path)
  are untouched.
- `packages/mcp/src/personal-action-log-store.test.ts` — a new
  `it` mirroring 461's: three entries whose UTC instants are
  `zlate > xmid > yold` but whose ISO strings sort
  lexicographically `yold > xmid > zlate` (a `-05:00` offset +
  a same-second `.500Z`/`Z` pair); asserts `queryActionLog`
  returns `["zlate","xmid","yold"]`.

## Verify

- New `it` green; the pre-existing canonical-timestamp
  newest-first test still green (no wrong premise); full
  `@muse/mcp` suite 504 passed (34 files, +1); tsc strict (mcp)
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to
  `b.when.localeCompare(a.when)` makes the new test fail with
  `expected ['yold','xmid','zlate'] to equal
  ['zlate','xmid','yold']` — the genuinely-newest action shown
  last in the accountability log; fix restored, suite back to
  504 green.
- `pnpm check` EXIT=0, every workspace green (mcp 504, cli 739,
  api …) — no regression; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic sort logic — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. The `muse actions` / `/api/actions` accountability log now
orders by real recorded instant, so the most-recent autonomous
action Muse took on the user's behalf is reliably shown first
even when entry timestamps differ in precision or carry a
timezone offset. The 418 / 461 instant-compare standard now
covers the named sibling 461 referenced. The append-only
durability path is unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an 418/461 sibling-asymmetry
correctness `fix:`, recorded honestly with this backlog row —
not a false metric.

## Decisions

- Byte-parallel to `queryVetoes` (461) / `compareRemindersByDueAt`
  (418): the newest-first review comparators must be
  indistinguishable on this contract; a near-variant is the
  drift the single-source fixes (413/432) prevent.
- Declined a `clampPositive` "fix" found during the systematic
  parseInt sweep: its lenient-prefix behaviour is **explicitly
  pinned as deliberate** by its test ("lenient prefix parse",
  "pins behaviour vs a future Number() refactor") — a conscious
  human design decision the loop must not override. Recorded as
  a deferred-ledger line, not changed (the contract's
  no-manufacturing discipline; distinct from 461, where the
  codebase's standing decision was *to fix* and no test pinned
  the bad behaviour).
