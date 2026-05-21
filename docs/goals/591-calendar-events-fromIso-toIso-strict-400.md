# 591 — `GET /api/calendar/events` returns 400 on a present-but-unparseable `fromIso` / `toIso` instead of silently falling back to "now" / "now + 30d"

## Why

The calendar-events route reads two ISO query params:
`?fromIso=…` (default: now) and `?toIso=…` (default: from + 30d).
The pre-fix parser:

```ts
function parseIsoOrDefault(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}
```

collapsed both "absent" and "present-but-unparseable" into the same
fallback branch. A caller typing `?fromIso=tomorrow` got the same
result as `?fromIso=` (omitted) — `from = new Date()` (= now).
Silently. No 400, no warning. The events query then ran with a
wrong start time and the caller never knew their input was garbage.

The sibling routes already 400 on the same defect class:

- `GET /api/history?sinceIso=tomorrow` → 400
  `sinceIso must be a parseable ISO timestamp (got 'tomorrow')`
  (`history-routes.ts:62-68`).
- `GET /api/today?lookaheadHours=…` strict-parses and falls back
  ONLY on absent / unrecognised (`today-routes.ts:parseLookaheadHours`).

The calendar route was the asymmetric outlier — pre-existing
silent fallback masking a class of typos that other API surfaces
catch loudly.

Step-8 redirect: the prior commits sat in `packages/mcp` (590,
SSRF), `packages/agent-core` (589, checkpoint), `packages/calendar`
(588, create/update symmetry), `packages/model` (587, boolean
spelling). This iteration moves to `apps/api` (last touched in
goal 571) and a distinct defect class: silent error-suppression
on user-supplied input on an HTTP surface, aligned with the
established `?sinceIso` 400-on-typo precedent.

## Slice

- `apps/api/src/calendar-routes.ts`:
  - Replaced the silent-fallback `parseIsoOrDefault` with an
    exported `parseOptionalIsoQueryParam(raw)` that returns a
    discriminated `OptionalIsoQueryResult`:
    - `{ kind: "absent" }` — raw is undefined / whitespace-only.
    - `{ kind: "explicit", date }` — raw parsed successfully.
    - `{ kind: "invalid", raw }` — raw is present but `Date(raw)`
      yielded NaN. The original (un-normalised) string is
      preserved so the route can echo it in the 400 response.
  - The handler dispatches: invalid → `400 INVALID_FROM_ISO` /
    `INVALID_TO_ISO`; absent → use default; explicit → use the
    parsed Date.
  - Exported the helper so a unit test can drive it directly
    without a Fastify lift.
