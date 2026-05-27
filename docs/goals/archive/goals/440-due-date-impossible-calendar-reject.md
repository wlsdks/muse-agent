# 440 — `parseTaskDueAt` rejects impossible calendar dates instead of silently rolling them over

## Why

`parseTaskDueAt` (`@muse/mcp` `personal-tasks-store.ts`) is the
shared due-time keystone for **both** tasks and reminders
(`parseReminderDueAt` delegates straight to it) — the core
proactive-JARVIS surface. A behavioral probe across a 35-input
battery against a fixed `now` surfaced a concrete correctness
defect:

```
parseReminderDueAt("2026-02-30", now)  →  "2026-03-02T00:00:00.000Z"
parseReminderDueAt("2026-13-45", now)  →  Error (actionable)
```

`new Date("2026-02-30")` does **not** fail — V8 silently rolls the
impossible day over (Feb has 28 days in 2026 → Mar 2). The old ISO
branch only gated on `!Number.isNaN(date.getTime())` + a
`^\d{4}-\d{2}-\d{2}` shape check, so the rolled-over date passed
and the reminder/task was **scheduled ~2 days off** with no error.
Its sibling `"2026-13-45"` (month 13) *does* error only because
month-13 makes `new Date` return `Invalid Date` — same input
family (an impossible calendar date, e.g. a user typo or an
LLM-hallucinated date from the `muse.tasks.add` / `muse.reminders`
tool), two different behaviors: one a clean error, one a confident
wrong date.

This is exactly the "confident wrong result" class the codebase
already fights deliberately elsewhere — `math_eval` rejects
`Number("1.2.3")` rather than truncating (goal 439 region), the
CLI uses strict `Number()` not lenient `parseInt` so `600x`
rejects. Probe-demonstrated, non-speculative, on the core
accountability path; a `fix:` (diversifying from the recent
test-only run, per the Step-8 stagnation guard).

## Slice

- `packages/mcp/src/personal-tasks-store.ts` — the ISO branch now
  captures the leading `YYYY-MM-DD` and round-trips its Y/M/D
  through `Date.UTC`: a real calendar date's UTC components match
  the input; a rolled-over one (`2026-02-30` → Mar 2,
  `2026-02-29` in a non-leap year, `2026-04-31`, …) does not, so
  it falls through to the relative parser and returns the same
  actionable grammar Error as `2026-13-45`. Time-of-day and
  timezone-offset portions are untouched (only the calendar date
  is validated, tz-independently), so full ISO datetimes still
  resolve unchanged.
- `packages/mcp/test/mcp.test.ts` — a sibling `it` in the
  relative-time describe: eight impossible dates (incl. the
  non-leap `2026-02-29`, month `00`, month `13`) → `Error` via
  both `parseTaskDueAt` and `parseReminderDueAt`; and a
  no-regression set — `2026-05-20`, `2026-12-31`, the genuine
  leap day `2028-02-29`, `2026-05-20T15:30:00Z`, and a relative
  phrase — all still resolve.

## Verify

- New regression `it` green; full `@muse/mcp` suite 491 passed
  (32 files); tsc strict (mcp) EXIT=0 (vitest esbuild masks type
  errors — run explicitly).
- **Fail-before is concrete, not theoretical**: the pre-fix probe
  empirically returned `"2026-03-02T00:00:00.000Z"` (a string) for
  `parseReminderDueAt("2026-02-30", now)`; the new test asserts
  `toBeInstanceOf(Error)`, which that real pre-fix output
  definitively fails.
- `pnpm check` EXIT=0, every workspace green (mcp 491, cli 737,
  api …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan of
  both changed files clean; `git status` shows only the two
  intended files.
- Pure deterministic date logic — `parseTaskDueAt` involves no LLM
  / no model request-response wire path; `smoke:live` does not
  apply (per `testing.md` / iteration-loop Step 9).

## Status

Done. An impossible calendar date fed to a task or reminder
(`muse remind 2026-02-30 …`, or the LLM emitting a bad date through
the `muse.tasks.add` tool) is now a clean, actionable error
instead of a reminder silently scheduled on the wrong day. Tasks
and reminders share the fix through the single keystone. All
valid dates, leap days, full ISO datetimes, and relative phrases
are unaffected.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; this is a robustness `fix:` to an
existing feature on the core proactive path, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Validated the calendar date via a `Date.UTC` component
  round-trip, not a hand-rolled days-in-month table: it is the
  canonical "is this a real date" check, leap-year-correct by
  construction, and tz-independent (it reads only the regex-
  captured Y/M/D, never the time/offset), so legitimate
  timezone-offset datetimes whose UTC day differs from the local
  day are untouched — only impossible *calendar* days are
  rejected.
- Did not also "fix" `midnight` resolving to 00:00 *today* (in
  the past when invoked after noon): that is an intentional
  `startOfDay` convention, genuinely ambiguous, and changing it
  is speculative scope the contract bans — explicitly out of
  scope, not overlooked.
- Did not add compound-duration parsing (`in 2 hours 30 minutes`
  also errors): real, but that is new grammar surface, not this
  defect; logged as a possible later refinement, not scope-crept
  here.
