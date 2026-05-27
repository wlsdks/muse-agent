# 759 — P20 target-completion audit (the P→P seam check)

## Why

P20's two bullets are `[x]` — Knowledge (multi-doc RAG with citation,
754/755) and Perception (ambient signal → proactive notice, 756) — and
no `P20 audit —` line existed. Per the iteration-loop contract Step 4,
this iteration re-runs the P20 CAPABILITIES checks TOGETHER AND
exercises P20 as one end-to-end flow. The two bullets deepen
independent thin axes, so the seam to prove is that BOTH deliver their
user flow in one realistic assistant setup without interference.

This is also the 10th-iteration regression sweep (mechanical counter)
since the 2026-05-23 retarget.

## Verify

- New seam: `@muse/autoconfigure` p20-seam.test.ts 1/1 — ONE scenario:
  a `createAgentRuntime` with `knowledge_search` over a LIVE temp-dir
  notes corpus answers grounded ("peanuts and shellfish") AND cites
  `notes/health.md`; then `runAmbientNoticeTick` delivers a proactive
  notice through a real `ProactiveNoticeSink` from a simulated
  active-window signal. Both P20 capabilities work in the same setup.
- Piece-checks re-run green TOGETHER: @muse/mcp ambient-notice-loop
  6/6, @muse/agent-core knowledge-recall-agent 5/5, @muse/autoconfigure
  knowledge-corpus-live + p20-seam 5/5.
- **Regression sweep (10th iteration)**: full `pnpm check` EXIT 0 —
  all 26 workspace suites green (the unit/integration CAPABILITIES
  checks). `pnpm lint` 0/0. Test-only audit, no source change.
  `smoke:live` deferred — no request/response path changed since the
  retarget, so there is no live round-trip to re-run (not a skip of an
  affected check).

## Status

PASS. P20's deepened Perception + Knowledge both deliver for the user
in one assistant setup: it answers from your real notes WITH a source
citation, and it proactively notices an ambient signal unasked — and
they coexist without interference. No drift; no bullet reopened.
Recorded `P20 audit — … — PASS` in the README Rejected ledger.

## Decisions

- The two P20 bullets are orthogonal capabilities, so the seam is
  coexistence (both function in one assembled setup) rather than a
  data-flow handoff — verified honestly, not a forced coupling.
- Production-wiring follow-ons remain (a real OS active-window source
  + ambient daemon registration; live doc-ingest → corpus): these
  EXTEND the delivered capabilities, they don't reopen the audited
  bullets whose checks (a simulated signal; the live notes store) are
  green.
