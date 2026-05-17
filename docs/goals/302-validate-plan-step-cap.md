# 302 — plan-execute bounded tool calls but not plan length

## Why

`validatePlan` (`@muse/agent-core`) gates the model-generated
plan before the plan-execute loop runs it. It rejected blank /
unregistered tool names but had **no cap on the number of
steps**. The execute loop (`plan-execute-loop.ts`) bounds real
tool *calls* via `toolCallCount >= runner.maxToolCalls`, but
still **iterates every step of `plan.length`**: once the
tool-call cap is hit, each remaining step takes the `blocked`
branch — bounded work *per step*, but the loop is O(plan.length),
`executed[]` grows to `plan.length` entries, and it yields
`2 × plan.length` stream events.

A small local Qwen planner that loops / repeats itself (a known
small-model degeneracy) — or simply emits a runaway plan — would
therefore drive O(N) iterations and a flood of events/memory
even though it can do at most `maxToolCalls` real tool calls.
That is the plan-step analogue of the CLAUDE.md "tool loops have
explicit limits and timeouts" non-negotiable: the call count was
bounded, the step count wasn't.

## Scope

`packages/agent-core/src/plan-execute.ts` — `validatePlan`:

- Add `MAX_PLAN_STEPS = 64` (exported; generous — legitimate
  multi-step plans are well under 10, this is 6×+ headroom and
  comfortably above typical `maxToolCalls`). When
  `input.steps.length > MAX_PLAN_STEPS`, return invalid with one
  clear error **before** the per-step loop, so an oversized plan
  is rejected without walking it. Flows through the existing
  `PlanValidationFailedError` path (identical handling to a
  blank/unregistered-tool rejection — the whole plan is refused).
  One short WHY comment records the degenerate-planner rationale.
  Re-exported from the agent-core barrel for test access.

No signature change; no behaviour change for any plan ≤ 64 steps
(every existing plan, and every realistic one).

## Verify

- `pnpm --filter @muse/agent-core test` — 537 pass (was 536;
  +1). New `validatePlan` test: exactly `MAX_PLAN_STEPS` valid
  steps → `valid: true` (boundary allowed);
  `MAX_PLAN_STEPS + 1` → `valid: false`, one error whose reason
  contains `max is 64`. The existing
  registered / blank / unregistered / multi-error / empty-plan
  tests stay green.
- `pnpm check` — every workspace green (agent-core 537,
  apps/cli 563, apps/api 161, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched (`validatePlan` is
  pure deterministic validation that runs on the parsed plan
  before any execution / model round-trip). A live Qwen run
  can't reliably emit a 65-step plan on demand, so the
  deterministic regression is the rigorous verification — same
  stance as the limit/bound goals 263 / 284 / 295 / 296 / 297.

## Status

done — an oversized (degenerate / looping) plan is now rejected
up front instead of driving O(N) iterations and an event/memory
flood, so the plan-execute path is bounded on step count just as
the model loop is bounded on tool-call count. Plans within the
generous 64-step ceiling are unaffected.
