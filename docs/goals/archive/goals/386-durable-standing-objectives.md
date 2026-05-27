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
- s2 (P5-b2, DONE): `packages/mcp/src/objective-evaluation-loop.ts`
  — `runDueObjectives`: picks every `active` objective whose
  backoff window elapsed, asks an injected `evaluate`, and: met →
  `act` once then durable `done`; unmet → exponential-backoff
  retry (`attempts`/`nextEvalAt` bumped, not due before it);
  unmeetable OR `maxAttempts` exhausted → durable `escalated` +
  optional `escalate` sink (never silently dropped); evaluator/
  action throw → fail-open (recorded, stays active, loop survives).
  Added a minimal `patchObjective` durable status-flip to the
  store. Verified by `objective-evaluation-loop.test.ts`.
- s3 (P5-b3, DONE): `personal-consent-store.ts` (durable scoped
  consent records, same posture) + `consented-action.ts`
  (`performConsentedAction`): fail-closed — `hasConsent` is
  checked BEFORE the credential is touched, so absent or
  scope-mismatched consent ⇒ no credential resolution and no HTTP;
  recorded consent ⇒ the real (HTTP-faked) external request fires
  carrying the scoped `Bearer` credential. Composed with
  `runDueObjectives`: met objective → consented action → durable
  `done`; no-consent → fail-closed, objective NOT falsely
  completed (stays active). Verified by `consented-action.test.ts`.

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

P5-b2 done. `runDueObjectives` autonomously re-evaluates active
objectives on a tick: the integration test proves condition-met →
the action fires exactly once → the objective is durably marked
`done` (read back from the real on-disk store); unmet →
exponential backoff (`nextEvalAt` grows 2^n, not due before it);
unmeetable / attempts-exhausted → durably `escalated` + escalate
sink (never silently dropped); a throwing evaluator/action is
fail-open (recorded, objective stays active, loop survives, and
`done` is NOT set if `act` failed). P5-b2 flipped `[ ]`→`[x]`; one
CAPABILITIES line appended; README backlog row updated.

A `tsc` strict error (`async (o) => acted.push(o.id)` returns
`Promise<number>`, not the `Promise<void>` the callback type
requires) surfaced under `pnpm check` though vitest's esbuild
transpile passed — root-fixed with block-body callbacks, not
worked around.

P5-b3 done. The act-as-the-user gate is fail-closed and
deterministic: `hasConsent` runs before any credential use, so no
consent / scope-mismatched consent ⇒ no HTTP call (the scoped
credential is never even resolved); a matching consent record ⇒
the real HTTP-faked external request fires carrying the scoped
`Bearer` credential. End-to-end through `runDueObjectives`: a met
objective performs the real external action and is durably marked
`done`; without consent the objective is NOT falsely completed
(the failed action keeps it active for backoff). P5-b3 flipped
`[ ]`→`[x]`; one CAPABILITIES line appended; README backlog row
flipped to done.

**P5 fully delivered (b1 durable register · b2 autonomous
re-evaluation w/ backoff & escalation · b3 act-as-the-user under
recorded consent).** Next iteration: per contract Step 4, the P5
target-completion audit.

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
- P5-b2's `evaluate`/`act`/`escalate`/`now` are injected — the
  exact proven `runDueFollowups` seam — so the integration test
  runs without env/network/model while the backoff math, status
  transitions and durable persistence (real `patchObjective` →
  real on-disk store, asserted via `readObjectives`) are fully
  real. The bullet's check is "(integration)"; this is it. Wiring
  a concrete LLM/condition-source evaluator + the `setInterval`
  daemon is the daemon-wiring concern, not this bullet's check.
- `act` runs BEFORE the `done` flip and both are inside the
  per-objective try: if `act` throws, the objective is NOT marked
  done (stays active, retried next tick) — a delivered action must
  never be lost to a half-applied state.
- P5-b3 security posture (CLAUDE.md non-negotiable — guards
  fail-close, security is deterministic code, not prompt): the
  consent check is the FIRST thing `performConsentedAction` does;
  it returns before the credential is read or any request is made,
  and `hasConsent` degrades to `false` on any read/parse error (no
  consent ⇒ no action — the safe direction). Scope match is exact:
  consent for `github:issues:read` does NOT authorise
  `github:issues:write` — consent is never broadened implicitly.
- The scoped credential is passed into `performConsentedAction`,
  not resolved from a vault here — credential storage/rotation is
  a separate concern the bullet's check does not require; baking a
  vault in would be speculative over-building.
