# 593 — `InMemoryDebugReplayCaptureStore.listDebugReplayCaptures` returns newest-first to match the Kysely path's `ORDER BY captured_at DESC`

## Why

The runtime-state package exposes two implementations of
`DebugReplayCaptureStore`:

- **Kysely** (`KyselyDebugReplayCaptureStore.listDebugReplayCaptures`,
  line 64-71) — `select … from debug_replay_captures ORDER BY
  captured_at DESC LIMIT N`. Newest first. This is the production
  path that `/api/admin/debug/replay` queries.
- **InMemory** (`InMemoryDebugReplayCaptureStore.listDebugReplayCaptures`)
  — pre-fix:

      [...this.captures.values()].slice(0, Math.max(0, limit))

  Returns Map iteration order, which is INSERTION order. So a
  store that saved `oldest`, `middle`, `newest` in that order
  returned `[oldest, middle, newest]`. A `listDebugReplayCaptures(1)`
  returned `[oldest]` — exactly the opposite of what the Kysely
  path would return for the same data.

This is an in-memory/Kysely parity gap. Any test that drove the
in-memory store and then asserted a UI-like ordering would pass
silently against the in-memory shape and break the moment the
Kysely store was wired up against the same expectations.

Step-8 redirect: into `packages/runtime-state` (last touched in
goal 453 for a corrupt-timestamp guard). Defect class is
cross-implementation parity on list ordering — distinct from
boolean-spelling, strict-parse, finite-guards, SSRF, and the
in-memory tiebreaker sweeps that touched single-implementation
sorts.

## Slice

- `packages/runtime-state/src/debug-replay.ts`:
  - `InMemoryDebugReplayCaptureStore.listDebugReplayCaptures` now
    sorts by parsed `capturedAt` DESC before slicing — mirroring
    the SQL `ORDER BY captured_at DESC`. Ties on the same instant
    fall to `id.localeCompare` ASC, so two captures saved at the
    same `capturedAt` come out in a stable, deterministic order
    across runs.
  - New private helper `compareDebugReplayByCapturedAtDesc(a, b)`
    extracted to keep the list method body small.
  - New private helper `parseTimestampMs(value)` that accepts a
    `Date`, an ISO string, or undefined and returns a finite ms
    epoch OR `Number.NEGATIVE_INFINITY` for missing / unparseable
    timestamps. That makes captures without a `capturedAt`
    field (the existing tests at line 25-26 save records without
    one) sink to the BOTTOM of the DESC list — they're not lost,
    but they don't rank above a real-timestamped capture.
- `packages/runtime-state/test/debug-replay.test.ts` — three new
  tests:
  - **DESC ordering** — saves three captures in chronological
    order (`oldest`, `middle`, `newest`) and asserts the list
    returns `[newest, middle, oldest]`. The pre-fix Map-iteration
    bug returned the inverse. Also asserts
    `listDebugReplayCaptures(1)` returns the NEWEST, not the
    oldest — pinning the load-bearing user-facing contract (a
    `?limit=1` query gets the most recent failure, not the
    earliest).
  - **Same-instant ties** — saves two captures with identical
    `capturedAt` but reverse id order (`z-second` then `a-first`),
    asserts the list returns `[a-first, z-second]`. Proves the
    comparator is actively sorting (not just preserving
    insertion order).
  - **Missing-timestamp sink** — saves three captures, one with
    a real timestamp sandwiched between two with no `capturedAt`,
    asserts the real-timestamp one sorts first and the two
    missing-time ones fall to id ASC at the bottom. Pins the
    "missing time sinks, not crashes" semantic so a hand-edited
    or partial record can't drop out of the list.

## Verify

