# 514 — `muse actions --limit` strict-parses the cap (goal-414/444/463/469/470/489/502/507/513 sibling on the accountability-log read)

## Why

`apps/cli/src/commands-actions.ts:48` parsed the `--limit` flag
with the lenient `Number.parseInt` family:

```ts
const limit = Number.parseInt(options.limit, 10);
if (!Number.isFinite(limit) || limit <= 0) {
  throw new Error(`--limit must be a positive integer (got '${options.limit}')`);
}
```

`Number.parseInt` accepts a leading digit prefix and silently
discards the trailing garbage:

- `parseInt("20x", 10)` → 20 (unit-slip silently accepted)
- `parseInt("5min", 10)` → 5 (silently slices 5 entries when
  the user meant "5 minutes" — wrong concept)
- `parseInt("10 entries", 10)` → 10 (silently strips suffix)
- `parseInt("1.5", 10)` → 1 (silently truncates a fractional)
- `parseInt("-3", 10)` → -3 → fails `> 0` guard (caught
  correctly)

The first three cases are exactly the typos a tired operator
types when listing accountability events at 11pm. Silently
producing a "wrong but plausible" cap is the worst error UX —
the user is shown N entries but trusts they asked for "20x"
worth.

Same lenient-prefix defect class as goals 414 / 444 / 463 /
469 / 470 / 489 / 502 / 507 / 513. The cross-CLI strict-parse
convention has landed on watch loops (507), telemetry (513),
feeds `--hours` (092 follow-up), tasks `--status`. The
`muse actions --limit` resolver on the accountability-log
read was a remaining outlier — and arguably the highest-
sensitivity one, because the user is INSPECTING what Muse did
on their behalf and silently truncating that log to a
typo'd cap is exactly the kind of bug that hides further
issues.

## Slice

- `apps/cli/src/commands-actions.ts` — swap the parse:
  ```ts
  const trimmedLimit = options.limit.trim();
  const limit = /^\d+$/u.test(trimmedLimit) ? Number(trimmedLimit) : Number.NaN;
  if (!Number.isFinite(limit) || limit <= 0) { … }
  ```
  Behaviour byte-identical for every clean positive integer
  (`"20"` → 20, `"  100  "` → 100). Only the lenient-prefix
  path is closed.
- `apps/cli/src/commands-actions.test.ts` — extended the
  existing `--limit 0` rejection test with a new `it(...)`
  block iterating over five typo / unit-slip / negative /
  fractional cases (`"20x"`, `"5min"`, `"10 entries"`,
  `"-3"`, `"1.5"`) and asserting that each:
  - exits with code 1
  - stderr contains the literal bad value (`'20x'`)
  - stderr contains the canonical message
    (`--limit must be a positive integer`)

## Verify

- New tests 5 cases × 3 assertions = 15 checks across one new
  `it(...)`, all green; full `@muse/cli` suite green (870
  passed, +1 vs baseline 869 — single new `it` block, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  parse to `Number.parseInt(options.limit, 10)` makes the
  `"20x"` assertion fail with the precise pre-fix symptom —
  `expected undefined to be 1` (the command exited cleanly
  with status 0 instead of erroring on the unit-slip). Every
  other test stays green. Fix restored, suite back to 6
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI-flag parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9).

## Status

Done. `muse actions --limit 20x` (typo) now fails fast with
`--limit must be a positive integer (got '20x')` instead of
silently slicing the accountability log to 20 entries. The
cross-CLI strict-parse convention now reads identically
across the four high-traffic CLI integer flags (`muse
{status,doctor,trace tail} --interval` (507), `muse telemetry
{summary,recent} --limit / --since-ms` (513), `muse feeds
today --hours`, `muse actions --limit`).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI-
ergonomics `fix:` on the accountability-log read, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Used the inline `/^\d+$/u.test(trimmed)` regex pattern
  rather than `Number(trimmed)` alone: `Number("3.5")` is
  `3.5` (finite, positive) and would slip past the `> 0`
  guard. Requiring a plain-decimal-integer pattern rejects
  fractional inputs, matching the goal-502/503 strict-parse
  shape for integer flags. (`--limit 1.5` is genuinely
  user-confusion and should reject, not silently truncate.)
- Did NOT change the error message: the existing
  `"--limit must be a positive integer (got '${raw}')"`
  shape is the cross-CLI convention; rewriting it would be
  drift. The strict-parse change is invisible to clean
  inputs.
- Bundled the typo case alongside the existing `--limit 0`
  rejection rather than a fresh `describe` block: same
  failure surface, same error message, same exit code —
  one logical extension.
- Step-8 redirect from the telemetry-CLI strict-parse run
  (513) to a different CLI command on a related defect
  class — productive sibling pivot (same defect class on a
  different surface), not same-area churn.
- The mutation reverts to `Number.parseInt(options.limit, 10)`
  exactly because that's the pre-fix code; the test failure
  `expected undefined to be 1` reproduces the pre-fix
  observable (no error on `"20x"`, command exits 0) byte-for-
  byte.
