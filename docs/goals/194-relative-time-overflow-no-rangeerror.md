# 194 — out-of-range relative phrase must not crash with RangeError

## Why

`resolveRelativeTimePhrase` backs every time input in the
personal layer: `parseTaskDueAt`, `parseReminderDueAt`, and the
calendar `parseIsoDate` (goals 160–166, 186, 187). Those callers
do:

```ts
const relative = resolveRelativeTimePhrase(trimmed, now);
if (!relative) return new Error(/* actionable grammar */);
return relative.toISOString();
```

The offset branches (`in N days/weeks/months`, the Korean
`N일/개월 후|뒤`) compute `new Date(reference + amount * unitMs)`
or `setMonth(+amount)`. A huge amount —
`in 9999999999 days`, `99999999999일 후`,
`in 999999999 months` — pushes the Date past the ±8.64e15 ms
range, producing an **Invalid Date** (NaN time), *not*
`undefined`. An Invalid Date object is truthy, so `!relative`
is false and the caller calls `relative.toISOString()`, which
throws `RangeError: Invalid time value`.

So a fat-fingered or LLM-generated out-of-range phrase crashes
the tool call with an unhandled exception instead of returning
the clean, actionable "not a recognized phrase" error every
other bad input gets (goal 186 grammar). Confirmed:
`new Date(Date.now() + 9999999999*86400000).toISOString()`
throws `RangeError`.

## Scope

- `packages/mcp/src/loopback-relative-time.ts`: add a
  `finiteDate(date)` gate (`Number.isFinite(date.getTime())`)
  and funnel every Date-returning path of
  `resolveRelativeTimePhrase` through it — the Korean
  early-return (covers all Korean sub-resolvers), the `in N
  months` branch, the `in N <unit>` ms-offset branch, and the
  final English day+time return. An overflow now yields
  `undefined`, so the caller takes its normal
  not-recognized → actionable-error path. No behavior change
  for any in-range phrase.
- `packages/mcp/test/mcp.test.ts`: new case asserting five
  out-of-range EN/KO phrases return `undefined` AND that
  `parseTaskDueAt` returns an `Error` (never throws) for each —
  exercising the real caller end-to-end.

## Verify

- `pnpm --filter @muse/mcp test` — 336 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Model request/response path NOT touched — this is a
  deterministic parser-output guard; the model is not involved
  in the overflow logic and no prompt / model-output handling
  changed. The new test drives the actual caller
  (`parseTaskDueAt`) directly, so a real-LLM round-trip adds no
  coverage here. (The goal-186 dueAt tool path was already
  dog-fooded on Qwen end-to-end.)

## Status

done — every relative-time surface (task/reminder dueAt,
calendar startsAt) now degrades an out-of-range phrase to the
same actionable error as any other unparseable input, instead
of throwing an unhandled RangeError from `.toISOString()`.