- `@muse/runtime-state` suite green (23 passed, +3 vs baseline
  20, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the sort
  back to bare `[...values()].slice(...)` makes all 3 new tests
  fail — the DESC test fails because the list comes back in
  insertion (= ascending) order, the same-instant test fails
  because the comparator never runs (insertion order ≠ id
  ASC), and the missing-timestamp test fails because real-time
  doesn't outrank the no-timestamp records that were saved
  first. 3-of-3 mutation-down. Fix restored.
- `pnpm check` EXIT=0 (apps/api 254 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the debug-replay store's list method —
  exercised by `/api/admin/debug/replay` reads.

## Status

Done. The in-memory and Kysely debug-replay stores now agree on
list ordering:

| Scenario                                       | Before (in-memory)            | Before (Kysely)         | After (both)                |
| ---------------------------------------------- | ----------------------------- | ----------------------- | --------------------------- |
| 3 saves: oldest → middle → newest, `list(10)`  | `[oldest, middle, newest]`    | `[newest, middle, oldest]` | `[newest, middle, oldest]` |
| `list(1)` of the same 3 captures               | `[oldest]` (wrong)            | `[newest]`              | `[newest]` (**fixed**)      |
| Same-instant tie, ids `z-second` / `a-first`   | insertion order (z first)     | DB-natural-order         | `[a-first, z-second]`       |
| Mixed real-time + no-time records              | insertion order               | DB-natural-order        | real-time first, no-time at end (id ASC) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a parity /
robustness `fix:` on an internal observability surface,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Parsed `capturedAt` ms over ISO-string compare.** ISO-8601
  timestamps with the same precision are lexicographically
  sortable, but mixed precision (e.g. `…01Z` vs `…01.500Z`)
  reverses the natural order — `"…01.500Z" < "…01Z"` because
  `.` sorts before `Z`. Parsing to ms via `Date.parse` removes
  the precision-mismatch trap. Same posture as the goal-281
  `inbox-injection-cursor` instant-compare fix.
- **`Number.NEGATIVE_INFINITY` sink for missing capturedAt.**
  Existing tests in this file save records without
  `capturedAt` (line 25-26), so the comparator must tolerate
  it. `-Infinity` makes those records rank below any real
  timestamp, but also satisfies `ta === tb` for two missing
  records so they fall to the id ASC tiebreaker stably (rather
  than NaN-comparator surprise behaviour). Alternative — throw
  on missing — was rejected because it would break the
  established "save then list" flow that the existing tests
  rely on.
- **Sort the full collection, then slice.** A k-best
  partial-sort would be faster but the in-memory store is
  capped at modest sizes for tests / dev tooling; readability
  wins. The Kysely path also fetches all rows ORDER BY then
  LIMITs — the in-memory store mirrors that posture.
- **`id ASC` tiebreaker (not DESC).** ASC matches the
  established convention from goals 555/556/574/578/579 — every
  in-memory comparator tiebreaks by `localeCompare` on the
  primary identifier. A DESC-on-id tiebreaker would be inconsistent
  with the rest of the codebase.
- **`compareDebugReplayByCapturedAtDesc` extracted as a private
  helper, not inlined.** Keeps `listDebugReplayCaptures` body
  short and pins the comparator under its own name for the goal
  doc + commit log search. A future maintainer extending the
  sort (e.g. third sort key) edits one well-named function, not
  a multi-line ternary inside an array method.

## Remaining risks

- `listDebugReplayCaptures(limit)` accepts `NaN` / `Infinity` for
  `limit` via the `Math.max(0, limit)` guard. `Math.max(0, NaN)`
  is `NaN`; `[].slice(0, NaN)` is `[]`. Defensible behaviour
  (empty result on garbage input), but a follow-up could 400
  on the route layer with a strict-parse like
  `parseOptionalIsoQueryParam` from goal 591. Deferred — the
  in-memory store's contract is "best effort, no throw."
- The Kysely path uses `.limit(limit)` directly. If the route
  layer ever passes NaN through, Kysely would issue
  `LIMIT NaN` to Postgres and the query fails. The route-level
  parser at `apps/api/src/compat-parsers.ts:readQueryInteger`
  already strict-parses the inbound query — so a NaN limit
  doesn't reach the store in practice — but a defensive guard
  in the Kysely path would tighten the contract.
- `purgeExpired` doesn't depend on list ordering; this change
  has no effect on it.
