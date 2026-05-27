# 489 — `readQueryInteger` strict-parses integer query params (goal-463/469/470 sibling, API surface)

## Why

`readQueryInteger` (`apps/api/src/compat-parsers.ts:126`) is the
canonical integer query-param parser used by every admin/compat
HTTP route to read `?limit=…` / `?offset=…` / `?days=…`. Real
consumers:

- `admin-observability-compat-routes.ts:124,145,146` — `days`
  and `limit` for observability windows / top-N queries.
- `admin-session-compat-routes.ts:61,62` — `offset` and `limit`
  for session pagination.
- `admin-analytics-compat-routes.ts` + `compat-routes.ts` — more
  `limit`/`offset` callers.

It used lenient `Number.parseInt(raw, 10)`. A typo'd query like
`?limit=20x` or unit-slip `?days=7d` silently became `20` / `7`
because `Number.parseInt` reads the leading digits and discards
the trailing garbage. The fallback path the function visibly
documents (`Number.isFinite ? parsed : fallback`) only catches
fully-non-numeric input (`abc` → NaN → fallback); a prefix-typo
flies past — exactly the proven 414/444/463/469/470 defect class
on a different surface (HTTP API rather than a CLI flag).

`compat-parsers.ts` had **no test file**. The contract was
implicit-only — a regression here silently mis-paginates every
admin route.

## Slice

- `apps/api/src/compat-parsers.ts` — `readQueryInteger` now
  trims the value and requires the whole token to match
  `/^[+-]?\d+$/`, then parses with `Number`. An invalid string
  reaches the fallback exactly as the function's contract
  already promises for the fully-non-numeric case. Same shape
  as goals 463 (`parseInteger` in autoconfigure) and 469 / 470
  (model / cli strict-parse). Behaviour byte-identical for
  every clean integer (`"20"` → 20, `" 12 "` → 12, `"-5"` → -5)
  and for the already-handled `"abc"` (→ fallback); only the
  silently-accepted prefix-typo path is fixed.
- `apps/api/test/compat-parsers.test.ts` — new file, first
  direct coverage of `compat-parsers`: absent param → fallback;
  clean integer (incl. trimmed and signed) → returned; a typo /
  unit-slip / decimal / scientific / underscore-grouping
  / whitespace-only / `Infinity` / `NaN` → fallback;
  non-string types → fallback.

## Verify

- New test 4/4 green; full `@muse/api` suite green (204 passed,
  +4, 0 failed); tsc strict (api) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the strict
  parse back to the lenient `Number.parseInt` makes the typo
  test fail with the precise pre-fix symptom (`"20x" must fall
  through: expected 20 to be 30` — the silently-accepted typo)
  while the clean-integer / non-string / absent tests stay
  green; fix restored, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression
  across the many admin-route consumers; `pnpm lint` 0/0;
  `pnpm guard:core` clean (no IMMUTABLE-CORE touched);
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure deterministic parsing — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. Admin / compat HTTP routes that accept integer query
params (`limit` / `offset` / `days`) no longer silently honour
a prefix-typo as its numeric prefix. Every previously-valid
input is unchanged. Distinct package + axis from the recent
apps/cli + autoconfigure runs.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a 414/444/463/469/470 sibling-
asymmetry correctness `fix:` on the API surface, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Mirrored goal 463's strict-parse semantics
  (`trim → /^[+-]?\d+$/ → Number.isInteger`) byte-for-byte
  rather than introducing a variant: the established
  cross-package convention (autoconfigure, model, cli, here)
  must read identically; a near-variant is exactly the drift
  the single-pattern rollout exists to prevent.
- Allowed signed values via `[+-]?`: existing callers like
  `offset` pass through `readQueryInteger` and bound positivity
  downstream (`Math.max(1, …)`); the parser layer must not
  pre-clamp negatives that some routes may legitimately want.
- Added a new `compat-parsers.test.ts` rather than extending
  an existing `*.test.ts`: `apps/api/test/` doesn't have a
  parsers test file; co-locating the contract test next to the
  module — same pattern the codebase uses elsewhere (`compat-
  session-tag-store.test.ts`, etc.) — leaves the spot ready
  for future per-helper additions without expanding scope now.
