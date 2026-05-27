# 393 — P8 target-completion audit (the P→P seam check)

## Why

P8's two bullets and no `P8 audit —` line — the Step-4 trigger.
The audit immediately earned its keep: it caught that goal 392
slice 1 delivered P8-b1 (green check, `— 392` annotation,
CAPABILITIES line, README "done" row) but **never flipped the
OUTWARD-TARGETS checkbox** — it sat `- [ ]` while P8-b2 was
correctly `- [x]`. The bullet flip is THE metric; a delivered
capability whose checkbox didn't flip is precisely the
"marked done but went sideways" failure the P→P seam check exists
to find.

## Verify

- Drift confirmed not a capability defect: `@muse/mcp`
  situational-briefing.test.ts re-run 5/5 green — P8-b1 was always
  genuinely delivered; only the metric glyph drifted. Checkbox
  corrected `[ ]`→`[x]` (NOT a re-deliver, NOT a REOPEN).
- Both P8 piece-checks re-run green TOGETHER: situational-briefing
  .test.ts 5/5 + situational-briefing-loop.test.ts 3/3.
- New seam: `packages/mcp/src/p8-seam.test.ts` 1/1.
- `pnpm --filter @muse/mcp test` 463 pass; tsc strict clean (ran
  proactively); `pnpm check` green across all workspaces (apps/cli
  683, all packages); `pnpm lint` 0/0; `pnpm guard:core` clean
  (the checkbox correction is outside IMMUTABLE-CORE).
- No request/response (LLM) path touched — deterministic compose +
  HTTP-faked delivery. No smoke:live applies.

## Status

PASS. Two parts:

1. **Drift correction.** Goal 392 s1's missed checkbox flip was
   the audit's first finding. The capability was verified-green
   then and now (situational-briefing.test.ts 5/5), so this is a
   bookkeeping-glyph drift, not a regression: the checkbox was
   corrected to `[x]` to match the already-true CAPABILITIES /
   README / annotation state. This is the sanctioned drift-catch
   the audit is for — not a REOPEN (the check never failed) and
   not gaming (the flip reflects a genuinely-delivered, re-falsified
   capability).

2. **Seam audit.** P8's bullets ARE a composed pipeline (b1
   synthesise → b2 deliver-deduped). The isolated tests cover each
   piece and `runDueSituationalBriefing` already composes the
   composer; the residual seam the audit must prove is the WHOLE
   situational picture delivered intact over the real channel.
   `p8-seam.test.ts` seeds the REAL objectives store with an
   active + an escalated + a done objective and two imminent
   items, runs `runDueSituationalBriefing` over a real
   `TelegramProvider` (HTTP boundary faked), and asserts ONE Bot
   API POST whose body carries: soonest-first `Upcoming:` (task
   before the later calendar event), `Needs you: ⚠ … — max
   attempts exhausted`, `Still tracking: …`, and NOT the finished
   objective — then a second in-window tick is deduped by the real
   sidecar (no re-POST). No further drift; no bullet reopened. P8
   (proactive situational briefing) is genuinely delivered
   end-to-end.

**P0, P1, P2, P3, P4, P5, P6, P7, P8 are now ALL delivered +
audited.** Per the OUTWARD-TARGETS contract the next iteration
self-extends the map again toward the north star.

## Decisions

- Correcting the missed flip rather than re-delivering or
  REOPENing is the honest, contract-aligned action: REOPEN is for
  a check that drifted/failed (it didn't — 5/5 green both then and
  now); a no-op re-deliver is banned. The metric (OUTWARD-TARGETS
  checkboxes) must reflect reality, and reality is "P8-b1 delivered
  & green" — so the checkbox is corrected, the discrepancy recorded
  in the ledger, and the audit proceeds.
- A seam test IS warranted (as for P5/P6/P7): P8 is a composed
  pipeline; the genuine join risk is the full multi-source
  situational picture surviving intact through compose →
  real-channel send → dedupe, which the per-piece tests don't
  exercise together (b2's test used a single active objective; the
  seam adds escalated "Needs you", done-excluded, multi-imminent
  ordering, over the real store + real provider).
- No CAPABILITIES line and no NEW bullet flip from the audit
  itself (the b1 flip is a *correction* of 392's, not a fresh
  delivery): per Step 4 the audit verifies already-delivered
  bullets compose; deliverable is the README ledger
  `P8 audit — … — PASS` line. `test(mcp)` mirrors the
  P0/P3/P5/P6 audit commits.
