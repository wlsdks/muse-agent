# 746 — fix: non-finite maxPerTick silently disabled followup/objective firing

## Why

`runDueFollowups` (followup-firing-loop) and `runDueObjectives`
(objective-evaluation-loop) capped per-tick work with:

```ts
const max = Math.max(1, options.maxPerTick ?? DEFAULT_MAX_PER_TICK);
```

`??` only catches `null`/`undefined`, NOT `NaN`. The tick-daemon
bootstrap parses the cap from env with raw `Number(...)`:

```ts
const followupMaxPerTickRaw = env.MUSE_FOLLOWUP_MAX_PER_TICK
  ? Number(env.MUSE_FOLLOWUP_MAX_PER_TICK) : undefined;
```

So a typo'd / unit-slipped knob (`MUSE_FOLLOWUP_MAX_PER_TICK=5x`,
`ten`, `10/tick`) becomes `NaN`, and `Math.max(1, NaN)` → `NaN`. Then
`due.slice(0, NaN)` → `[]` → the loop returns `{ delivered: 0, due: 0 }`
**every tick, silently, forever** — the daemon runs but never fires a
single follow-up / objective. Same `?? doesn't catch NaN` class the
scheduler's `clampInterval` / `resolveJobTimeout` already guard against;
these two firing loops (and `runDueObjectives`'s sibling `maxAttempts`)
missed it.

## Slice

Both loops now fall back to the default for a non-finite cap, matching
`clampInterval`'s `!Number.isFinite → DEFAULT` pattern:

```ts
const max = Math.max(1, Number.isFinite(options.maxPerTick)
  ? Math.trunc(options.maxPerTick!) : DEFAULT_MAX_PER_TICK);
```

Applied to `runDueFollowups.max`, `runDueObjectives.max`, and
`runDueObjectives.maxAttempts` (identical gap). Finite values keep the
prior `Math.max(1, trunc(...))` flooring; `NaN`/`Infinity`/`undefined`
→ default.

## Verify

- `@muse/mcp` mcp.test.ts (new): `runDueFollowups({ maxPerTick: NaN })`
  with 3 due followups now fires all 3 (default cap 5), not 0.
  **Mutation-proven** — restoring `?? DEFAULT_MAX_PER_TICK` makes
  `slice(0, NaN)` drop all and the test sees `delivered: 0`.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  cap logic; the test's modelProvider is a local fake (no real LLM
  call) — no `smoke:live`.

## Decisions

- **Sink-side guard, not source-side** — fixing the loops defends the
  contract against ANY caller passing a non-finite cap (env path,
  programmatic, future), not just the one tick-daemon env site. Mirrors
  the scheduler's established `clampInterval` NaN guard.
- **Also fixed `maxAttempts`** in the objective loop — same
  `Math.max(1, x ?? DEFAULT)` shape, same NaN gap; left unfixed it
  would break the retry bound the same way.