- `apps/api/test/calendar-routes-parsers.test.ts` — new direct
  test file. 5 tests:
  - `undefined` → absent;
  - empty / whitespace → absent (caller didn't really supply);
  - `"2026-05-21T09:00:00.000Z"` and `"2026-05-21"` → explicit
    with the right Date;
  - 5 unparseable spellings (`tomorrow / not-a-date / 2026-13-99 /
    next monday / now+1h`) all classify as invalid AND preserve
    the original raw string verbatim for the 400 echo;
  - regression guard: a present-but-typo value never silently
    classifies as absent (pins the load-bearing contract this
    iteration adds).

## Verify

- `@muse/api` suite green (254 passed, +5 vs baseline 249, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `parseOptionalIsoQueryParam` to the pre-fix shape (NaN → return
  absent) makes 2 of the 5 new tests fail — the "invalid"
  classification test and the "never silently falls back when
  present" regression guard — with `expected 'absent' to be
  'invalid'`. The explicit / absent / round-trip tests stay green
  because those code paths didn't change. Fix restored.
- `pnpm check` EXIT=0 (apps/api 254 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- `pnpm smoke:broad` — 51 passed, 0 failed. The HTTP surface is
  unchanged for the happy path (the route still accepts a valid
  ISO and an omitted param). The only behaviour change is that
  a typo'd value now 400s instead of silently using `new Date()`,
  which the broad smoke does not exercise (its calendar coverage
  uses valid inputs only).
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended surface is the calendar HTTP query, not the model
  loop.

## Status

Done. The calendar-events HTTP route now matches the established
`?sinceIso` 400-on-typo convention:

| Input shape                              | Before                          | After                                  |
| ---------------------------------------- | ------------------------------- | -------------------------------------- |
| `?fromIso=` omitted                      | uses now                        | uses now (unchanged)                   |
| `?fromIso=` (empty)                      | uses now                        | uses now (unchanged)                   |
| `?fromIso=2026-05-21T09:00:00.000Z`      | uses the parsed Date            | unchanged                              |
| `?fromIso=tomorrow` (typo)               | **silently falls back to now**  | **`400 INVALID_FROM_ISO`** (**fixed**) |
| `?toIso=next monday` (typo)              | silently falls back to from+30d | **`400 INVALID_TO_ISO`** (**fixed**)   |
| `?providerId=…` (unchanged)              | passed to registry              | unchanged                              |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
error-UX `fix:` on an existing HTTP surface, recorded honestly
with this backlog row — not a false metric.

## Decisions

- **Discriminated union over magic-sentinel return.** Could
  have used a `null | Date` shape with an extra `raw` capture,
  but the three-way distinction (`absent / explicit / invalid`)
  is precisely what the route needs to dispatch into three
  branches. A discriminated union makes the contract self-
  documenting and prevents a future refactor from collapsing
  the two non-fallback states. Same shape as
  `OptionalDate` in `packages/tools/src/muse-tools-helpers.ts`
  (`absent / invalid / date`).
- **Preserve `raw` on invalid.** The 400 message echoes the
  caller's exact input (e.g. `got 'tomorrow'`). This matches
  the `/api/history?sinceIso` message and helps the caller
  diagnose quickly. Without the raw capture the route would
  have to re-thread the input through closures or repeat the
  trim — the helper carrying its own raw is simpler.
- **Whitespace-only treated as absent.** `?fromIso=` and
  `?fromIso=   ` both classify as absent — the caller did
  not really supply a value. This matches what most HTTP
  clients produce for an unset field. Only a NON-blank typo
  gets the 400 treatment.
- **`raw === undefined || raw.trim().length === 0`** for the
  absent guard. The old check was just `!value`, which would
  treat `"0"` and `"false"` as absent (both falsy strings).
  ISO date strings are never `"0"`/`"false"`/etc. so the
  difference is theoretical, but `raw.trim().length === 0`
  is the more honest contract.
- **Export the helper for direct testing.** The pre-fix
  `parseIsoOrDefault` was private, which is why it had no
  direct test. The exported `parseOptionalIsoQueryParam`
  lets a `vitest` file drive every branch without lifting a
  Fastify server — same shape `compat-parsers.test.ts` uses
  for `readQueryInteger`.

## Remaining risks

- **`?providerId=…` is not validated/trimmed.** A typo like
  `?providerId=goog` (instead of `google`) reaches
  `registry.require(providerId)`, which throws and the route
  returns a 502 `CALENDAR_LIST_FAILED`. A future iteration
  could 400 on unknown providerId (with a did-you-mean hint
  via the established `closestCommandName` pattern). Deferred
  to keep this iteration tight on the ISO defect.
- **`from > to` is not validated.** A swapped range silently
  filters every event out (the underlying provider returns
  `[]`). Could return 400, but the empty-result behavior is
  technically correct and matches what a SQL `WHERE … AND` of
  an impossible range would do. Out of scope.
- **`new Date(raw)` is lenient by spec.** `"2026"` parses to
  `2026-01-01T00:00:00Z`, `"2026-05"` to `2026-05-01`. These
  partial forms now classify as `explicit` (not `invalid`).
  The route still receives a valid Date in those cases — the
  caller's "expected" range is just less precise. Acceptable
  per the broader `Date` constructor contract.
