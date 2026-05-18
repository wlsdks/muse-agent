# 390 — Learns from correction (P7-b1) — loop-authored target

## Why

P0–P6 are all delivered + audited. Per the OUTWARD-TARGETS
contract ("the loop extends this map itself when all are
delivered … using its own judgement and best-practice knowledge
of what a great personal AI assistant does"), this iteration
self-extends the map with **P7 — Learns from correction**, chosen
by the loop's judgement (no human authored it).

The reasoning: P6 closed the *mechanical* correction loop — the
exact vetoed `{objective,scope}` is refused on recurrence at
`performConsentedAction`. But a JARVIS-grade assistant that is
corrected stops *proposing* the class everywhere, not only at the
one gate, and lets the user see/unlearn it. Today a recorded veto
informs only the consented-action gate; it does not shape the
agent's general reasoning on any other surface. That is the
genuine next outward gap, and it composes naturally on the
now-complete P0 (context injection) + P6 (veto store) substrate.

## Slices

- s1 (P7-b1, THIS): `packages/agent-core/src/veto-avoidance.ts` —
  `applyVetoAvoidance`, a context transform mirroring the proven
  `applyClarifyDirective` / `applyAmbientContext` pattern. A
  duck-typed `VetoAvoidanceProvider` (so `agent-core` keeps NO
  `@muse/mcp` dependency — the dependency direction is mcp →
  agent-core, never the reverse). When the user has recorded
  vetoes it prepends a `[Learned Avoidance]` system block naming
  the corrected class + reason; **conservative + fail-open**: no
  provider / no `metadata.userId` / zero vetoes / a throwing
  provider ⇒ the input is returned unchanged. Wired LIVE into the
  agent-runtime context pipeline (right after ambient context)
  behind an opt-in `AgentRuntimeOptions.vetoAvoidanceProvider`.
  Verified by `packages/agent-core/test/veto-avoidance.test.ts`.
- s2 (P7-b2, next): the learned avoidances are reviewable and
  clearable by the user ("what Muse learned not to do" + clear),
  so a correction is not permanent-by-accident.

## Verify

- `packages/agent-core/test/veto-avoidance.test.ts` 5/5 (run
  directly) and within `pnpm --filter @muse/agent-core test`
  (572 pass, +5, no regression); tsc strict clean (ran
  proactively).
- `pnpm check` green across all workspaces (apps/cli 683, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- The wiring touches the request/response path, so `pnpm
  smoke:live` ran a real local-Ollama-Qwen round-trip (a real
  `/api/chat` completed `200` in ~107s — genuine slow qwen3:8b).
  It then ELIFECYCLE'd exit 1: the pre-existing **ledgered
  local-Qwen nondeterminism** (README Rejected, 377 s2 — qwen3:8b
  free-form-output variance + cold-load slowness on live-LLM
  substring assertions), **not a regression**: no
  `vetoAvoidanceProvider` is wired anywhere in `apps/api` /
  `apps/cli` / `autoconfigure`, so `applyVetoAvoidance` hits its
  `!provider` early return and the smoke path is byte-identical
  pre/post (the green deterministic apps/api + agent-core suites
  confirm zero drift). Not `[UNVERIFIED-LIVE]` — the round-trip
  executed; the failures are environmental small-model variance on
  endpoints this gated-off change cannot affect.

## Status

P7-b1 done. The bullet's check ("vetoes recorded → a later agent
run's context carries the avoidance directive; none → no-op
(integration)") is delivered end-to-end through the real
agent-runtime pipeline: `createAgentRuntime` with a
`VetoAvoidanceProvider` wired — a recorded veto makes the next
`runtime.run`'s model request carry `[Learned Avoidance]` naming
`github:issues:write` + the reason; with no veto recorded the
system context carries no such block. Gating (no provider / no
userId / zero vetoes) and fail-open (throwing provider) are
covered, and an injection-bearing veto reason is whitespace-
collapsed so it cannot forge a section. P7-b1 flipped `[ ]`→`[x]`;
one CAPABILITIES line appended; README backlog row added.

P7-b2 stays `[ ]` (separate bullet, separate slice).

## Decisions

- This flips P7-b1 on the `createAgentRuntime` integration with a
  duck-typed provider — the exact precedent P3-b1
  (`ambient-context-runtime.test.ts` with `{ snapshot }`) and the
  p0-seam (`InMemoryUserMemoryStore`) set: an injected
  real-shaped provider driven through the live runtime IS the
  integration the bullet's check names, not a unit-only test.
- `agent-core` must NOT depend on `@muse/mcp` (dependency
  direction is mcp → agent-core). The veto store lives in
  `@muse/mcp`; the transform consumes a duck-typed
  `VetoAvoidanceProvider`. The concrete adapter
  (`@muse/mcp` `readVetoes` → `VetoAvoidanceProvider`) wired into
  the apps/api server is a thin production-wiring follow-up — NOT
  required by this bullet's stated integration check (mirrors how
  P3-b1's real osascript provider was a follow-up to its
  createAgentRuntime flip); recorded as a deferred ledger line.
- Conservative-by-construction is a hard requirement, like the
  ambient transform: zero vetoes ⇒ exact no-op, so an
  un-corrected user and `smoke:live` (whose user has no vetoes)
  are behaviourally unchanged — the live wiring is safe.
- `feat(agent-core)`: a new perceivable behaviour (Muse visibly
  stops proposing what it was corrected on), consistent with how
  the clarify / ambient transforms were typed.
