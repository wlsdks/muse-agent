# 397 — Objectives daemon + concrete model evaluator (P9-b2 final child — PARTIAL, live-decision [UNVERIFIED-LIVE])

## Why

Continuity: the final P9-b2 child — the objectives daemon
env-gated + registered with a concrete production
evaluator/actuator (the genuinely agent/LLM, smoke:live-class
remainder). Flipping it flips parent P9-b2.

## What shipped (deterministic, verified)

- `packages/mcp/src/objective-evaluator.ts`:
  - `createModelObjectiveEvaluator` — prompts the model for a
    strict `{"outcome":"met"|"unmet"|"unmeetable"}` verdict given
    the objective spec + current time; `parseObjectiveVerdict`
    extracts the first JSON object with a **conservative safe
    default**: anything not an unambiguous `met` / `unmeetable`
    (incl. garbage, no-JSON, a thrown model call) ⇒ `unmet` (defer
    to the next tick — never crash, never a false `met`, never a
    false `unmeetable`).
  - `createMessagingObjectiveActuator` — `act` / `escalate`
    deliver distinct notices over the messaging registry (reuses
    the proven retry-send; zero-LLM).
- `apps/api/src/tick-daemons.ts`:
  `startObjectivesDaemonIfConfigured` — exact mirror of the
  sibling daemon-set functions; off unless
  `MUSE_OBJECTIVES_PROVIDER` + `MUSE_OBJECTIVES_DESTINATION` +
  `objectivesFile` + a registered provider + `modelProvider` +
  `defaultModel`; builds the evaluator+actuator, starts the P9-b1
  rider, `addHook("onClose", stop)`. Wired into `server.ts`.

Verified: `@muse/mcp` objective-evaluator.test.ts 4/4 (parse:
met / unmeetable+reason / ambiguous-and-garbage⇒unmet; throwing
model ⇒ unmet; actuator act/escalate notices); `@muse/api`
objectives-daemon.test.ts 4/4 (env+options+provider+model →
onClose hook; absent env / no model / unregistered provider ⇒ not
started). `@muse/mcp` 471, `@muse/api` 187; `pnpm check` green
(apps/cli 683); `pnpm lint` 0/0; `pnpm guard:core` clean.

## Status — PARTIAL; parent P9-b2 NOT flipped

The env-gating + registration + evaluator strict-parse +
conservative fail-soft + actuator are SHIPPED and deterministically
verified. But P9-b2's CHECK also requires "the evaluator decides a
real objective's condition (integration/smoke:live)". Dog-fooded
against the loop's mandated local **qwen3:8b** (Ollama up): for a
clearly-met time condition the model did **not** reliably emit a
parseable verdict (empty content / OpenAI-compat endpoint errors),
so the evaluator returned its conservative safe default `unmet`.
The code is correct (it never crashed, never false-acted) — but
end-to-end with the mandated model it does NOT genuinely *decide*;
it always defers.

Per "verified or it does not exist": that clause is
**[UNVERIFIED-LIVE]**. It does NOT count toward the metric;
**parent P9-b2 stays `[ ]`** and no CAPABILITIES line is appended.
The deterministic wiring is shipped because it is safe by
construction (defer-not-act) and is a real, tested increment — but
the "decides" capability is explicitly NOT claimed.

Priority follow-up (clears the tag): make the small-local-model
verdict reliable — prompt-hardening for strict JSON-only output,
or a tool-using agent evaluator, or model-capability gating so the
objectives daemon only claims to decide on a model that can.

## Decisions

- The honest call is to ship the safe deterministic wiring and
  WITHHOLD the parent flip, tagging the live-decision
  [UNVERIFIED-LIVE] — exactly the contract's prescribed handling
  of a request/response capability whose real round-trip did not
  demonstrate it. Flipping P9-b2 on a "decides" claim the real
  model does not satisfy would be the "marked done but went
  sideways" dishonesty the machinery forbids.
- The dog-food also caught a script bug first (an invalid
  `reasoning:false` bool the OpenAI-compat endpoint 400s on) — the
  evaluator's fail-soft correctly turned that 400 into a safe
  `unmet`, which is itself evidence the robustness design works;
  fixing the script then exposed the genuine small-model
  unreliability above.
- Not a void iteration: a real functional diff (the objectives
  daemon now exists in the production server, env-gated, with a
  concrete safe evaluator/actuator) — only the LLM *decision
  quality* with qwen3:8b is unverified, and that is recorded, not
  hidden.
- `feat(api)`: real production wiring; no parent bullet flips.
