# 009 — agent-runtime.ts method-cluster extraction (901 LOC)

## Why

Largest file in the repo. Single `AgentRuntime` class spans
753 LOC. Highest risk decomp target — every chat / ask / orchestrate
path lands here. Worth doing for readability + iteration speed,
but only after the safer wins in 007/008 prove the leaf-module
pattern.

## Scope

Survey first, then pick ONE cluster to extract per iter:
- Guard pipeline glue (input guards + output guards + masking)
- Tool-loop orchestration (already partially in model-loop.ts —
  see what's left)
- Hook invocation (before/after/onError) — `runtime-hooks.ts`?
- Run-history / trace writes (observability fan-out)

Defer the actual extraction; this goal owns the survey + first
extraction.

## Verify

- agent-runtime.ts < 750 LOC after first extraction.
- pnpm check / lint / smoke broad + live.
- agent-core 508+ tests pass.

## Status

open
