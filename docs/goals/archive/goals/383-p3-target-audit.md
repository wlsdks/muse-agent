# 383 — P3 target-completion audit (the P→P seam check)

## Why

P3's only bullet (a gated perception daemon snapshots ambient
signals and injects them as run context unasked) is `[x]` and no
`P3 audit —` line existed. Per the iteration-loop contract Step 4,
the sole mandate of this iteration is to re-run the P3
CAPABILITIES check AND exercise P3 as one end-to-end user flow
against the falsifiable test — does the whole thing actually work
for the user, not just the piece in isolation?

## Verify

- The P3 piece-check passes: `@muse/agent-core`
  ambient-context.test.ts + ambient-context-runtime.test.ts 9/9.
- New seam: `packages/agent-core/test/p3-seam.test.ts` 3/3.
- `pnpm --filter @muse/agent-core test` 567 pass; `pnpm check`
  green across all workspaces (apps/cli 681, all packages);
  `pnpm lint` 0/0; `pnpm guard:core` clean.
- No source change — the audit adds only the seam test. No
  request/response (LLM) path touched (382 s2 already verified the
  live wiring with a real Qwen round-trip), so no smoke:live this
  iteration.

## Status

PASS. P3 is a single-bullet target, so the seam to prove is not
bullet-vs-bullet but **ambient-vs-the-rest**: does the gated
ambient block actually compose with the other live context
transforms in a real `runtime.run`, survive a failing provider
without breaking the run, and stay off by default even with other
context active? `p3-seam.test.ts` drives the real
`createAgentRuntime`:

1. ambient enabled + a user-memory provider → BOTH the
   `[Ambient Context]` and `[User Memory]` blocks reach the model
   (`appendSystemSection` merges into the first system message — no
   clobber); the composed pipeline works for the user, not just
   ambient alone;
2. a throwing ambient provider → the run still completes normally
   with the answer and the other context intact, just no ambient
   block — fail-open proven END-TO-END through the real runtime,
   not only the unit `resolveAmbientSnapshot`;
3. no ambient provider → no ambient block even when other context
   transforms are active — the privacy default-off is not
   accidentally bypassed by composition.

No drift; no bullet reopened. P3 (ambient perception loop) is
genuinely delivered end-to-end. P0, P1, P2, P3 are now all
delivered + audited. Next iteration resumes Step 5 selection on
the highest unmet OUTWARD-TARGETS bullet — the next frontier is P4
(close the trust-blocking PARTIALs: calendar WRITE surface check;
voice end-to-end round-trip check).

## Decisions

- For a single-bullet target the audit's "exercise it end-to-end"
  cannot be a bullet-composition test, so the seam chosen is the
  genuine integration risk the isolated tests skip: ambient is the
  4th transform in a multi-transform pipeline whose injector
  (`appendSystemSection`) MERGES into the first system message —
  a real composition hazard (clobber / ordering) the unit tests
  cannot see. The fail-open leg is upgraded from a unit assertion
  on `resolveAmbientSnapshot` to a full `runtime.run` so the
  "perception never breaks a run" invariant is proven where it
  actually matters.
- No CAPABILITIES line appended and no bullet flipped: per Step 4
  the audit verifies an already-flipped bullet composes; its
  deliverable is the README ledger `P3 audit — … — PASS` line
  (and a REOPEN on drift, which did not occur).
- `test:` commit — the diff is the seam test + ledger docs over
  unchanged production code, mirroring the P0/P1/P2 audit commits.
