# 510 — `toSessionTagCompatRecord` guards against corrupt `createdAt` crashing the OpenAI-compat tag-list response (goal-440/453/459/465/508/509 sibling on the compat API layer)

## Why

`apps/api/src/compat-session-tag-store.ts:85` rendered the
OpenAI-compatible session-tag list response by calling
`new Date(tag.createdAt).toISOString()` with no finite-Date
guard:

```ts
function toSessionTagCompatRecord(tag: SessionTag): CompatRecord {
  const createdAt = new Date(tag.createdAt).toISOString();
  return { ..., createdAt, updatedAt: createdAt };
}
```

`SessionTag.createdAt` is `number` (ms). At `packages/runtime-
state/src/session-tags.ts:163` the DB store loads it via
`Number(row.created_at)` — and `Number()` produces `NaN` for
any non-numeric column value (corrupted row, schema drift,
hand-edited sidecar). A single poisoned row would crash
`toISOString` with `RangeError: Invalid time value` inside the
`tags.map(toSessionTagCompatRecord)` at line 55, **rejecting
the whole list response** and 500-ing the OpenAI-compat
`/compat/sessions/<id>/tags` endpoint.

Same defect class as goals 440 / 453 / 459 / 465 / 508 / 509 —
finite-Date guard on `new Date(loaded).toISOString()`. The
convention has landed on the messaging-ingress (508) and CLI
render (509) sides; this is the analogous defence on the
**OpenAI-compat API response** side.

## Slice

- `apps/api/src/compat-session-tag-store.ts` — promoted
  `toSessionTagCompatRecord` from internal `function` to
  `export function` (only an internal helper; safe to widen).
  Extracted the parse + render into a tiny pure helper
  `safeIsoFromMs(ms)` which:
  - returns the ISO when `ms` is a finite number that produces
    a valid Date;
  - returns the `1970-01-01T00:00:00.000Z` epoch ISO sentinel
    on `NaN` / `Infinity` / out-of-range / wrong-type input.

  The epoch sentinel was chosen because every OpenAI-compat
  consumer can parse `"1970-01-01T00:00:00.000Z"` as a Date,
  whereas a `"(invalid)"` sentinel (used in the CLI render
  helper from goal 509) would break consumers that expect ISO.
  Different surface, different fallback shape.
- `apps/api/test/compat-session-tag-record.test.ts` — new
  file, 7 focused tests:
  - 4 tests on `safeIsoFromMs` (clean ms, NaN/Infinity, out-of-
    range, wrong-type).
  - 3 tests on `toSessionTagCompatRecord` (clean tag round-trip
    with `createdAt = updatedAt`, corrupt `createdAt=NaN` tag
    renders without crashing the list, comment passthrough).

Behaviour byte-identical for every clean `tag.createdAt` ms —
only the corrupt path now falls back to the epoch ISO instead
of throwing.

## Verify

- New test 7/7 green; full `@muse/api` suite green
  (231 passed, +7 vs baseline 224, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `safeIsoFromMs` to a bare `return new Date(ms).toISOString();`
  makes 4 tests fail with the precise pre-fix symptom —
  `RangeError: Invalid time value` thrown from `toISOString()`
  on out-of-range / `NaN` / `Infinity` / wrong-type. Fix
  restored, suite back to 7 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean (no IMMUTABLE-CORE touched); byte-
  scan clean; `git status` shows only the two intended files.
- Pure record renderer — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the OpenAI-compat
  `/compat/sessions/<id>/tags` HTTP response, not the model
  loop.

## Status

Done. A single corrupted `created_at` DB row (NaN-after-
`Number()`-coercion, oversized epoch, hand-edited sidecar) no
longer 500s the whole OpenAI-compat session-tags list response.
The finite-Date guard convention now covers five sibling
sites consistently:

- `packages/messaging/src/slack-provider.ts` (goal 508,
  fallback = raw `ts` string)
- `apps/cli/src/commands-telemetry.ts` (goal 509,
  fallback = `"(invalid)"` UI sentinel)
- `apps/api/src/compat-session-tag-store.ts` (goal 510,
  fallback = epoch ISO sentinel)
- `packages/mcp/src/personal-activity-feed.ts` (pre-existing,
  fallback = skip the row)
- `packages/mcp/src/personal-status-summary.ts` (pre-existing,
  fallback = skip the row from the max)

Each fallback is tailored to its consumer's contract — there
is no one-size-fits-all sentinel because the wire contracts
differ (raw-string-passthrough vs human-UI sentinel vs ISO-
parseable sentinel vs skip-the-row).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry robustness
`fix:` on the OpenAI-compat session-tag list response,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the CLI render run (509) to the
  OpenAI-compat API response side (`apps/api`). Same defect
  class, distinct surface — productive sibling pivot, not
  same-area churn.
- Chose epoch ISO (`1970-01-01T00:00:00.000Z`) as the fallback
  rather than `"(invalid)"` (the CLI render sentinel from
  goal 509) because the OpenAI-compat contract types
  `createdAt: string` as an ISO timestamp; downstream
  consumers will parse it as a Date. Sending `"(invalid)"`
  would crash JSON consumers that immediately re-parse the
  field. Different surface, different fallback shape — both
  honour their respective contracts.
- Did NOT skip the corrupt tag entirely (the
  `personal-activity-feed` / `personal-status-summary`
  pattern): a list endpoint's count is part of its contract;
  silently dropping a tag would shift the count and surprise
  the consumer. An epoch-stamped tag is "honest" (the
  timestamp is clearly bogus) without changing the cardinality.
- Promoted `toSessionTagCompatRecord` to `export`: needed for
  the direct test, and there are no other callers in the
  package — the widening is a no-op on the module's existing
  surface.
- The wrong-type guard (`typeof ms !== "number"`) catches a
  DB layer that hands back e.g. `null` after a `LEFT JOIN`
  miss; without it, `new Date(null)` would coerce to epoch
  (silently masking the bug). Returning the epoch sentinel
  explicitly is the same observable behaviour but the bug-
  trail in the source is now clear.
