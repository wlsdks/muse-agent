# 513 — `muse telemetry` CLI strict-parses `--limit` and `--since-ms` (goal-502/507 sibling on the telemetry CLI input boundary)

## Why

`apps/cli/src/commands-telemetry.ts` forwarded the
`--limit` and `--since-ms` flag values **directly as strings**
to the `/admin/telemetry/{summary,recent}` API:

```ts
const query = options.sinceMs
  ? `?sinceMs=${encodeURIComponent(options.sinceMs)}` : "";
…
if (options.limit) { params.set("limit", options.limit); }
if (options.sinceMs) { params.set("sinceMs", options.sinceMs); }
```

A user typing `muse telemetry recent --limit 10x` (typo) or
`muse telemetry summary --since-ms yesterday` would silently
forward the corrupt value to the API, which then either 400s
with an opaque parsing error or silently falls back to its own
default. The CLI gave **no useful error** at the layer where
the user actually typed the bad flag.

Same defect class as goals 502 / 507 — lenient CLI-input
passthrough where strict-parse at the CLI boundary would catch
the typo immediately with an actionable error. The strict-parse
convention has landed across the API server-side (502 chat
rate-limit, 503 listen config), the CLI watch loops (507
`--interval`); telemetry's two integer flags were the
remaining outliers on the CLI layer.

## Slice

- `apps/cli/src/commands-telemetry.ts` — two new pure exported
  helpers wired into the two action handlers:
  - `parseTelemetryLimit(raw, fallback=10)`: trim → `Number()`
    → finite-positive guard → clamp at 500 (matches the
    convention used by `parseBoundedInt` in
    `commands-ask.ts`). Throws an actionable error on
    `--limit 10x`, `--limit -3`, `--limit 0`, `--limit nope`.
  - `parseTelemetrySinceMs(raw)`: trim → `Number()` → finite-
    non-negative guard. Returns `undefined` when the flag is
    absent (preserving the optional contract). Throws on
    `--since-ms -1`, `--since-ms 1700000000000x`,
    `--since-ms yesterday`.
- `apps/cli/src/commands-telemetry.test.ts` — extended with 9
  new tests (4 on `parseTelemetryLimit`, 5 on
  `parseTelemetrySinceMs`) covering the fallback, clean,
  clamp, truncate, and typo/unit-slip paths. Behaviour byte-
  identical for every clean integer; only the typo /
  unit-slip / negative paths now throw instead of silently
  forwarding.

## Verify

- New tests 9/9 green; full `@muse/cli` suite green
  (860 passed, +9 vs baseline 851, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `parseTelemetryLimit` to a lenient `Number.parseFloat` +
  no-error variant makes the typo-rejection assertion fail
  with the precise pre-fix symptom — `expected [Function] to
  throw an error`. Other tests stay green. Fix restored,
  suite back to 13 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure CLI-flag parsers — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9).

## Status

Done. A typo'd `muse telemetry recent --limit 10x` or
`muse telemetry summary --since-ms yesterday` now fails fast
with an actionable error at the CLI layer:

```
--limit must be an integer >= 1 (got '10x')
--since-ms must be a non-negative integer (got 'yesterday')
```

instead of silently forwarding the corrupt value to the API.
The cross-CLI strict-parse convention now reads identically
across `muse {status,doctor,trace tail} --interval` (goal
507), `muse ask` family `parseBoundedInt` (goal 143/177), and
`muse telemetry` flags (this goal).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry CLI-
ergonomics `fix:` on the telemetry input boundary, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the `??`-doesn't-catch-NaN run
  (511 / 512) on the persistence boundary to a different
  defect class (lenient-CLI-passthrough) on the input
  boundary. Productive variation, not same-area churn.
- Did NOT reuse the existing `parseBoundedInt` helper from
  `commands-ask.ts` for both flags: `--limit` has a different
  upper bound (500 vs `parseBoundedInt`'s caller-supplied
  max), `--since-ms` is unbounded above (epoch ms can grow
  for decades). Two focused helpers express each contract
  more clearly than threading a generic call. Either approach
  is defensible; the two-helper shape mirrors goal 503's two
  resolvers in one module (`resolveListenPort` +
  `resolveListenHost`).
- The error messages echo the bad value (`(got '10x')`) so a
  scripted invocation can grep for what it sent. Same
  convention as `parseBoundedInt`.
- Did NOT change the API server-side handler: the existing
  endpoints validate their own params (they're the source of
  truth). The CLI layer's parse is defence in depth —
  earlier, more actionable error than a generic 400.
- `Math.min(500, …)` silently clamps `--limit 9999` to 500
  rather than throwing. Matches the convention from
  `commands-ask.ts:148`: clamp above max, throw only on
  below-min. Operators occasionally pass exploratory huge
  numbers and the clamp-not-throw posture lets them iterate
  rather than re-type.
