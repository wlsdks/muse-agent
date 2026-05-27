# 515 — `/api/today` strict-parses `lookaheadHours` (goal-502/507/513/514 sibling on the morning-briefing server route)

## Why

`apps/api/src/today-routes.ts:75` parsed the `lookaheadHours`
query param with `Number.parseInt(raw, 10)`:

```ts
const hoursParsed = lookaheadHours ? Number.parseInt(lookaheadHours, 10) : DEFAULT_LOOKAHEAD_HOURS;
```

`Number.parseInt` accepts a digit prefix and silently discards
the trailing garbage. A client calling
`GET /api/today?lookaheadHours=12hrs` got a **12-hour
briefing** instead of the documented 24-hour default — the
"hrs" was silently stripped, the digit prefix passed the
`>= 1` guard, and the server returned a confidently wrong
window. Same defect for `?lookaheadHours=5 hours` → 5,
`?lookaheadHours=24x` → 24 (silently matches default,
masking the bug entirely), `?lookaheadHours=1e3` → 1 (silently
ignores scientific notation).

Same lenient-prefix defect class as goals 414 / 444 / 463 /
469 / 470 / 489 / 502 / 507 / 513 / 514. The cross-CLI strict-
parse convention has landed on watch loops (507), telemetry
(513), accountability log (514) — `/api/today` was the
remaining outlier on the API server side, and arguably the
most user-facing because `/api/today` is the morning-briefing
endpoint every `muse today` invocation hits.

## Slice

- `apps/api/src/today-routes.ts` — extracted a pure exported
  helper `parseLookaheadHours(raw)`:
  ```ts
  export function parseLookaheadHours(raw: string | undefined): number {
    if (raw === undefined) return DEFAULT_LOOKAHEAD_HOURS;
    const trimmed = raw.trim();
    if (!/^\d+$/u.test(trimmed)) return DEFAULT_LOOKAHEAD_HOURS;
    return Number(trimmed);
  }
  ```
  Wired into the route handler. Behaviour byte-identical for
  every clean integer; only the typo / unit-slip / scientific
  / negative / decimal paths now fall back to the documented
  24h default.
- `apps/api/test/server.today.test.ts` — added one `it(...)`
  block iterating over seven typo cases (`"24x"`, `"12hrs"`,
  `"5 hours"`, `"abc"`, `"-3"`, `"1.5"`, `"1e3"`) and
  asserting each:
  - returns 200 (no crash)
  - body `lookaheadHours: 24` (the documented default, not
    the silent-prefix value)

The existing clamp test (`?lookaheadHours=0` → 24,
`?lookaheadHours=99999` → 168) still passes — clean integers
were never touched.

## Verify

- New tests 1 `it` block × 7 cases × 2 assertions = 14 checks
  all green; full `@muse/api` suite green (232 passed, +1
  vs baseline 231, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  helper to a lenient
  `return raw ? Number.parseInt(raw, 10) : DEFAULT_LOOKAHEAD_HOURS;`
  makes the typo assertion fail with the precise pre-fix
  symptom — `"12hrs" should fall back to 24h default:
  expected { …(2) } to match object { lookaheadHours: 24 }`
  (the response body reports `lookaheadHours: 12`, confirming
  `parseInt` silently sliced "12" out of "12hrs"). Every
  other test stays green. Fix restored, suite back to all
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure query-param parser — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the
  `/api/today` server route, not the model loop.

## Status

Done. A typo'd `GET /api/today?lookaheadHours=12hrs` no
longer silently returns a 12-hour briefing — it falls back
to the documented 24-hour default. The strict-parse
convention now covers both the CLI input boundary
(`muse {status,doctor,trace tail,telemetry,actions}` —
goals 507 / 513 / 514) and the API server route
boundary (`/api/today` — this goal). A client / scripted
caller / future surface hitting the morning-briefing
endpoint with a typo'd query gets a documented response,
not a confidently-wrong one.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry server-
side robustness `fix:` on the morning-briefing API,
recorded honestly with this backlog row — not a false
metric.

## Decisions

- Fell back to the default rather than throwing 400 on
  malformed input: the existing convention (lines 76-78)
  also falls back on out-of-range values (`0`, `99999`).
  A 400-response would be a behaviour change for any client
  currently relying on the lenient fallback — including
  legitimate user-confusion typos that we want to silently
  treat as default. Same posture as the CLI strict-parse
  decisions: typo → documented default, not a hard error.
- Exported `parseLookaheadHours` for direct test coverage,
  even though the test exercises it through the full
  `server.inject({ ... })` path. The export enables a future
  unit-test layer without re-plumbing the test fixture, and
  it widens nothing dangerous (pure function on a string).
- Used the inline `/^\d+$/u` pattern (same as goal 514's
  `commands-actions.ts` swap) rather than reusing a
  cross-package helper — the regex is one line, the local
  branch is the clear default-fallback, and crossing the
  `@muse/cli` → `@muse/api` boundary for a 4-line helper
  would invite drift.
- Step-8 redirect from the CLI-side strict-parse run (513 /
  514) to the API server side — same defect class, distinct
  surface. Productive sibling pivot.
- The mutation reverts to `Number.parseInt(raw, 10)` exactly
  because that's the pre-fix code; the test failure
  (`expected … lookaheadHours: 24` getting `12`) reproduces
  the pre-fix observable byte-for-byte.
