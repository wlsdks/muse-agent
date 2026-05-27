# 747 — fix: non-finite pattern-selection knobs (NaN) silently disabled or spammed proactive notices

## Why

`selectFireablePatterns` (`@muse/memory` pattern-orchestration) — the
proactive pattern daemon's gate (`MUSE_PROACTIVE_PATTERN_*`) — read
three numeric knobs with `?? DEFAULT`:

```ts
const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
const maxPerTick = Math.max(1, options.maxPerTick ?? DEFAULT_MAX_PER_TICK);
```

`??` does NOT catch NaN, and the pattern-tick daemon parses these from
env with raw `Number(...)` (tick-daemons.ts:345-346), so a typo'd
`MUSE_PROACTIVE_PATTERN_MIN_CONFIDENCE=0.7x` / `_MAX_PER_TICK=5x` →
`NaN`. The downstream effects (all silent):

- `maxPerTick` NaN → `Math.max(1, NaN)` → `NaN` → `fireable.slice(0, NaN)`
  → `[]` → **zero notices fire every tick** (silent disable — same class
  as goal 746).
- `minConfidence` NaN → `match.confidence < NaN` is always `false` → the
  confidence floor vanishes → **every weak pattern fires** (spam).
- `cooldownMs` NaN → `nowMs - lastFired < NaN` is always `false` → a
  pattern is never on cooldown → **re-fires every tick** (spam).

Third instance of the `??-doesn't-catch-NaN` class (after 746's
followup/objective loops); the codebase already finite-guards the same
class in the context-reference store and the scheduler's clampInterval.

## Slice

Guard all three knobs for finiteness (non-finite → default), mirroring
the established pattern; finite values keep prior behavior.

## Verify

- `@muse/memory` pattern-orchestration.test.ts (new): with a
  confidence-1.0 in-slot match — `maxPerTick: NaN` still fires it
  (default cap), not zero; `cooldownMs: NaN` with a 1h-ago fire record
  keeps it on the 24h-default cooldown (fires zero), not re-firing.
  **Mutation-proven** — restoring `?? DEFAULT` makes `slice(0, NaN)`
  fire zero and the cooldown vanish, failing both assertions.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Pure selection
  logic — no model path, no `smoke:live`.

## Decisions

- **Sink-side guard** — defends the selection contract against any
  caller passing a non-finite knob (env path, programmatic), not just
  the one daemon env site. Same posture as 746 / `clampInterval` /
  the context-ref store's NaN guard.
