# 215 — `muse today --lookahead-hours` strict numeric

## Why

`parseLookaheadHours` (in `commands-today.ts`, the flagship
JARVIS daily surface) was the last live instance of the
silent default-fallback anti-pattern the strict-numeric line
removed everywhere else (177 pattern, 178 ask, 179 recall,
184 jobs, 188 notes-search, 192 notes-rag):

```ts
const parsed = Number.parseInt(raw, 10);
if (!Number.isFinite(parsed) || parsed < 1) return 24;
```

Two bugs: `Number.parseInt("48abc", 10) === 48`, so a unit
slip like `--lookahead-hours 48abc` (or `1O` — letter O)
**silently** used a wrong window with no signal; and
`--lookahead-hours abc` / `0` / `-5` **silently** became 24
instead of telling the user their flag was garbage. On a
JARVIS daily briefing, a silently-wrong look-ahead window is
a silently-wrong "what's coming up" answer. The remote path
also forwarded the raw unvalidated string into
`/api/today?lookaheadHours=<raw>`.

## Scope

- `apps/cli/src/commands-today.ts`:
  - `parseLookaheadHours` made strict, mirroring
    `commands-ask.ts`'s `parseBoundedInt` (goal 178):
    absent/blank → 24; `Number()` not `parseInt`; reject
    non-finite / below-1 with
    `--lookahead-hours must be an integer in [1, 168] (got 'x')`;
    truncate + clamp to the 168h max. Exported so it has
    direct unit coverage (it had none).
  - Validate **once up front** in the action (right after the
    existing `--speak` / `--save-to-notes` guards, throwing the
    same way) so a bad flag is rejected before any local *or*
    remote work — and the two `composeLocalBriefing(...)` call
    sites now reuse the single validated value instead of
    re-parsing. Absent/valid behavior (incl. remote sending no
    query param when the flag is absent) is unchanged.
- New `apps/cli/src/commands-today.test.ts`: direct unit
  tests — absent→24, truncate+clamp-to-168, and rejection of
  `48abc` / `abc` / `0` / `-5` / `1O` (closing the
  zero-direct-coverage gap for this command at the same time).

## Verify

- `pnpm --filter @muse/cli test` — 514 pass (new test file).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-fooded the real command (parsing runs pre-model; the
  `--brief` LLM path is unaffected — same deterministic-parser
  stance as the rest of the strict line):
  - `muse today --local` → `Today (2026-05-16, next 24h,
    local)` (default unchanged).
  - `muse today --local --lookahead-hours 48` → `… next 48h …`
    (valid value flows).
  - `muse today --local --lookahead-hours 48abc` → stderr
    `muse: --lookahead-hours must be an integer in [1, 168]
    (got '48abc')`, exit **1** (previously: silent 48h).

## Status

done — every numeric CLI flag on the strict-numeric line now
rejects a typo / unit-slip / out-of-range value with an
actionable message instead of silently substituting a
default. `muse today`'s look-ahead window can no longer be
silently wrong, and the command finally has direct unit
coverage.
