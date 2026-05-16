# 233 — `muse search --limit` strict numeric (residual silent-fallback)

## Why

A residual instance of the silent default-fallback
anti-pattern the strict-numeric line removed everywhere else
(177 / 178 / 179 / 184 / 188 / 192 / 215 / 224 / 225 / 232) —
`commands-search.ts`'s **module-private** `parseLimit`, which
the canonical line never reached:

```ts
function parseLimit(raw, fallback, cap) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(cap, Math.trunc(parsed));
}
```

`muse search "X" --limit abc` / `1O` / `0` / `-5` **silently**
returned the default 10 with no signal — a silently-wrong
web-search result count is a silently-wrong answer for a
JARVIS web-search capability. Worse: `--limit 0.5` →
`0.5 <= 0` is false → `Math.trunc(0.5) = 0` →
`Math.min(50, 0) = 0` → it returned **0 results** (an empty
search) silently. `commands-search.ts` also had **zero direct
test coverage**.

## Scope

- `apps/cli/src/commands-search.ts`: make `parseLimit` strict
  and export it — absent/blank → fallback; `Number()` (not
  `parseInt`); reject non-finite / below-1 with
  `--limit must be an integer in [1, <cap>] (got 'x')`;
  truncate + clamp to cap. The single call site
  (`parseLimit(options.limit, 10, 50)`) is unchanged; the
  `async` action's throw surfaces through the existing
  commander error envelope before any web-search HTTP call.
  Absent / valid values behave exactly as before.
- New `apps/cli/src/commands-search.test.ts`: direct unit
  tests — absent → fallback, truncate + clamp-to-cap, and
  rejection of `5abc` / `abc` / `0` / `-5` / `0.5` / `1O`
  (closing the zero-coverage gap for this command at the same
  time).

## Verify

- `pnpm --filter @muse/cli test` — 542 pass (new test file).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-fooded the real command (the parser throws before any
  web-search HTTP call — deterministic / immediate, same
  stance as the rest of the strict line):
  - `muse search "test query" --limit 5abc` → stderr
    `muse: --limit must be an integer in [1, 50] (got
    '5abc')`, exit **1** (was: silent 10).
  - `muse search "q" --limit 0` → stderr `muse: --limit must
    be an integer in [1, 50] (got '0')`, exit **1** (was:
    silent 10).
  - `muse search "muse jarvis" --limit 5` → no rejection,
    exit 0 — the valid value flows through the strict parser
    unchanged.

## Status

done — the last residual silent-fallback numeric flag (a
module-private helper the canonical strict-numeric line never
reached) now rejects a typo / unit-slip / out-of-range value
with an actionable message; `muse search` finally has direct
unit coverage. Strict-numeric is complete across every CLI
numeric flag, including the previously-missed local parsers.
