# 507 — `muse {status,doctor,trace tail} --interval` strict-parses the watch cadence (goal-414/444/463/469/470/489/502 sibling, 3 watch loops in one fix)

## Why

Three CLI `--watch --interval <n>` resolvers shared the same
lenient-parse defect class:

- `resolveStatusWatchIntervalMs` (`apps/cli/src/commands-status.ts:528`) — `muse status --watch`
- `resolveDoctorWatchIntervalMs` (`apps/cli/src/commands-doctor.ts:159`) — `muse doctor --watch`
- `resolveTraceTailIntervalMs`  (`apps/cli/src/commands-traces.ts:90`)  — `muse trace tail`

All three computed:

```ts
const parsed = Number.parseFloat(raw);
if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
```

`Number.parseFloat` reads leading numeric content and discards the
rest:

- `Number.parseFloat("10x")` → `10` — silently accepts a typo
- `Number.parseFloat("10min")` → `10` — silently accepts a unit
  slip (the user meant "10 minutes", got 10 seconds)
- `Number.parseFloat("10 seconds")` → `10` — silently strips
  whitespace and unit suffix

Same lenient-prefix defect class as goals 414 / 444 / 463 / 469 /
470 / 489 / 502, here on the three live `muse <cmd> --watch`
loops. The cross-package strict-parse convention has already
landed on env-parsers (`autoconfigure/src/env-parsers.ts`'s
`strictFloat` rejects trailing garbage via `Number`) — the CLI
watch resolvers were the remaining outliers using the lenient form.

A user typing `muse status --watch --interval 10min` got a
**10-second refresh** when they expected ten-minute updates —
the silently-wrong cadence is exactly the kind of user-surprise
the convention is meant to prevent.

## Slice

- `apps/cli/src/commands-status.ts` — `Number.parseFloat(raw)` →
  `Number(raw)`. `Number("10x")` → `NaN` → fallback (5s).
- `apps/cli/src/commands-doctor.ts` — same swap (5s default,
  [1s, 3600s] clamp).
- `apps/cli/src/commands-traces.ts` — same swap (2s default,
  [1s, 60s] clamp).
- `apps/cli/test/program.test.ts` — three existing test blocks
  (goal 076 / goal 068 / goal 046) extended with three typo /
  unit-slip / whitespace assertions each (`"10x"`, `"10min"`,
  `"10 seconds"` → fallback). Used `10` rather than `5` /
  `2` so the mutation surface is visible (a `5x`-on-doctor that
  collides with the default would silently pass under the lenient
  parse, defeating the test).

Behaviour byte-identical for every clean numeric input (`"5"`,
`"0.5"`, `"999"` — Number and parseFloat agree on plain decimals
including scientific notation). Only the lenient-prefix path is
closed.

## Verify

- `@muse/cli` suite green (843 passed, +9 typo/unit-slip
  assertions across the three resolvers, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting just
  `commands-doctor.ts`'s strict parse back to `Number.parseFloat`
  makes the doctor typo assertion fail with the precise pre-fix
  symptom (`expected 10000 to be 5000` — `"10x"` silently parsed
  to 10 seconds = 10000ms instead of falling back to the 5s
  default) while every other test stays green; fix restored,
  suite back to all green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean;
  `git status` shows only the four intended files.
- Pure parsers — no LLM request-response wire path; `smoke:live`
  does not apply (per `testing.md` / iteration-loop Step 9).

## Status

Done. A typo'd / unit-slipped `--interval 10min` on `muse status
--watch`, `muse doctor --watch`, or `muse trace tail` no longer
silently installs a wrong cadence. The goal-502 strict-parse
standard now covers all three watch loops; the cross-CLI watch-
interval contract is identical across commands — no asymmetry
left for a future regression to widen.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a lenient-parse sibling-asymmetry
`fix:` across three watch resolvers, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Step-8 redirect from test-only iteration 506 to a fix-class
  iteration on a fresh defect class (lenient-prefix vs.
  zero-coverage class). Different class on a different surface —
  not janitorial drift.
- Bundled all THREE siblings into one commit rather than three
  separate iterations: they share one defect class on one user
  surface (`muse <cmd> --watch --interval`); fixing one and
  leaving two pending would invert the iteration-loop's "right-
  sized, never excessive, never half" principle. Each function
  is byte-identical to its sibling — the convention must read
  identically.
- Chose `Number` over `Number.parseFloat` because the strict-
  parse standard uses it (autoconfigure's `strictFloat`,
  goals 502 / 503's `Number(trimmed)` pattern). A near-variant
  like `/^[+-]?\d+(\.\d+)?$/u.test(trimmed)` would be drift the
  convention exists to prevent.
- Test values switched from `"5x"` to `"10x"` (and `"5min"` →
  `"10min"`): the doctor / status defaults are 5s, so `"5x"`
  silently passes the lenient parse (5 → 5s clamp = 5000) and
  coincidentally matches the fallback (5000). The mutation
  surface is only observable with a non-default value; this is
  the same lesson the goal-503 mutation-prove caught when
  picking `Number("3030x")` → NaN as the falsifying case.
