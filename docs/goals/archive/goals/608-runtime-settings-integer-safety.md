# 608 — `RuntimeSettings.getInteger` rejects precision-loss values via `Number.isSafeInteger` so an admin who types a 16-digit number never gets back a silently off-by-one value

## Why

`packages/runtime-settings/src/index.ts:RuntimeSettings.getInteger`
parses a stored string setting and returns the number if it's
finite and "an integer." Pre-fix:

```ts
return parsed !== undefined && Number.isInteger(parsed) ? parsed : defaultValue;
```

`Number.isInteger(9007199254740992)` returns `true`. The value
`9007199254740992` IS an integer mathematically. But it's BEYOND
`Number.MAX_SAFE_INTEGER` (= `9007199254740991`, i.e. 2^53 − 1) —
once you cross that boundary, consecutive integers stop being
exactly representable in IEEE-754 double precision. The numeric
literal `9007199254740993` is silently parsed as `9007199254740992`
on the way in. `Number.isInteger` accepts the lossy value and
returns it.

The user-visible symptom: an admin sets a RuntimeSetting to
`"9007199254740993"` (e.g. a large budget cap, a Snowflake-style
ID, a long timestamp). `getInteger("k", 0)` returns
`9007199254740992` — silently off by one. Downstream comparisons
("is this ID the same as the one we just stored?") fail in
surprising ways with no diagnostic.

The repo already has the established `Number.isSafeInteger`
convention from goal 595 (env-derived integers) — the boundary
where "integer arithmetic stays exact" is the *safe* one, not
the broader "happens to be a whole number" one.

Step-8 redirect: not boolean-spelling, not finite-guard, not
0o600, not timeout, not regex-coverage, not Invalid-Date, not
CLI empty-id, not memory-cap, not dedup-parity, not BOM-tolerance,
not state-transition observability. Defect class is "integer
precision contract — `isInteger` accepts post-rounding values
without complaint" — fresh.

## Slice

- `packages/runtime-settings/src/index.ts:RuntimeSettings.getInteger`:
  - Swap `Number.isInteger(parsed)` for `Number.isSafeInteger(parsed)`.
    One-token change. The whole function is otherwise unchanged.
  - `Number.isSafeInteger` returns true exactly for integers in
    `[-(2^53−1), 2^53−1]` — the range where consecutive integers
    are exactly representable, so a round-trip from the source
    string never loses information.
- `packages/runtime-settings/test/runtime-settings.test.ts`:
  - Added three assertions to the existing `getInteger` block:
    - `"9007199254740993"` → defaultValue (precision-loss
      rejected). Pre-fix this returned `9007199254740992`.
    - `"9007199254740991"` (exactly `MAX_SAFE_INTEGER`) → the
      value itself (boundary still accepted).
    - `"-9007199254740993"` → defaultValue (negative beyond
      `−MAX_SAFE_INTEGER` also rejected).
  - No new `it()` block — the existing
    "returns typed values and falls back when settings are
    missing or invalid" test is the natural home for boundary
    cases of the typed getters.

## Verify

- `@muse/runtime-settings` suite green (10 passed, 0 failed,
  same count — new assertions extended the existing test block
  rather than adding a new one); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `Number.isSafeInteger` → `Number.isInteger` makes the test
  fail with the exact pre-fix symptom — `expected
  9007199254740992 to be 4` (the precision-loss value snuck
  through instead of being rejected as defaultValue).
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live`
  does not apply. RuntimeSettings is an in-process key-value
  store, not HTTP surface.

## Status

Done. `RuntimeSettings.getInteger` now has a tight precision
contract:

| Input string                | Parsed double         | Before                    | After                       |
| --------------------------- | --------------------- | ------------------------- | --------------------------- |
| `"12"`                      | 12                    | 12                        | unchanged                   |
| `"12.5"`                    | 12.5                  | defaultValue              | unchanged                   |
| `"9007199254740991"` (MAX)  | 9007199254740991      | 9007199254740991          | unchanged                   |
| **`"9007199254740993"`**    | **9007199254740992**  | **9007199254740992** (lie)| **defaultValue** (**fixed**)|
| `"-9007199254740993"`       | -9007199254740992     | -9007199254740992 (lie)   | defaultValue (**fixed**)    |
| `"NaN"` / `"1e3000"`        | NaN / Infinity        | defaultValue (via parseFiniteNumber) | unchanged          |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
precision-contract `fix:` on the runtime-settings typed getters,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **`Number.isSafeInteger`, not `Number.isInteger`.** Establishes
  the same boundary the repo already uses for env integers
  (goal 595's `parseSafeInteger` convention). Two integer
  consumers (env config / runtime settings) now share one
  precision contract.
- **Only changed `getInteger`, not `getNumber`.** `getNumber` is
  explicitly typed for arbitrary finite numbers — decimal
  fractions are first-class for that getter, so the
  precision-boundary discussion doesn't apply. `parseFiniteNumber`
  still gates both at the "finite" boundary, which is correct.
- **Test extends the existing block, doesn't add a new one.**
  The "typed values + fallback" block already has the integer
  case (`limits.maxTools` integer + `limits.decimal` fallback).
  The MAX_SAFE_INTEGER boundary is a natural extension of that
  table, not a separate concern.
- **No new exported helper.** A `parseSafeInteger` helper would
  be three lines (`parseFiniteNumber + isSafeInteger`), and
  there's only one call site here. If a third consumer wants
  the same gate, that's the moment to extract.
- **Mutation choice.** Reverted exactly the one token (`isSafeInteger`
  → `isInteger`) that gates the behavior. The mutation reproduces
  the pre-fix shape — that's the realistic regression a maintainer
  might "simplify back to `isInteger` because the precision
  distinction is subtle."
- **Boundary assertion (MAX_SAFE_INTEGER itself accepted)** is
  there so a future "make this stricter" mutation (e.g. tightening
  to `Math.abs(parsed) < 2^53 - 1` with strict `<`) would also
  fail a test — pinning both edges of the safe range.

## Remaining risks

- **`Number()` parsing semantics** still surprise: `"0x10"` →
  16, `"1e3"` → 1000, `"3.0"` → 3 (integer). These are all
  documented JavaScript behaviors, not bugs, but an admin who
  types `0x10` and gets back 16 might be surprised. Documenting
  the parser's acceptance set in the RuntimeSetting metadata
  schema is a separate iteration.
- **`getJson` precision** has the same root issue: a JSON
  number `9007199254740993` deserializes to `9007199254740992`
  silently. `JSON.parse` doesn't expose a precision flag.
  Out of scope here; would require a different parser
  (e.g. `lossless-json`) and is a much bigger lift.
- **`KyselyRuntimeSettingsStore`** stores values as strings
  in the DB. A future migration to typed integer columns
  would need to handle the precision boundary at the DB
  layer too (Postgres `bigint` survives the round-trip;
  Postgres `integer` would truncate). Out of scope.
