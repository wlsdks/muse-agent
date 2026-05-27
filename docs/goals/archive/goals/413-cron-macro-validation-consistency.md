# 413 — `validateCronExpression` accepts the cron macros the runtime accepts

## Why

Consistency fix on a fresh axis (`@muse/scheduler`, never touched
by the recent calendar/mcp/policy/cli cluster), high downstream
leverage: the scheduler drives the reminders / proactive /
objectives daemons, and cron validation is the gate every
user-scheduled job passes through.

`validateCronExpression` ran a manual field-count gate
(`fields.length !== 5 && !== 6`) **before** the parser. Cron
"nickname" macros (`@daily`, `@hourly`, `@weekly`, `@monthly`,
`@yearly`, `@annually`) are a single token, so the gate rejected
them as "Invalid cron expression" — even though `computeNextRunAt`
(the actual runtime, same `CronExpressionParser`) computes a
correct next-run for every one of them:

```
@daily   validateCronExpression → REJECTED   computeNextRunAt → 2026-05-20T00:00:00Z
@hourly  validateCronExpression → REJECTED   computeNextRunAt → 2026-05-19T09:00:00Z
…
```

So validation was strictly more conservative than execution: a
user scheduling `@daily` (idiomatic, extremely common) got a hard
"Invalid cron expression" for a schedule the engine fully
supports. The two views of "is this cron valid?" disagreed.

## Slice

- `packages/scheduler/src/scheduler-helpers.ts` — in
  `validateCronExpression`, skip the numeric field-count gate when
  the trimmed expression starts with `@` and defer entirely to
  `CronExpressionParser.parse`. The parser is now the single
  arbiter for macros, so validation == `computeNextRunAt` by
  construction. The 5/6-field gate is unchanged for standard
  numeric expressions (still rejects 4-/7-field and garbage —
  its original intent: catch malformed numeric crons the parser
  is lenient about).
- `packages/scheduler/src/scheduler-helpers.test.ts` — extend the
  `validateCronExpression` describe: the supported macros are
  accepted AND `computeNextRunAt` resolves them (consistency
  assertion, incl. `@daily` → `2026-05-20T00:00:00Z`); and a
  no-false-accept guard — `@every 5m` / `@midnight` are NOT
  supported by the pinned cron-parser, so validation must keep
  rejecting them *and* `computeNextRunAt` throws on them too
  (validation never green-lights a cron the scheduler can't run).

## Verify

- `@muse/scheduler` full suite 57/57 (3 files); the new macro
  case fails on the pre-fix code (`@daily` was rejected).
- `pnpm check` EXIT=0, every workspace green (apps/cli 717, …);
  tsc strict (scheduler) clean; `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean.
- Pure cron validation, no request/response (LLM) path — no
  `smoke:live` applies. Scheduler is consumed cross-package so
  the full `pnpm check` was the gate.

## Status

Done. A user can now schedule a job with `@daily` / `@hourly` /
`@weekly` / `@monthly` / `@yearly` / `@annually` — the validator
accepts exactly the set the scheduler can actually run, and still
rejects the macros the pinned parser can't resolve. Validation and
`computeNextRunAt` no longer disagree.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a consistency fix to an existing feature,
recorded honestly as a `fix(scheduler):` change with this backlog
row — not a false metric.

## Decisions

- Defer macros to the parser rather than hardcode an allow-list
  of nicknames: hardcoding would re-introduce the same
  validation-vs-runtime drift the moment cron-parser's supported
  set changes on a version bump. "Whatever `computeNextRunAt` can
  run is valid" is the correct, drift-proof invariant — and is
  exactly what the test pins (accept set ∧ reject set both
  cross-checked against `computeNextRunAt`).
- Kept the numeric field-count gate: cron-parser historically
  accepts some malformed numeric inputs; the gate's stricter
  4-/7-field rejection is intentional and unrelated to the macro
  bug, so it stays.
