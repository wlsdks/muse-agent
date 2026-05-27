# 387 — P5 target-completion audit (the P→P seam check)

## Why

All three P5 bullets (b1 durable register-survives-restart; b2
autonomous tick re-evaluation w/ backoff & escalation; b3
act-as-the-user under recorded scoped consent) are `[x]` and no
`P5 audit —` line existed. Per the iteration-loop contract Step 4,
the sole mandate of this iteration is to re-run every P5
CAPABILITIES check together AND exercise P5 as one end-to-end
delegation flow against the falsifiable test.

## Verify

- The three P5 piece-checks re-run green TOGETHER:
  `@muse/mcp` personal-objectives-store.test.ts +
  objective-evaluation-loop.test.ts + consented-action.test.ts,
  18/18.
- New seam: `packages/mcp/src/p5-seam.test.ts` 2/2.
- `pnpm --filter @muse/mcp test` 415 pass; tsc strict clean (ran
  proactively); `pnpm check` green across all workspaces (apps/cli
  683, all packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched — injected fetch / pure
  data layer; the bullets' mandated checks are integration, which
  is what the seam is. No smoke:live applies.

## Status

PASS. Unlike P4 (independent trust-closures, no natural
composition), P5's three bullets ARE a composed delegation
pipeline, so the audit's "exercise it end-to-end" is a real seam
test. `p5-seam.test.ts` drives the join through the **real**
on-disk stores with every read a fresh call (no shared in-memory
= exactly what a restarted process / the next ~20-min tick sees):

1. register a durable objective (b1) → "restart": a fresh read
   still has it `active`;
2. tick 1 — evaluate unmet → exponential backoff persisted
   (`attempts`/`nextEvalAt`) → "restart": the backoff state
   survived to disk, and the objective is correctly NOT due before
   `nextEvalAt`;
3. tick 2 past the window — evaluate met → the action is
   `performConsentedAction` with consent recorded → the real
   (HTTP-faked) external request fires carrying the scoped
   `Bearer` credential (b3) → "restart": the objective is durably
   `done`;
4. negative composition — a second objective with NO consent →
   met → fail-closed (no HTTP, no credential use) → the objective
   is NOT falsely completed and stays `active` across a restart.

This is the genuine seam the three isolated tests do not cover:
durability ACROSS the pieces — the whole delegation surviving
process restarts and composing over multiple ticks, plus the
fail-closed consent gate composing with the durable lifecycle. No
drift; no bullet reopened. P5 (durable delegated objectives /
long-horizon agency) is genuinely delivered end-to-end. P0, P1,
P2, P3, P4, P5 are now all delivered + audited. Next iteration
resumes Step 5 selection on the highest unmet OUTWARD-TARGETS
bullet — the next frontier is P6 (accountability & correction
loop).

## Decisions

- A seam test IS warranted here, in contrast to the P4 audit's
  documented decision not to add one: P4's bullets were
  independent trust-closures; P5's three bullets are a genuine
  composed pipeline (register → re-evaluate → consented act) whose
  join carries a real risk the isolated tests miss — durability
  across the pieces and across the ~20-min / restart boundary. The
  audit adapts its exercise to the target's shape rather than
  cargo-culting either way.
- The "restart" is modelled as a fresh `readObjectives` /
  `readConsents` call sharing no in-memory state with the writes —
  the same technique P5-b1's own check used, applied across the
  whole pipeline. That is the faithful, cheap way to prove the
  ~20-min-boundary survival the P5 north star demands.
- No CAPABILITIES line appended and no bullet flipped: per Step 4
  the audit verifies already-flipped bullets compose; its
  deliverable is the README ledger `P5 audit — … — PASS` line
  (and a REOPEN on drift, which did not occur). `test(mcp)`
  mirrors the P0/P1/P2/P3 audit commits.
