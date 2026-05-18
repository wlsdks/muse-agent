# 386 — Durable standing objectives (P5-b1)

## Why

OUTWARD-TARGETS P5 ("durable delegated objectives — the trust-over-
time gap"): a standing objective ("watch for X / keep trying Y
until Z / tell me when W") is not a one-shot. Before any
re-evaluation or scoped acting can be built, the objective must
exist as **durable state** that survives a process restart and the
~20-min loop boundary — otherwise a delegated long-horizon goal
silently evaporates the moment the loop ticks over. P5-b1 is that
foundation; P5-b2 (tick re-eval + backoff/escalation) and P5-b3
(scoped-credential acting under consent) build on it.

## Slices

- s1 (P5-b1, THIS): `packages/mcp/src/personal-objectives-store.ts`
  — the durable register + persistence layer, mirroring the proven
  personal-followups-store / personal-tasks-store posture:
  - `StandingObjective` (id / userId / createdAt / spec / kind ∈
    watch|until|notify / status ∈ active|done|escalated|cancelled,
    plus optional `lastEvaluatedAt` / `attempts` / `nextEvalAt` /
    `resolution` typed for the next slice's persistence — fields
    only, no speculative tick logic).
  - `readObjectives` (tolerant: missing/bad-JSON/wrong-shape → [],
    corrupt store quarantined aside, never destroyed),
    `writeObjectives` (atomic tmp + fsync + rename, 0600),
    `addObjective` (register; idempotent on id),
    `serializeObjective`.
  Verified by `personal-objectives-store.test.ts`.
- s2 (P5-b2, next): tick re-evaluation with backoff — condition
  flips → action fires + marked done; unmet → backoff retry;
  unmeetable → escalate (never silently dropped).
- s3 (P5-b3, later): acting on an objective via the user's scoped
  service credential under recorded consent.

## Verify

- `packages/mcp/src/personal-objectives-store.test.ts` 7/7 (run
  directly) and within `pnpm --filter @muse/mcp test` (382 pass,
  +7, no regression).
- `pnpm check` green across all workspaces (apps/cli 683, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched — pure durable data
  layer; the bullet's mandated check is the durability integration
  ("register → restart → still tracked"), which is exactly the
  test; no smoke:live applies.

## Status

P5-b1 done. A standing objective registered via `addObjective`
survives a process restart: the `register → restart → still
tracked` integration test reads it back through a fresh
`readObjectives` call that shares no in-memory state with the
write — exactly what the next tick / a restarted process sees —
and the objective is intact. Accumulation across independent
registrations, idempotent re-register, missing/corrupt tolerance,
and 0600 round-trip are all covered. P5-b1 flipped `[ ]`→`[x]`;
one CAPABILITIES line appended; README backlog row added.

P5-b2 and P5-b3 stay `[ ]` (separate bullets, separate slices).

## Decisions

- This FLIPS P5-b1 (not a no-flip mechanism slice): P5's three
  bullets are independently checkable, and P5-b1's own mandated
  check is literally "register → restart → still tracked
  (integration)" — delivered green end-to-end. b2/b3 are distinct
  bullets, not split children of b1, so no parent-gating applies.
- The register entry point is the `addObjective` durable API
  exercised by the integration test (the bullet's falsifiable
  contract is the durability integration, not a specific CLI verb).
  A thin `muse objectives`/MCP-tool surface over `addObjective` is
  a natural follow-up but is NOT required by this bullet's stated
  check and is not gold-plated in here.
- The b2 persistence fields (`attempts` / `nextEvalAt` /
  `lastEvaluatedAt` / `resolution`) are typed on the record now so
  the on-disk schema is stable across the slice boundary (a
  re-registered objective from a later loop version round-trips),
  but NO tick/backoff logic ships this slice — that would be
  speculative over-building.
- `feat(mcp)`: a new user-world capability (delegate a durable
  long-horizon objective that no longer evaporates at the loop
  boundary), consistent with how the personal-store siblings were
  typed.
