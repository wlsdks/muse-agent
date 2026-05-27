# 389 — P6 target-completion audit (the P→P seam check)

## Why

Both P6 bullets (b1 reviewable autonomous-action log; b2 one-tap
undo/veto that blocks recurrence) are `[x]` and no `P6 audit —`
line existed. Per the iteration-loop contract Step 4, the sole
mandate of this iteration is to re-run every P6 CAPABILITIES check
together AND exercise P6 as one end-to-end correction-loop flow
against the falsifiable test.

## Verify

- The two P6 piece-checks re-run green TOGETHER:
  `@muse/mcp` personal-action-log-store.test.ts +
  undo-action.test.ts, 9/9.
- New seam: `packages/mcp/src/p6-seam.test.ts` 1/1.
- `pnpm --filter @muse/mcp test` 435 pass; tsc strict clean (ran
  proactively); `pnpm check` green across all workspaces (apps/cli
  683, all packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched — pure data layer +
  composition with the existing autonomous-action path; the
  bullets' mandated checks are integration, which the seam is. No
  smoke:live applies.

## Status

PASS. Like P5 (and unlike P4's independent trust-closures), P6's
two bullets ARE a composed loop — see (b1) → undo + teach (b2) →
the undo is itself logged (b1) → the durable veto blocks the
trigger → that refusal is logged too (b1). The audit's
"exercise it end-to-end" is therefore a real seam test.
`p6-seam.test.ts` drives the whole cycle through the **real**
on-disk stores with every read a fresh call (no shared in-memory
= a restarted process):

1. an autonomous consented action performs → is logged (b1);
2. the user reviews the log and sees the `performed` entry;
3. `undoLoggedAction` reverses it (injected inverse) + records a
   durable memory veto + logs the undo itself (b2 + b1);
4. "restart": `hasVeto` over a fresh read confirms the veto
   survived to disk;
5. the same trigger recurs → `performConsentedAction` is refused
   by the durable veto (no HTTP, the objective is NOT falsely
   completed) → that refusal is logged too;
6. a final review query returns the complete durable audit trail
   `[refused, undo, performed]` newest-first, with the latest
   entry's detail showing the veto reason.

This is the genuine seam the two isolated tests do not cover
together: the whole see·undo·teach loop composing AND surviving a
process restart — the P6 north star end-to-end. No drift; no
bullet reopened. P6 (accountability & correction loop) is
genuinely delivered.

**P0, P1, P2, P3, P4, P5, P6 are now ALL delivered + audited.**
Per the OUTWARD-TARGETS contract ("the loop extends this map
itself when all are delivered … 'nothing to do' is impossible by
construction"), the next iteration's mandate is to self-extend the
target map toward the north star — a stronger outward direction
the loop chooses by its own judgement, recorded in the new goal's
`## Decisions`.

## Decisions

- A seam test IS warranted (as for P5, in contrast to the P4
  audit's documented no-seam decision): P6's bullets form a
  genuine composed correction loop whose join carries a real risk
  the isolated tests miss — the undo flowing back into the log,
  and the whole loop's durability across a restart. The audit
  adapts its exercise to the target's shape.
- A test-fixture bug surfaced and was fixed at the root, not
  worked around: the shared `act` helper initially hardcoded the
  log entry's `when`, so the recurrence's refused entry sorted
  with the original action instead of after the undo. Fixed by
  stamping each entry with the actual tick time + a monotonic seq
  id — the test now faithfully reflects chronology.
- No CAPABILITIES line appended and no bullet flipped: per Step 4
  the audit verifies already-flipped bullets compose; its
  deliverable is the README ledger `P6 audit — … — PASS` line.
  `test(mcp)` mirrors the P0/P1/P2/P3/P5 audit commits.
