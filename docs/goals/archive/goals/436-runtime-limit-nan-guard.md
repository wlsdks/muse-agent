# 436 — A non-finite tool-loop limit can't silently disable the bound

## Why

Safety fix on the CLAUDE.md **non-negotiable** ("tool loops have
explicit limits AND timeouts") — `agent-core` `AgentRuntime`
constructor; a fresh axis (the core runtime's option clamp, not
touched by the recent memory/voice/api cluster).

```ts
this.maxToolCalls = Math.max(0, options.maxToolCalls ?? 10);
this.maxRunWallclockMs = Math.max(0, options.maxRunWallclockMs ?? 300_000);
```

`??` only catches `null`/`undefined`, **not `NaN`/`Infinity`**;
`Math.max(0, NaN) === NaN`. A non-finite option (corrupt config,
an upstream `Number(badEnv)`, a computed value) made
`this.maxToolCalls = NaN`. In `model-loop.ts` the gate is
`toolCallCount < runner.maxToolCalls` — and `0 < NaN` is
**always false**, so `activeTools` is permanently `[]`: the
agent **silently loses ALL tool-calling ability** (can't read
tasks / calendar / notes — JARVIS is crippled), and the
wallclock deadline (`elapsed >= NaN`) never fires either. The
CLAUDE.md-mandated bound was silently *disabled* by a single
non-finite value. Exact `??`-doesn't-catch-`NaN` class as goals
414 / 418 / 428, here on the highest-stakes safety bound, and
uncovered (every existing test passes finite limits).

## Slice

- `packages/agent-core/src/agent-runtime.ts` — add a module
  `clampRunLimit(value, fallback)`:
  `Number.isFinite(value) ? Math.max(0, Math.trunc(value)) :
  fallback`, used for both `maxToolCalls` (10) and
  `maxRunWallclockMs` (300_000). Preserves the prior semantics
  exactly (explicit `0` → 0, negative → 0, fractional truncates,
  `undefined` → default) and only changes `NaN`/`Infinity` →
  the safe default instead of a disabled bound.
- `packages/agent-core/test/agent-runtime.test.ts` — regression
  in the `AgentRuntime` describe: a provider that requests a
  distinct tool every turn (distinct args so the run-dedup cache
  isn't the gate), `maxToolCalls: NaN` → the tool fires exactly
  the default **10** times (pre-fix: `0 < NaN` ⇒ tools never
  activate ⇒ **0** executions). Self-bounds at 30 turns so a
  regressed build fails fast, never hangs.

## Verify

- `@muse/agent-core` regression 1/1 (executeTool called exactly
  10×); full `@muse/agent-core` suite green (48 files / 588, +1)
  — every existing finite-limit / wallclock test unchanged (the
  clamp is identity for finite values); tsc strict (agent-core)
  clean.
- `pnpm check` EXIT=0, every workspace green (agent-core 588,
  api 195, cli 737, …); `pnpm lint` 0/0; `pnpm guard:core`
  clean (no IMMUTABLE-CORE touched); byte-scan clean.
- Deterministic constructor-clamp change verified with a fake
  provider — NOT the model request/response wire path (the
  request shape is unchanged; only the loop bound is clamped),
  so no `smoke:live` applies. The model-loop NaN behaviour was
  confirmed by reading `model-loop.ts` (the `< maxToolCalls`
  gate) + the fake-provider test.

## Status

Done. A non-finite `maxToolCalls` / `maxRunWallclockMs` now falls
back to the safe default instead of `NaN`-disabling the
CLAUDE.md-non-negotiable tool-loop bound (which had silently
killed all tool use, not merely "unbounded it"). The agent's
tool-calling and wall-clock timeout survive a corrupt/computed
non-finite limit.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a safety fix to an existing core guard, recorded
honestly as a `fix(agent-core):` change with this backlog row —
not a false metric.

## Decisions

- Investigation honesty: the first regression draft asserted
  "NaN ⇒ unbounded (runs all 30)"; the test surfaced the run
  actually executed the tool only **once** — reading
  `model-loop.ts` revealed the real mechanism is the
  `ToolCallDeduplicator` (identical tool+args served from cache)
  AND that `0 < NaN` disables tools entirely (0 execs, not
  unbounded). The fixture (distinct args per turn) and the goal
  narrative were corrected to the true behaviour rather than
  shipped on the wrong premise.
- Reused the established `Number.isFinite ? … : fallback` shape
  (scheduler `resolveJobTimeout`, goals 414/418/428) for
  consistency and so the two limits share one drift-proof clamp.
