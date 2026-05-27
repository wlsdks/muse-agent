# 517 — `GET /api/admin/runs?limit` strict-parses + 400s on typo (goal-515 sibling on the admin run-history list)

## Why

`apps/api/src/server-routes.ts:210` parsed the `?limit` query
on `GET /api/admin/runs` with `Number.parseInt(raw, 10)`:

```ts
if (limitRaw !== undefined) {
  const parsed = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
    return reply.status(400).send({ code: "INVALID_LIMIT", … });
  }
  limit = parsed;
}
```

The 400-on-bad-input guard *looked* careful — but `Number.parseInt`
silently slices the digit prefix off any trailing garbage:

- `?limit=10x` → `parseInt("10x", 10)` → 10 → passes
  `Number.isInteger` → **200 returns 10 entries instead of 400**
- `?limit=5min` → 5 → 200 returns 5 entries (the user meant
  "5 minutes", got 5 records)
- `?limit=10 runs` → 10 → 200 (silently strips the suffix)
- `?limit=1e3` → 1 → 200 (silently ignores scientific notation)
- `?limit=1.5` → 1 → 200 (silently truncates a fractional)
- `?limit=abc` → NaN → 400 ✓
- `?limit=-3` → -3 → < 0 → 400 ✓

The first four cases are exactly the typos an operator types
when probing the admin endpoint. The 400 guard, drafted to
catch them, silently passed them through because of the lenient
`parseInt`. Same defect class as goals 414/444/463/469/470/489/
502/507/513/514/515 — and especially close to 515's
`/api/today?lookaheadHours` strict-parse fix, except on a
different admin endpoint with a 400-instead-of-fallback
contract.

## Slice

- `apps/api/src/server-routes.ts` — swap the parse:
  ```ts
  const trimmed = limitRaw.trim();
  const parsed = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) { … 400 … }
  ```
  Behaviour byte-identical for every clean positive integer; only
  the lenient-prefix paths now produce `NaN` and fall into the
  existing 400 guard (the error message + code are unchanged).
- `apps/api/test/server.admin.test.ts` — added one new `it(...)`
  block iterating over seven typo cases (`"10x"`, `"5min"`,
  `"10 runs"`, `"1.5"`, `"-3"`, `"1e3"`, `"abc"`) and asserting
  each returns 400 with `INVALID_LIMIT`. A clean baseline
  (`?limit=2` → 200 with `total: 2`) pins the happy path.

## Verify

- New test 1 `it` block × 7 cases × 2 assertions = 14 checks all
  green, plus the clean baseline (200/total=2); full `@muse/api`
  suite green (233 passed, +1 vs baseline 232, 0 failed); tsc
  strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the parse
  back to `Number.parseInt(limitRaw, 10)` makes the `"10x"`
  case fail with the precise pre-fix symptom — `10x must 400:
  expected 200 to be 400` (the route silently returned 200 with
  10 entries instead of erroring on the unit-slip). Every other
  test stays green. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the two intended files.
- Pure query-param parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-loop
  Step 9). The defended path is the admin run-history list
  endpoint, not the model loop.

## Status

Done. A typo'd `GET /api/admin/runs?limit=10x` now 400s with
`INVALID_LIMIT` instead of silently returning 10 entries. The
strict-parse convention now covers both `/api/today` (the
fallback-on-typo morning-briefing route — goal 515) and
`/api/admin/runs` (the 400-on-typo admin list — this goal),
demonstrating the convention adapts to each route's contract
without changing posture.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry server-side
robustness `fix:` on the admin runs list, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Did NOT change the 400 error message or `INVALID_LIMIT` code:
  any operator script currently grep-ing the error string would
  still see the same text. The fix is invisible to clean inputs;
  only the corrupt path now reaches the existing 400 branch.
- Used the same `/^\d+$/u`-gated `Number()` pattern as goals
  514 (`commands-actions.ts`) and 515 (`today-routes.ts`) rather
  than introducing a new variant. The cross-package strict-parse
  convention must read identically; near-variants are drift the
  convention exists to prevent.
- Posture is 400 (reject), not fallback. Both postures are
  defensible (`/api/today` falls back to default; this route
  rejects). The existing 400 was the route's pre-fix intent —
  the fix just makes that intent actually fire on typo / unit-
  slip inputs. Changing posture would be a behaviour change.
- Step-8 redirect from the surrogate-cap iteration (516) to a
  strict-parse iteration on a different server route. Different
  defect class on a different surface than the last few, and
  the strict-parse class is the most common typo-class in user
  reports; closing one more outlier keeps the convention
  consistent across `apps/api`'s six recently-touched route
  parsers (`/api/today` lookaheadHours, `/api/admin/runs`
  limit, chat rate-limit env, listen config PORT/HOST,
  proactive history limit, telemetry recent limit).
- The mutation reverts to `Number.parseInt(limitRaw, 10)`
  exactly because that's the pre-fix code; the test failure
  `expected 200 to be 400` reproduces the pre-fix observable
  (silent prefix slice instead of 400) byte-for-byte.
