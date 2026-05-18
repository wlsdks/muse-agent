# 391 — P7 target-completion audit (the P→P seam check)

## Why

Both P7 bullets (b1 a recorded veto surfaces into agent run
context; b2 learned avoidances are reviewable + clearable) are
`[x]` and no `P7 audit —` line existed. Per the iteration-loop
contract Step 4, the sole mandate of this iteration is to re-run
every P7 CAPABILITIES check together AND exercise P7 as one
end-to-end correction-revocation flow against the falsifiable
test.

## Verify

- The two P7 piece-checks re-run green TOGETHER:
  `@muse/agent-core` veto-avoidance.test.ts 5/5 +
  `@muse/mcp` personal-veto-store.test.ts 5/5.
- New seam: `apps/api/test/p7-seam.test.ts` 1/1.
- `pnpm --filter @muse/api test` 172 pass; `pnpm check` green
  across all workspaces (apps/cli 683, all packages); `pnpm lint`
  0/0; `pnpm guard:core` clean.
- No source change — the audit adds only the seam test. No real
  LLM (capture provider, deterministic) → no smoke:live applies.

## Status

PASS. P7's two bullets ARE a composed correction-revocation
lifecycle (a veto surfaces into live runs → the user reviews →
clears → the directive must stop injecting). The
`mcp ↛ agent-core` dependency boundary deliberately forced the
isolated tests apart: P7-b1 drove `createAgentRuntime` with an
in-memory provider; P7-b2 asserted only the provider-shaped input
transition. `apps/api` depends on BOTH packages, so
`p7-seam.test.ts` is the one place the seam composes for real —
the REAL `@muse/mcp` veto store, behind the production-shape
`readVetoes → VetoAvoidanceProvider` adapter, driven through the
REAL `createAgentRuntime` pipeline:

1. no veto → a live run carries no `[Learned Avoidance]`;
2. `recordVeto` (real store) → the next live run carries
   `[Learned Avoidance]` naming the scope + reason (b1 over the
   real store);
3. `queryVetoes` lists it (b2 review surface);
4. `removeVeto` (real one-tap clear) → a subsequent live run no
   longer carries the directive — clearing genuinely un-does b1's
   LIVE injection, not just the provider-shape proxy the
   dependency boundary forced P7-b2 to assert.

This is the genuine seam neither isolated test could cover, and
it incidentally proves the deferred production adapter
(`readVetoes → VetoAvoidanceProvider`) is shape-sound — so that
deferred ledger item is resolved down to a pure server-assembly
wiring line. No drift; no bullet reopened. P7 (learns from
correction) is genuinely delivered end-to-end.

**P0, P1, P2, P3, P4, P5, P6, P7 are now ALL delivered +
audited** — the loop-authored P7 has itself been seam-verified.
Per the OUTWARD-TARGETS contract the next iteration self-extends
the map again toward the north star (no human authors it).

## Decisions

- A seam test IS warranted (as for P5/P6, not P4): P7's bullets
  form a composed lifecycle, and the genuine join risk is
  precisely the one the `mcp ↛ agent-core` boundary hid — does a
  real clear un-do a real live injection? `apps/api` (depends on
  both) is the correct, layering-respecting home for that
  composition; putting it in either package would invert the
  dependency graph.
- The seam test doubles as proof the deferred P7-b1 production
  adapter shape is correct, so its Rejected-ledger line is marked
  RESOLVED down to the remaining pure wiring placement — honest
  scoping, not scope creep (no server-assembly change shipped
  here; that stays a separate trivial follow-up).
- No CAPABILITIES line and no bullet flipped: per Step 4 the audit
  verifies already-flipped bullets compose; deliverable is the
  README ledger `P7 audit — … — PASS` line. `test(api)` mirrors
  the P1/P2 audit commits (seam test lives in apps/api).
