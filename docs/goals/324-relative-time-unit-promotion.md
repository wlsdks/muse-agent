# 324 — formatRelativeTime emitted out-of-range units ("60s ago", "60m ago", "24h ago")

## Why

`formatRelativeTime` (apps/cli `human-formatters.ts`) humanises
an ISO timestamp for every relative-time surface the CLI shows —
`muse history`, next-reminder hints, run tables. Each tier
rounded independently with no promotion:

```ts
if (absSec < 60) return pick(Math.round(absSec), "s");
const absMin = absSec / 60;
if (absMin < 60) return pick(Math.round(absMin), "m");
const absHr = absMin / 60;
if (absHr < 24) return pick(Math.round(absHr), "h");
const absDay = absHr / 24;
if (absDay < 7) return pick(Math.round(absDay), "d");
```

The tier gate uses the **raw ratio** (`absSec < 60`) but the
displayed value is the **rounded** ratio. So any delta in the
top half-unit of a tier rounds *up to the tier ceiling* and is
shown verbatim:

- 59.6 s → `absSec < 60` true → `Math.round(59.6)` = **"60s
  ago"** (should be "1m ago")
- 59.7 min → **"60m ago"** (should be "1h ago")
- 23.7 h → **"24h ago"** (should be "1d ago")
- 6.7 d → **"7d ago"** — collides with the documented
  ">7 d → absolute timestamp" boundary

"60s ago" / "24h ago" looks broken to a user — a visible polish
defect on a core JARVIS surface, and entirely untested (the
existing goal-062 test only used mid-range values: 15m, 30m, 4h,
2d).

## Scope

`apps/cli/src/human-formatters.ts` — `formatRelativeTime` tier
cascade:

- Compute each tier's count with `Math.round` **first**, gate on
  the *rounded* value, and fall through to the next coarser tier
  when it hits the ceiling: `sec < 60` else minutes, `min < 60`
  else hours, `hr < 24` else days, `day < 7` else the absolute
  formatter. One short WHY comment (the promote-on-rounded-value
  rule is the non-obvious bit).

A single consistent rule across all four tiers; it eliminates
every boundary artifact at once. `~6.5–7 d` now defers to the
absolute timestamp (instead of the ambiguous "7d ago"), which is
consistent with the documented ">7 d → timestamp" intent and
with the same promotion applied to the other three tiers.
Behaviour-preserving for every mid-range value (the existing
goal-062 assertions — 15m / 30m / 4h / 2d / distant / invalid —
are unchanged).

## Verify

- `pnpm --filter @muse/cli test` — 563 pass (the goal-062
  `formatRelativeTime` test extended in place). New boundary
  assertions: 45 s → `"45s ago"` (seconds tier still works);
  59.6 s → `"1m ago"`; 59.7 min → `"1h ago"`; 23.7 h → `"1d
  ago"`; +59.6 s → `"in 1m"` (future sign preserved). The
  pre-existing same-moment / minutes / hours / days /
  past-7-days / invalid-input assertions stay green.
- `pnpm check` — every workspace green (apps/cli 563, apps/api
  161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure deterministic
  date arithmetic + Intl formatting). The deterministic
  regression is the rigorous verification — a live Qwen run
  cannot exercise sub-minute clock boundaries on demand.

## Status

done — `formatRelativeTime` now promotes on the rounded value,
so it never emits an out-of-range unit count: 59.6 s reads
"1m ago", 59.7 min "1h ago", 23.7 h "1d ago", and a delta that
rounds to ≥ 7 d defers to the absolute timestamp — one
consistent promotion rule across all tiers, with the formerly
untested boundaries now locked by regression assertions.
