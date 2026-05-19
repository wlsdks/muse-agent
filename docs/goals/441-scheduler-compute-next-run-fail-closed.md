# 441 — `computeNextRunAt` fails closed on a blank / corrupt cron instead of silently firing every minute

## Why

`computeNextRunAt` (`@muse/scheduler` `scheduler-helpers.ts`) is
the single chokepoint every scheduler tick calls to turn a job's
cron into its next fire time. A behavioral probe across 28 cron
inputs (fixed `from`) surfaced a concrete **runaway-execution
safety defect**:

```
computeNextRunAt({cronExpression: ""    }) → 2026-05-19T12:01:00Z  (fires EVERY MINUTE)
computeNextRunAt({cronExpression: "   " }) → 2026-05-19T12:01:00Z  (fires EVERY MINUTE)
computeNextRunAt({cronExpression: "0 9 * *"}) → 2026-06-09T00:00:00Z  (misread 4-field schedule)
validateCronExpression("")        → throws (correctly rejects)
```

The pinned `cron-parser` is lenient: an empty expression parses as
`* * * * *` and a 4-field expression as a misread schedule.
`validateCronExpression` is the strict gate and **correctly
rejects all of these** — but it only runs on the create/update
path. The normalize/load path (`normalizeScheduledJob`) does
**not** re-validate (`cronExpression: input.cronExpression.trim()`
only). So a blank or corrupt persisted cron (hand-edited jobs
JSON, a partial write, a migration bug) flows straight into
`computeNextRunAt`, which — because the parser doesn't throw —
schedules the job to fire **every minute, unbounded**, instead of
failing closed.

This is the exact "validate guards create, not load" hazard this
same file already fixed twice — `resolveJobTimeout` (goal 336)
and `normalizeScheduledJob.maxRetryCount` (goal 337), both with
in-file comments describing precisely this pattern. `cronExpression`
is the **most critical** field (it decides *when every job
fires*) and was the one sibling left unguarded — and its failure
mode is the worst of the three: not "job never runs" but "job runs
60×/hour forever". The `validateCronExpression` comment even
asserts "validation matches computeNextRunAt exactly"; the probe
disproves it. Probe-demonstrated, non-speculative, a `fix:` on a
fresh package (scheduler last touched goal 413, 28 goals ago — no
same-area churn).

## Slice

- `packages/scheduler/src/scheduler-helpers.ts` —
  `computeNextRunAt` now calls the existing
  `validateCronExpression(job.cronExpression)` before parsing.
  Reuses the strict validator (no new logic), so accept ⟺
  validate, exactly as the codebase already documents. Behaviour
  is byte-identical for every valid cron; the only change is that
  blank / whitespace / short-field / corrupt expressions now throw
  `SchedulerValidationError` — the same fail-closed path
  `"@reboot"` / `"invalid"` already take, which the sole
  production caller (`NodeCronScheduler.schedule`) already handles
  (`try { scheduleNext() } catch { return undefined }` → job not
  scheduled, surfaced — instead of a silent every-minute runaway).
- `packages/scheduler/src/scheduler-helpers.test.ts` — a new
  `describe`: blank / whitespace / tab / 4-field / 7-field crons
  throw `SchedulerValidationError` through BOTH
  `validateCronExpression` and `computeNextRunAt` (the documented
  symmetry now actually holds at the chokepoint); plus a
  no-regression set (`* * * * *`, 6-field seconds, `@daily`,
  `0 9 * * 1-5`) still computing the exact expected next run.

## Verify

- New `describe` green; full `@muse/scheduler` suite 61 passed
  (3 files, +2 it); tsc strict (scheduler) EXIT=0 (vitest esbuild
  masks type errors — run explicitly).
- **Fail-before is concrete, not theoretical**: the pre-fix probe
  empirically returned `2026-05-19T12:01:00.000Z` (a Date, no
  throw) for `computeNextRunAt({cronExpression:""})` and
  `2026-06-09T00:00:00.000Z` for `"0 9 * *"`; the new test asserts
  `toThrow(SchedulerValidationError)`, which those real pre-fix
  outputs definitively fail.
- `pnpm check` EXIT=0, every workspace green (scheduler 61,
  cli 737, api …) — no regression anywhere, confirming
  behaviour-identical for all valid crons; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan of both changed files clean;
  `git status` shows only the two intended files.
- Pure deterministic cron logic — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A blank or corrupt persisted `cronExpression` can no longer
slip past the load path and make the scheduler silently fire a job
every minute (or at a misread time). The compute chokepoint now
re-asserts the same strict gate as create-time, so the job
fail-closes (not scheduled, error surfaced) exactly like an
already-rejected `"@reboot"`. The validate↔compute symmetry the
file documents is now actually true.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; this is a safety `fix:` to an existing
feature on the core scheduler, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Guarded at `computeNextRunAt` (the single tick chokepoint), not
  by making `normalizeScheduledJob` throw: the 336/337 precedent
  shows the loader must stay tolerant (it sanitises numeric fields
  to safe defaults rather than throwing on load). A cron has no
  safe silent default — you cannot guess the user's intended
  schedule — so the correct fail-safe is to refuse to compute a
  next run for it, which the only caller already converts into
  "job not scheduled". This also fixes the hole regardless of how
  the bad value arrived (load, migration, direct construction),
  not just the one known path.
- Did not also validate `job.timezone` here: no timezone failure
  was probe-demonstrated, a separate `validateTimezone` exists,
  and adding it would be speculative scope the contract bans —
  explicitly out of scope, not overlooked.
- Reused `validateCronExpression` rather than re-deriving a check:
  a second cron-validity predicate would itself be the drift the
  413 fix eliminated; one source of truth is the point.
