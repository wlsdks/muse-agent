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

open
