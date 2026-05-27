# 398 — Objectives evaluator live-verified; P9-b2 [UNVERIFIED-LIVE] cleared

## Why

Goal 397 shipped the objectives daemon + concrete model
evaluator/actuator but tagged "the evaluator decides a real
objective's condition" **[UNVERIFIED-LIVE]** because the real
qwen3:8b dog-food returned empty / endpoint errors. Per the
contract, clearing an `[UNVERIFIED-LIVE]` tag is the priority
outward goal — and a tagged capability does not count toward the
metric (parent P9-b2 had to stay `[ ]`).

## What this iteration did

Root-caused the 397 failure: it was a **dog-food script
request-shape bug**, NOT an evaluator/parser gap. The 397 script
hit Ollama's OpenAI-compat `/v1/chat/completions` with an invalid
`reasoning:false` bool (Ollama 400s on it) and then `/no_think`
(returned empty) — the evaluator's fail-soft correctly turned
those malformed upstream responses into the safe `unmet` default,
which *looked like* "doesn't decide" but was actually correct
robustness handling a broken request.

Re-dog-fooded the **real production `createModelObjectiveEvaluator`**
(built `@muse/mcp`) against the loop's mandated local **qwen3:8b**
via the correct zero-think path (native `/api/chat`,
`think:false`, reasoning off):

- "tell me once the time is after 2026-05-19T15:00:00Z", now
  16:00Z → `{"outcome":"met"}` ✓
- "tell me once the time is after 2027-01-01" → `{"outcome":"unmet"}` ✓
- "notify me when 2 plus 2 equals 5" →
  `{"outcome":"unmeetable","reason":"2 plus 2 equals 4, not 5"}` ✓

The evaluator genuinely **decides** a real objective's condition
with the mandated model. No code change was needed — the evaluator
and `parseObjectiveVerdict` were always correct; the prior failure
was entirely the harness.

## Verify

- Deterministic backing checks re-confirmed green: `@muse/mcp`
  objective-evaluator.test.ts 4/4; `@muse/api`
  objectives-daemon.test.ts + objectives-tick.test.ts 8/8.
- Live: the real qwen3:8b round-trip of the production
  `createModelObjectiveEvaluator` above (met / unmet / unmeetable
  all correct).
- `pnpm check` green (apps/cli 683, all packages); `pnpm lint`
  0/0; `pnpm guard:core` clean.

## Status

`[UNVERIFIED-LIVE]` CLEARED. P9-b2's final child flipped `[x]`;
**parent P9-b2 flipped `[ ]`→`[x]`**; one CAPABILITIES line
appended. P9 (the delegated-autonomy loops actually run in
production) is now fully delivered: P9-b1 (objectives rider) +
P9-b2 (both daemons env-gated/registered with a concrete,
live-verified model evaluator + messaging actuator).

P0–P9 all delivered (P9 audit pending — next iteration, per
Step 4).

## Decisions

- No source change is the honest outcome: the 397 code was
  correct; investigating the tag (the contract's mandated
  priority) showed the failure was the dog-food request shape, and
  a correct round-trip clears it. Flipping the bullet here is
  metric-advancing, not void — the deliverable is the verified
  flip + CAPABILITIES line, backed by a real qwen3:8b round-trip
  of the actual production function.
- The 397 fail-soft "defer on a broken upstream response" behaviour
  is now doubly validated: it correctly absorbed a 400/empty
  without false-acting, and on a correct request the model decides
  cleanly. The conservative design held under both the failure and
  the success path.
- Not gold-plating the parser with `<think>`-strip etc.: on the
  mandated reasoning-off path qwen3:8b emits a clean single JSON
  object that the existing greedy extractor parses correctly — no
  observed failure on the production path, so no speculative guard.
