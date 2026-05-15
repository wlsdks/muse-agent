# 210 — patterns-fired summary: a corrupt firedAtMs must not crash `muse status`

## Why

The goal-194 bug class (a *finite number* is not a *valid
Date*), found in a fresh place. `summarisePatternsFiredRows`
(`personal-status-summary.ts`) feeds the JARVIS status
snapshot — it's called by **`muse status`** (CLI,
`commands-status.ts:265`) and the **`muse.status` MCP tool**
(`loopback-status.ts:168`). It tracked the max `firedAtMs`
then did:

```ts
lastFiredAtIso: Number.isFinite(lastFiredMs)
  ? new Date(lastFiredMs).toISOString() : undefined
```

`Number.isFinite(lastFiredMs)` only proves the *number* is
finite. A finite-but-out-of-range ms — `1e30` from a corrupt
or hand-edited `patterns-fired.json` (the doc comment says
these helpers consume raw, unvalidated rows on purpose) —
makes `new Date(1e30)` an Invalid Date whose `.toISOString()`
**throws `RangeError: Invalid time value`** (confirmed:
`Number.isFinite(1e30) === true`, `new Date(1e30).getTime()
=== NaN`). So one bad row took down the **entire status
summary** — both the CLI command and the LLM-callable status
tool — instead of degrading that one field.

The sibling reducers were already safe (`Date.parse` of a bad
string yields `NaN`, not a huge finite number); only this
helper takes a raw *number* straight into `new Date(...)`.

## Scope

- `packages/mcp/src/personal-status-summary.ts`: validate the
  Date, not just the number — and do it **at the comparison
  point**, so a corrupt huge value is rejected before it can
  win the `> lastFiredMs` max and poison a valid sibling row.
  A `firedAtMs` now only updates the max when
  `Number.isFinite(new Date(row.firedAtMs).getTime())` (in
  valid Date range). The final `toISOString()` is then on a
  guaranteed-valid ms (`lastFiredMs > -Infinity` ? … :
  undefined) and can't throw. No behavior change for valid
  rows.
- `packages/mcp/test/mcp.test.ts`: a finite out-of-range
  `firedAtMs` (`1e30`) does **not** throw and yields
  `{ lastFiredAtIso: undefined, total: 1 }`; and a valid row
  alongside the corrupt one still resolves correctly (the
  corrupt value no longer suppresses it).

## Verify

- `pnpm --filter @muse/mcp test` — 337 pass (1 new; existing
  patterns-fired cases unchanged → no regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Pure deterministic aggregation helper — no model invoked;
  the test drives it directly. No smoke:live needed
  (consistent with goals 194–200).

## Status

done — a corrupt/out-of-range `firedAtMs` now degrades the
`lastFiredAtIso` field to `undefined` instead of throwing an
unhandled `RangeError` that broke the whole `muse status` /
`muse.status` surface; a valid sibling row is no longer
suppressed by the bad one.
