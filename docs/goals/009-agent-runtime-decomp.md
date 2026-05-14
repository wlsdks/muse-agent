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

deferred — the file is one giant `AgentRuntime` class (753 LOC
inside the class body). Method-cluster extraction either:
(a) inlines methods into the same file but separates declarations,
which doesn't reduce LOC much, or
(b) extracts methods into module-level helpers + threads `this`
state through explicit params — high churn, every method has
private deps on the surrounding class state.
The current 901 LOC is "tall but readable" — methods stay
grouped by lifecycle phase. Defer until a concrete pain point
(e.g., a new hook category that needs to compose with existing
ones) forces the issue. The runtime tests (512+) catch any
behavioural drift, so this isn't blocking quality.
