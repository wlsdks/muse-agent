# 402 — P7 learn-from-correction wired into the production runtime

## Why

The last two iterations (400, 401) both deepened the
situational-briefing imminence area — to avoid over-concentrating
on one area, this iteration targets a different one. A grep
confirmed a real, standing gap: `vetoAvoidanceProvider` /
`readVetoes` appear NOWHERE in `apps/api/src` or
`packages/autoconfigure/src`. P7's learn-from-correction
(`applyVetoAvoidance`) is built and live-pipeline-wired in
`@muse/agent-core`, but the production server never constructs a
`vetoAvoidanceProvider` — so in a real running Muse, a recorded
veto did NOT actually stop the agent proposing the corrected
class. This is exactly the "P7-b1 production adapter wiring"
deferred ledger item (the goal-391 P7 audit marked it
RESOLVED-to-a-pure-wiring-line; the wiring line was never shipped).

## Slice

- `packages/autoconfigure/src/provider-paths.ts`:
  `resolveVetoesFile(env)` → `~/.muse/vetoes.json` (env-overridable
  via `MUSE_VETOES_FILE`), re-exported through
  `personal-providers.ts` like the sibling resolvers.
- `packages/autoconfigure/src/context-engineering-builders.ts`:
  `buildVetoAvoidanceProvider(env)` — adapts the real `@muse/mcp`
  `readVetoes` store to the agent-runtime's duck-typed
  `VetoAvoidanceProvider` (user-scoped `{scope,objectiveId,reason}`
  mapping — the exact shape proven by `p7-seam.test.ts`).
  Default-on (the transform is conservative: zero vetoes ⇒ exact
  no-op), opt out with `MUSE_VETO_AVOIDANCE=false`.
- `packages/autoconfigure/src/index.ts`: construct it and pass
  `...(vetoAvoidanceProvider ? { vetoAvoidanceProvider } : {})`
  into the production `createAgentRuntime` alongside the other
  context providers.

## Verify

- `packages/autoconfigure/test/veto-avoidance-provider.test.ts`
  2/2: a real recorded veto → the built provider's `listVetoes`
  returns the user-scoped mapped `LearnedVeto[]`; another user's
  veto is not leaked; `MUSE_VETO_AVOIDANCE=false` ⇒ `undefined`;
  default-on; a missing store is tolerant (`[]`).
- `@muse/autoconfigure` 138 pass; tsc strict clean (ran
  proactively); `pnpm check` green across all workspaces (apps/cli
  683, all packages — the cross-package autoconfigure ↔ agent-core
  ↔ mcp wiring compiles+tests clean); `pnpm lint` 0/0;
  `pnpm guard:core` clean.
- No NEW request/response (LLM) round-trip is introduced — this
  only constructs+passes the provider; the
  `applyVetoAvoidance` live-pipeline behaviour it feeds was
  already verified at the `@muse/agent-core` layer
  (veto-avoidance.test.ts) and end-to-end by `p7-seam.test.ts`.
  For a user with no recorded vetoes the request/response path is
  byte-identical (zero vetoes ⇒ exact no-op), so no smoke:live
  applies.

## Status

Done. P7's learn-from-correction is now LIVE in the production
runtime: a configured Muse server, when the user has recorded a
veto, surfaces `[Learned Avoidance]` into real agent runs so it
stops proposing the corrected class everywhere — not just at the
consented-action gate. The deferred "P7-b1 production adapter
wiring" ledger item is FULLY RESOLVED (README ledger updated).

No bullet flip / no new CAPABILITIES line: P7-b1's bullet was
already `[x]` on its mandated agent-core integration check (goal
390); the apps/api adapter was always the explicitly-
not-required-by-the-bullet follow-up. This discharges that
deferred follow-up — the same shape as the P9 daemon
productionisation slices — a real functional diff that makes a
built-but-dormant capability actually run, recorded honestly
without claiming a new metric.

## Decisions

- Default-on is correct, not gold-plating: P7's transform is
  conservative by construction (zero vetoes ⇒ exact no-op), so a
  user who has NOT corrected Muse sees zero behaviour change,
  while a user who HAS corrected it gets the correction respected
  — which is the entire point of "learns from correction". An
  opt-out env exists for parity with the other context providers.
- `buildVetoAvoidanceProvider` lives in
  `context-engineering-builders.ts` next to
  `buildActiveContextProvider` / `buildInboxContextProvider` so
  every context provider is constructed the same way; the duck
  type keeps `@muse/mcp` ↛ `@muse/agent-core` layering intact.
- Chosen as a deliberately different area from the prior two
  briefing-imminence iterations (Step-8 anti-concentration), and
  because closing a "built but dead in production" gap is genuinely
  more outward than further briefing polish.
