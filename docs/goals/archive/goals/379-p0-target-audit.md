# 379 — P0 target-completion audit (the P→P seam check)

## Why

All four P0 bullets (b1 auto-extract on real use, b2 embedding
recall + preference applied, b3 proactive investigate-and-surface,
b4 ask-don't-guess) are `[x]` and no `P0 audit —` line existed.
Per the iteration-loop contract Step 4, the sole mandate of this
iteration is to re-run every P0 CAPABILITIES check together AND
exercise P0 as one end-to-end user flow against the falsifiable
test — does the whole thing actually work for the user, not just
each piece in isolation?

## Verify

- `@muse/agent-core` 555 pass (incl. auto-extract-tool-turn [b1],
  episodic-recall-embedding [b2], clarify-directive [b4], and the
  new p0-seam composition test).
- `@muse/mcp` 375 pass (notes-investigator + proactive-loop [b3]).
- `pnpm lint` 0/0.
- No source change — the audit adds only
  `packages/agent-core/test/p0-seam.test.ts`. No request/response
  path touched, so no smoke:live needed.

## Status

PASS. P0's four piece-checks are green together, and they compose:
`p0-seam.test.ts` drives the real exported pipeline functions in
the live agent-runtime order over the real memory store +
auto-extract hook —

1. a tool-using turn grows the user model under the run's userId
   (b1);
2. that fact is recalled on a LATER request that shares no tokens
   with it, via `applyUserMemory` wholesale injection — wording
   never gates recall (b2);
3. `applyUserMemory` → `applyClarifyDirective` in the live order:
   clarify stays silent on the well-specified later request (knows
   you ≠ spurious interrogation), yet an under-specified first turn
   IS steered to ask while the injected user memory remains present
   — the two context transforms compose, neither suppresses the
   other (b4 composes with knows-you).

b3 (proactive investigate-and-surface) lives on a different
surface — the proactive daemon, not the request path — and was
re-run green on its own (`@muse/mcp` notes-investigator +
proactive-loop). No drift; no bullet reopened.

P0 (knows-you · anticipates · asks) is genuinely delivered
end-to-end. Next iteration resumes Step 5 selection on the
highest unmet OUTWARD-TARGETS bullet (P1 is delivered+audited; the
next outward frontier is P2+).

## Decisions

- The audit's mandated "exercise the target as one end-to-end user
  flow" is a real composition test (`p0-seam.test.ts`), mirroring
  the P1 audit's `p1-seam.test.ts` — it asserts the seam the four
  isolated tests do not (pipeline ordering, wording-independent
  recall round-trip, no spurious clarification under injected
  memory). This is the audit doing its job, not an inward
  test-only iteration: it is the contract-mandated verification of
  a completed target.
- `applyUserMemory` is imported from `../src/context-transforms.js`
  (not re-exported from the package index); `applyClarifyDirective`
  is from the index. The test reproduces the exact live pipeline
  order in `agent-runtime.ts` (memory → clarify).
- No CAPABILITIES line appended and no bullet flipped: the audit
  verifies already-flipped bullets compose; per Step 4 its
  deliverable is the README ledger `P0 audit — … — PASS` line
  (and a REOPEN on drift, which did not occur).
