# 236 — `muse routine --days` strict numeric (residual silent-fallback)

## Why

Another residual instance of the silent default-fallback
anti-pattern the strict-numeric line removed everywhere else
(177 … 233) that the canonical line never reached —
`commands-routine.ts`:

```ts
const days = Math.max(1, Number.parseInt(options.days ?? "30", 10) || 30);
```

`Number.parseInt("30abc", 10) === 30`, so
`muse routine --days 30abc` **silently** analysed a 30-day
window; `--days abc` / `0` / `-5` **silently** became 30. This
is worse than a cosmetic flag: `muse routine` derives "you
usually do X around now" and `--apply` **persists that routine
as a fact into `~/.muse/user-memory.json`** — a
silently-wrong window writes a silently-wrong long-term memory
the agent then acts on. `commands-routine.ts` also had **zero
direct test coverage**.

## Scope

- `apps/cli/src/commands-routine.ts`: reuse the exported
  `parseBoundedInt` (`commands-ask.ts`, goal 178 — the same
  cross-command import precedent as goals 202 / 203 / 204 /
  230 / 232) — `parseBoundedInt(options.days, "--days", 1,
  365, 30)`: absent → 30 (the documented default,
  unchanged); `Number()` (not `parseInt`); reject non-finite
  / below-1 with `--days must be an integer in [1, 365] (got
  'x')`; truncate + clamp to 365 (a routine window beyond a
  year is meaningless). The `async` action's throw surfaces
  through the existing commander error envelope before any
  session-data analysis. Absent / valid values behave exactly
  as before.

## Verify

- `pnpm --filter @muse/cli test` — 550 pass (no regression;
  `parseBoundedInt` already has 4 direct unit tests from goal
  178 covering the delegated contract — no new untested
  logic).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-fooded the real command (the parser throws before any
  session analysis — deterministic / immediate, same stance
  as the rest of the strict line):
  - `muse routine --days 30abc` → stderr `muse: --days must
    be an integer in [1, 365] (got '30abc')`, exit **1**
    (was: silent 30-day window).
  - `muse routine --days 0` → stderr `muse: --days must be an
    integer in [1, 365] (got '0')`, exit **1** (was: silent
    30).
  - `muse routine --days 7` → no rejection — the valid value
    flows through to session analysis.

## Status

done — the last residual silent-fallback numeric flag (the
canonical strict-numeric line never reached
`commands-routine.ts`'s local `Math.max(1, parseInt() || 30)`)
now rejects a typo / unit-slip / out-of-range value with an
actionable message before it can analyse a wrong window and
`--apply` a wrong routine fact into long-term memory.
Strict-numeric is complete across every CLI numeric flag.
