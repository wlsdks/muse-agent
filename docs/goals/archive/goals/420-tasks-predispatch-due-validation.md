# 420 — `muse tasks add` validates `--due` before dispatch (the 419 follow-up)

## Why

Step-3 continuity: goal 419 fixed the identical class for
`muse remind` and explicitly recorded the deferred follow-up —
"Did not bundle the analogous `muse tasks --due` path: same
potential gap, a tight follow-up if judged worthwhile." It is: a
grep confirmed `muse tasks add` had the **exact** gap, and the
two are the project's two core capture commands, so the
inconsistency is user-visible.

`muse tasks add` resolved `--due` with `parseTaskDueAt` only
inside the `if (options.local)` branch; the default (remote) path
sent the raw `options.due.trim()` to `POST /api/tasks` with no
client-side check. Same bad input → great local error vs. a
degraded API error + a wasted round-trip remotely. The
`/api/tasks` route imports the **same** `parseTaskDueAt`
(`apps/api/src/tasks-routes.ts:24`), so client-side
pre-validation can never reject anything the server would accept
— a pure fail-fast/UX win. (`muse tasks edit` already validates
before its local/remote split — no gap there; scope held to
`add`.)

There was also **no `commands-tasks.test.ts`** (same as remind
had none), against `.claude/rules/cli-product.md`'s
command-parser-test requirement.

## Slice

- `apps/cli/src/commands-tasks.ts` — hoist the `parseTaskDueAt`
  validation above the `if (options.local)` split into a single
  `resolvedDueAt`. Local mode uses `resolvedDueAt`; remote mode
  still sends the **raw** `options.due.trim()` so the server
  stays the resolution authority (no semantic change for valid
  input — strictly additive fail-fast). Byte-identical approach
  to goal 419's `muse remind` fix.
- `apps/cli/src/commands-tasks.test.ts` (new) — recording fake
  `apiRequest`: remote invalid `--due` → actionable error + zero
  API calls; remote valid → API called once with the raw phrase;
  no `--due` → posts with no `dueAt`, no error; local invalid →
  same error. Fails on the pre-fix code (remote invalid reached
  `apiRequest`).

## Verify

- `@muse/cli` commands-tasks.test.ts 4/4 (new file); full
  `@muse/cli` suite green (68 files / 727, +4); tsc strict (cli)
  clean.
- `pnpm check` EXIT=0, every workspace green (api 194, cli 731,
  …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- CLI-flow + deterministic pure-parser change, fake `apiRequest`
  — not a real model request/response path; no `smoke:live`
  applies.

## Status

Done. `muse tasks add <title> --due <bad>` now fails fast with
the same example-bearing error in both modes and never makes a
doomed round-trip — `muse remind` and `muse tasks` are now
consistent, and `muse tasks` has direct command-parser coverage.
The goal-419 follow-up is discharged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; an ergonomics/consistency + test-coverage
deepening of an existing feature, recorded honestly as a
`fix(cli):` with this backlog row — not a false metric.

## Decisions

- Same additive approach as 419 (validate-then-dispatch, remote
  still sends the raw phrase): keeps client/server resolution
  semantics unchanged and the two capture commands behaviourally
  symmetric.
- Left `muse tasks edit` untouched — verified it already
  validates `--due` before its split, so there is nothing to fix
  (no speculative churn).
