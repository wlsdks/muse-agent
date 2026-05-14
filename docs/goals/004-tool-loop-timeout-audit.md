# 004 — Tool-loop timeout + max-iterations audit

## Why

CLAUDE.md non-negotiable: "Tool loops have explicit limits and
timeouts." Confirm the runtime enforces both. The `maxToolCalls`
option exists in `model-loop.ts` — verify there's also a wall-clock
deadline (cumulative, not per-call) so a single run can't loop
forever on a tool that returns instantly.

## Scope

- Read `packages/agent-core/src/agent-runtime.ts` + `model-loop.ts`
  + `runtime-helpers.ts`.
- If a wall-clock deadline isn't enforced, add `maxRunWallclockMs`
  option + check on every loop pass.
- Direct test: a tool that always returns `"keep going"` should
  terminate at deadline.

## Verify

- pnpm check, lint, smoke broad + live.
- agent-core test +1 for the deadline path.
- Existing maxToolCalls behaviour unchanged.

## Status

done — `maxRunWallclockMs` option added to AgentRuntimeOptions
(default 300_000 / 5 min). Wired through ModelLoopRunner →
executeModelLoop + executeStreamingModelLoop. When the deadline
passes mid-loop, tools are disabled on the next model call so the
agent gets one clean synthesis turn instead of being cut off.
agent-core +1 test (deadline 5ms, mock provider sleeps 20ms;
tool fires once on turn 1, turn 2 has no tools and returns final).
