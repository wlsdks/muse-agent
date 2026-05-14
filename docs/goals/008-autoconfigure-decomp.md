# 008 — autoconfigure/index.ts sub-builder extraction (831 LOC)

## Why

Second-largest. The 333-LOC `createMuseRuntimeAssembly` is a single
mega-function orchestrating model provider, auth, MCP stack, every
registry, hooks, tool registry, and agent runtime. Risky to split,
high value if successful.

## Scope

Two-iter approach (so each step is reviewable):
1. Extract "infrastructure builders" (history stores, cache, metrics,
   SLO, drift, budget tracker, tracing pipeline, circuit breaker)
   into `assembly-infrastructure.ts`. Pure builder — returns a
   bundle the assembly destructures.
2. Extract "hook wiring" (the long `runtimeHooks = [...]` block with
   user-memory-extract + followup-capture + their gates) into
   `assembly-hooks.ts`.

This goal covers step 1 only. File step 2 as a follow-up if 1
lands cleanly.

## Verify

- pnpm check / lint / smoke broad + live.
- index.ts < 700 LOC after step 1.
- No test changes.

## Status

open
