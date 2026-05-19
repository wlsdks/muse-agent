# 461 — `queryVetoes` orders by parsed instant, not lexicographic ISO (418 sibling)

## Why

`queryVetoes` (`@muse/mcp` `personal-veto-store.ts`) is the
user-facing "what Muse learned not to do" review surface — its
docstring and the existing test both state it is the
**newest-first** review surface (P7-b2). It sorted with
`b.vetoedAt.localeCompare(a.vetoedAt)` — a **lexicographic** ISO
string compare.

The codebase has a *standing, documented decision* that this is a
defect class: goal 418 fixed `compareRemindersByDueAt`
("compare parsed instants, not raw ISO strings"); the
`advanceInboxInjectionCursor` comment states it verbatim
("lexicographic ordering is wrong across mixed precision
'…01.500Z' sorts BEFORE '…01Z' and timezone offsets").
`queryVetoes` is the **unfixed sibling** still using the banned
lexicographic compare on a surface whose *order is its product*.

`vetoedAt` is a caller-supplied ISO string (the P6-b2 / P7
correction loop, the REST/MCP record path, hand-edited
`vetoes.json`) — not guaranteed canonical. A veto written
`…00.500Z` and another `…00Z` (same second, mixed precision), or
one with a `-05:00` offset, sort by string in an order that does
not match their real instants — so the user sees their learned
avoidances in the **wrong order**, and the genuinely-newest veto
can be shown last. Not manufactured: it is the exact 418 footgun
on the one ordered surface that missed the fix (the 432 / 443 /
457 "fix the sibling carrying the identical gap" pattern). The
existing `queryVetoes` test uses only canonical `…000Z` stamps
(where lexicographic == instant), so the mixed-precision/offset
case was **genuinely uncovered**.

## Slice

- `packages/mcp/src/personal-veto-store.ts` — `queryVetoes` now
  sorts by `Date.parse` instants (newest-first, descending),
  byte-parallel to goal 418's `compareRemindersByDueAt`:
  finite-vs-finite → `bMs - aMs`; otherwise a deterministic
  `localeCompare` fallback for unparseable values; equal → 0
  (stable). `hasVeto` (the safety membership check) is
  order-independent and untouched.
- `packages/mcp/src/personal-veto-store.test.ts` — a new `it`:
  three vetoes whose UTC instants are `zlate > xmid > yold` but
  whose ISO strings sort lexicographically `yold > xmid > zlate`
  (a `-05:00` offset + a same-second `.500Z`/`Z` pair — the 418
  patterns); asserts the review returns `["zlate","xmid","yold"]`.

## Verify

- New `it` green; full `@muse/mcp` suite 502 passed (34 files,
  +1); the existing canonical-timestamp `queryVetoes` test still
  green (lexicographic == instant for `…000Z`, so no
  wrong-premise); tsc strict (mcp) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to
  `b.vetoedAt.localeCompare(a.vetoedAt)` makes the new test fail
  with `expected ['yold','xmid','zlate'] to equal
  ['zlate','xmid','yold']` — i.e. lexicographic put the
  genuinely-newest veto LAST; fix restored, suite back to 502
  green.
- `pnpm check` EXIT=0, every workspace green (mcp 502, cli 739,
  api …) — no regression; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic sort logic — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. The veto review surface ("what Muse learned not to do")
now orders by real recorded instant, so the most-recently-learned
avoidance is reliably shown first even when timestamps differ in
precision or carry a timezone offset. The codebase's own
established instant-compare standard is now applied to the
sibling that missed it. `hasVeto` (the deny-layer safety check)
was already order-independent and is unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an 418 sibling-asymmetry correctness
`fix:`, recorded honestly with this backlog row — not a false
metric.

## Decisions

- Byte-parallel to `compareRemindersByDueAt` (418): the two
  newest-first comparators must be indistinguishable on this
  contract; a near-variant would itself be the drift the
  single-source fixes (413/432) exist to prevent.
- Surveyed first (channel-approval-gate, inbox-injection-cursor,
  MonthlyBudgetTracker, PromptDriftDetector — all confirmed
  mature + already covered, no bug manufactured); this is the
  one concrete sibling-of-an-established-fix defect found, not a
  speculative change.
