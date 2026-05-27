# 570 — `GET /api/history?limit=…` routes through the strict `readQueryInteger` helper (server-side sibling of goal-554)

## Why

Step-8 redirect onto a fresh surface — `apps/api/src/`
HTTP query-parameter parsing — same strict-parse defect
class as goal 554's CLI sweep, different surface.

Pre-fix `history-routes.ts:72`:

```ts
let limit = DEFAULT_LIMIT;
if (typeof query.limit === "string" && query.limit.length > 0) {
  const parsed = Number.parseInt(query.limit, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    limit = Math.min(MAX_LIMIT, parsed);
  }
}
```

`Number.parseInt("10min", 10)` returns `10`. `Number.parseInt
("20x", 10)` returns `20`. The lenient prefix-parse silently
truncates trailing garbage — a client that types
`/api/history?limit=20x` thinks the limit was applied; the
server silently degrades to 20.

The codebase already has a strict-parse helper for HTTP
query integers:

```ts
// apps/api/src/compat-parsers.ts:131
export function readQueryInteger(request, key, fallback) {
  ...
  if (!/^[+-]?\d+$/u.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : fallback;
}
```

Every other compat route uses it. `history-routes.ts` was the
outlier — hand-rolled lenient `parseInt` block when the
established strict-parse helper sits one import away. Same
sibling-asymmetry defect class as goal 554 (CLI parseLimit
strict-parse) but on the server side.

## Slice

- `apps/api/src/history-routes.ts` — replaced the hand-rolled
  `Number.parseInt` block with `readQueryInteger(request,
  "limit", DEFAULT_LIMIT)` from `compat-parsers.js`. The
  positivity check + MAX_LIMIT cap is preserved as a
  one-line wrap (the shared helper only handles the
  parse, not the domain-specific bounds). Dropped
  `limit?: string` from the local `request.query` cast
  since the helper handles the raw read.
- `apps/api/test/server.history.test.ts` — added one
  `it(...)` covering: `?limit=20x` happens to equal the
  default 20 (the typo-prone case the pre-fix code masked);
  `?limit=10min` unit-slip falls back to 20 (pre-fix
  silently became 10); `?limit=5` accepted; `?limit=9999`
  clamped to MAX_LIMIT (200). A 30-entry reminder-history
  fixture exercises the actual filtering path so the test
  measures the body shape, not just status codes.

## Verify

- New `it(...)` green; full `@muse/api` suite green (245
  passed, +1 vs baseline 244, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  pre-fix lenient `Number.parseInt(query.limit, 10)`
  makes `?limit=10min` produce `total: 10` (the silent
  prefix-parse) instead of falling back to the default
  20; the assertion `expected total to be 20: lenient
  parseInt would silently truncate "10min" to 10 — the
  strict-parse helper falls back to the default 20`
  catches it. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 245
  passed, apps/cli 1027 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- HTTP query parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is
  `GET /api/history?limit=…` as consumed by the web UI +
  external clients, not the model loop.

## Status

Done. A fresh grep for `Number.parseInt(query.` in
`apps/api/src/` returns rows that legitimately need
lenient prefix-parse (e.g. parsing Slack `ts` strings,
admin-routes' weather-of-the-day knob) — the
`history-routes.ts` outlier is closed.

A natural follow-up: other routes that hand-roll lenient
parse (e.g. `apps/api/src/admin-routes.ts:104` has
similar `Number.parseInt(query.limit, 10)` shape) are
fresh iteration targets. Deferred to keep this iteration's
scope tight.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
strict-parse hardening on the `/api/history` HTTP query
parser, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Used the existing `readQueryInteger` helper rather than
  inlining the strict-parse regex. Reason: shared
  conventions are the codebase standard; if the helper's
  contract ever changes (e.g. `Number.isSafeInteger`
  upgrade — sibling to goal 561), every caller picks it
  up at once. Single source of truth.
- Did NOT change the helper itself (it uses `Number
  .isInteger`, not `Number.isSafeInteger`). Reason: that's
  a wider change — every helper-caller's contract shifts
  on a `?limit=9007199254740993` precision-loss input.
  Fresh iteration target sibling to goal 561 if the
  defect class recurs.
- Did NOT touch the kind / sinceIso branches. Those
  already use the right parsers (the enum normalises via
  `.trim().toLowerCase()`; the ISO timestamp uses
  `Date.parse` + `Number.isFinite`). One asymmetry per
  iteration.
- The added test sets up a 30-entry reminder-history
  fixture and asserts the actual `total` in the body so
  the test measures end-to-end behaviour (parse → filter
  → response), not just the parser. The `?limit=20x`
  case happens to land on `20` (the default) — the
  assertion's value matches both pre-fix and post-fix
  behaviour BUT the sibling `?limit=10min` case clearly
  differentiates them (pre-fix: 10, post-fix: 20). Two
  test cases together pin the asymmetry.
- Mutation reverts only the single semantic change (the
  parser block). Smallest delta; surgical proof.
- Step-8 sub-defect-class check: strict-parse on HTTP
  query parameters is distinct from the recent
  comparator-determinism (551/555/556), persona CLI
  (557/558), validate-NaN (562/563), envelope-parity
  (565/566), error-UX (564), did-you-mean (567), and
  case-insensitivity (568/569). Fresh defect-class slot
  on a fresh surface (server, not CLI).
