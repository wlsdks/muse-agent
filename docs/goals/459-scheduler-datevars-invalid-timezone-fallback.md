# 459 — A corrupt job.timezone can't crash scheduled-job template rendering (441 sibling)

## Why

`renderTemplateVariables` (`@muse/scheduler` `scheduler-helpers.ts`)
substitutes `{{date}}` / `{{time}}` / `{{datetime}}` /
`{{day_of_week}}` into a scheduled job's agent prompt before
autonomous dispatch. It calls `dateParts(now, job.timezone)`,
which builds `new Intl.DateTimeFormat("en-US", { timeZone, … })`.

`Intl.DateTimeFormat` **throws `RangeError: Invalid time zone
specified`** for a non-IANA / corrupt timezone string. `dateParts`
did not guard this. `validateTimezone` exists but gates only the
**create** path — `normalizeScheduledJob` just `.trim()`s
`input.timezone` (line 184) and `mapScheduledJobRow` passes
`row.timezone` straight through (line 299). So a corrupt /
hand-edited / legacy persisted `scheduled_jobs.timezone` (or one
valid at create-time but dropped by an ICU/tz-db change) reaches
`dateParts` unvalidated → `renderTemplateVariables` throws → the
**autonomous scheduled job fails to dispatch** (one bad row can
break its tick).

This is the exact goal-441 pattern: there, `computeNextRunAt`
had to re-assert `validateCronExpression` at the tick chokepoint
because the load path doesn't re-validate. `dateParts` is the
**sibling render chokepoint** with the same unguarded-load-path
hole for `timezone` (the 441 / 453 / 457 "validate guards create,
not load" class). Reachable and deterministic (Intl throwing on a
bad IANA tz is JS spec behaviour; the load path demonstrably
passes the value through), high-leverage (autonomous scheduling
is a JARVIS core), fresh package (scheduler last touched goal 441,
~18 iterations ago). The existing `template variables` test
covered only a valid `"UTC"` job — the invalid-tz crash was
**genuinely uncovered**.

## Slice

- `packages/scheduler/src/scheduler-helpers.ts` — a
  `resolveTimeZone(tz)` helper: returns `tz` if
  `Intl.DateTimeFormat` accepts it, else `defaultTimezone`
  (`"UTC"`, the file's established default). `dateParts` resolves
  the timezone through it before formatting (signature/arg-order
  unchanged — the call site is untouched). Behaviour-identical
  for every valid timezone (the normal create-path-validated
  case); only a corrupt/legacy zone now degrades to a sane UTC
  render instead of throwing and breaking dispatch.
- `packages/scheduler/test/scheduler.test.ts` — a new `it` in the
  `template variables` describe: a job whose timezone
  (`"Not/AZone"`) passed `normalizeScheduledJob` unvalidated →
  `renderTemplateVariables` renders the UTC fallback
  (`"2026-05-05 10:11:12 Tuesday"`) instead of throwing; plus a
  no-regression assertion that a valid `"America/New_York"` still
  renders in that zone (`06:11:12` for 10:11 UTC).

## Verify

- New `it` green; full `@muse/scheduler` suite 64 passed (3
  files, +1); tsc strict (scheduler) EXIT=0.
- **Clean-mutation-proven** (Edit-based): bypassing
  `resolveTimeZone` (`const timeZone = rawTimeZone`) makes the
  new test fail by throwing exactly `RangeError: Invalid time
  zone specified: Not/AZone` — the precise pre-fix dispatch
  crash; fix then restored, suite back to 64 green.
- `pnpm check` EXIT=0, every workspace green (scheduler 64,
  cli 739, api …) — no regression in the api scheduler consumer;
  `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean;
  `git status` shows only the two intended files.
- Pure deterministic date/template logic — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A scheduled job carrying a corrupt or legacy timezone no
longer throws a `RangeError` out of template rendering and breaks
its autonomous dispatch — it renders in UTC (the documented
default) and runs. Every job with a valid timezone is unaffected.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a robustness `fix:` to an existing
mechanism (441 load-path-invariant sibling), recorded honestly
with this backlog row — not a false metric.

## Decisions

- Guarded at `dateParts` (the single render chokepoint both
  template substitution and any future formatter use funnels
  through), not by adding `validateTimezone` to
  `normalizeScheduledJob`: the loader fix would miss direct
  construction / other loaders, and the create gate must keep
  *rejecting* bad input — render must *degrade*, not reject (a
  job shouldn't silently never run because of one bad field).
  The 441 / 453 single-chokepoint rationale.
- Fell back to UTC (`defaultTimezone`), not throwing or skipping:
  UTC is the file's documented default and a slightly-wrong
  timezone in a rendered prompt is far better than a job that
  never dispatches; consistent with how `normalizeScheduledJob`
  already defaults a blank timezone to UTC.
