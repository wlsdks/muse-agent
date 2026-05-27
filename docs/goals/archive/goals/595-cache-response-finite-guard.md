# 595 — `InMemoryResponseCache` constructor finite-guards `maxSize` and `ttlMs` against `NaN` / `Infinity` so a corrupt option can't silently disable the bounded-cache contract

## Why

`packages/cache/src/index.ts:InMemoryResponseCache` is the
default in-process LRU for `/api/chat` response caching. The
pre-fix constructor:

```ts
this.maxSize = Math.max(1, options.maxSize ?? defaultMaxSize);
this.ttlMs = Math.max(0, options.ttlMs ?? defaultTtlMs);
```

has two interacting weak guards:

- `??` only catches `null` / `undefined`. `NaN` and `Infinity`
  are typeof `"number"`, so they pass through.
- `Math.max(1, NaN)` is `NaN`. `Math.max(1, Infinity)` is
  `Infinity`. Neither falls back to the default.

Downstream:

- `entries.size > this.maxSize` — the eviction loop's guard.
  `X > NaN` is `false` (any comparison with NaN), and
  `X > Infinity` is also false. So a corrupt `maxSize` **silently
  disables eviction entirely**. The cache grows unbounded until
  the process OOMs.
- `now() - cachedAt >= this.ttlMs` — the expiry check.
  `X >= NaN` is false. So a corrupt `ttlMs` **silently makes
  every entry permanent**, with no way to clear them except a
  full `invalidateAll()`.

Realistic path: a configurator computes `maxSize` from an env
var or settings field via `Number.parseInt(envVar, 10)` (a
typo'd `"100x"` yields the wrong number; a missing field yields
NaN). One bad configuration → unbounded growth. Same defect
class as the scheduler finite-guards (562/563), the token-cost
helpers (`finiteCostUsd` / `finiteTokens`), and the recent
goal-592 injection-counter guard.

Step-8 redirect: into `packages/cache` (not in any of the
last 10 iterations — fresh package). Distinct sub-defect from
the prior commits' in-memory/Kysely parity, env-flag spelling,
SSRF, and silent-fallback-on-typo iterations: this is
"`??` doesn't catch non-finite numerics on a bounded-resource
configurator."

## Slice

- `packages/cache/src/index.ts`:
  - Exported the previously-private `defaultMaxSize` /
    `defaultTtlMs` as `DEFAULT_RESPONSE_CACHE_MAX_SIZE` and
    `DEFAULT_RESPONSE_CACHE_TTL_MS` so the test can pin the
    fallback values directly (rather than testing observed
    behaviour with magic numbers).
  - Added new private helper
    `finiteOrDefault(value, fallback)` —
    `typeof value === "number" && Number.isFinite(value) ?
    value : fallback`. Routes `NaN` / `Infinity` through to
    the fallback, just like an unset `undefined`.
  - Constructor now wraps both options:
    `Math.max(1, finiteOrDefault(options.maxSize, defaultMaxSize))`
    and
    `Math.max(0, finiteOrDefault(options.ttlMs, defaultTtlMs))`.
- `packages/cache/test/cache.test.ts`:
  - Imported the two new `DEFAULT_RESPONSE_CACHE_*` constants.
  - Added one composite test block exercising all four NaN /
    Infinity combinations:
    - `maxSize: NaN` → after overflowing the default, `size()`
      stays at `DEFAULT_RESPONSE_CACHE_MAX_SIZE` (= 1000).
    - `maxSize: Infinity` → same — proves the guard isn't
      NaN-only.
    - `ttlMs: NaN` → an entry put at t=0 and read at
      t = `DEFAULT_RESPONSE_CACHE_TTL_MS + 1` returns
      `undefined` (the default cap applied; pre-fix the
      entry would have been permanent).
    - `ttlMs: Infinity` → same expiry after the default cap.

## Verify

- `@muse/cache` suite green (14 passed, +1 vs baseline 13, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  constructor back to `options.maxSize ?? defaultMaxSize`
  (without the finite-guard) makes the new test fail — the
  `maxSize: NaN` branch grows to 1005 entries instead of being
  capped at 1000, exposing the eviction-loop short-circuit on
  NaN. Fix restored.
- `pnpm check` EXIT=0 (apps/api 254 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the in-process response cache's bounded-
  resource contract; the cache is in front of `/api/chat`
  results, but this fix is a constructor-only behavior change.

## Status

Done. The in-memory response cache stays bounded under any
mis-configuration:

| Constructor option         | Before (eviction)                | After (eviction)                     |
| -------------------------- | -------------------------------- | ------------------------------------ |
| `maxSize: 100`             | bounded at 100 (works)           | unchanged                            |
| `maxSize: undefined`       | bounded at 1000 (works)          | unchanged                            |
| `maxSize: NaN`             | **unbounded** (eviction off)     | bounded at 1000 (**fixed**)          |
| `maxSize: Infinity`        | **unbounded** (eviction off)     | bounded at 1000 (**fixed**)          |
| `maxSize: -5`              | bounded at 1 (Math.max clamps)   | unchanged                            |
| `ttlMs: 60_000`            | expires after 60s                | unchanged                            |
| `ttlMs: 0`                 | never expires (explicit opt-out) | unchanged (`ttlMs > 0` guards this)  |
| `ttlMs: NaN`               | **never expires** (silently)     | expires after default 1h (**fixed**) |
| `ttlMs: Infinity`          | **never expires** (silently)     | expires after default 1h (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
resource-bound `fix:` on an internal cache, recorded honestly
with this backlog row — not a false metric.

## Decisions

- **`finiteOrDefault` over a strict-positive parser.** The
  fix could have inlined `Number.isFinite(...)` checks at the
  call sites OR introduced a strict-positive-integer parser
  similar to the scheduler / autoconfigure helpers. The simpler
  `finiteOrDefault` is the right cost here: the existing
  `Math.max(1, …)` / `Math.max(0, …)` clamps already handle
  the negative-and-zero edges, and the `defaultMaxSize` /
  `defaultTtlMs` are documented unit-bearing integers (not
  arbitrary floats), so a less strict guard fits.
- **Exported the default constants.** The test needs to pin
  the fallback values, and exported constants make that direct
  (no magic numbers, no hardcoded re-derivations of the
  constructor logic in the test). Public API surface widens by
  two well-named consts.
- **One composite test, four assertions.** Could have been four
  separate `it(...)` blocks. Chose one because the four cases
  are all "the same finite-guard, on the same defect class, on
  the same constructor" — splitting them dilutes the load-bearing
  contract pin. Same posture as the `parseBooleanTriState` test
  bundle in goal 585.
- **Did NOT change the cachedAt-NaN handling on stored entries.**
  `response.cachedAt || this.now()` (line 148) already routes
  any falsy cachedAt (including NaN) through to `this.now()`.
  So the cache always stores a finite cachedAt for fresh puts.
  If a caller round-trips a corrupt entry directly via
  `entries.set` (a private-state shortcut nothing in
  production does), the `isExpired` check returns false for
  that entry — but that path is untested-and-unused-in-production.
  Out of scope.

## Remaining risks

- `InMemoryResponseCache.put` accepts a caller-supplied
  `cachedAt` field. If a caller deliberately writes a future
  timestamp (`now + 1_000_000`), the entry will be "fresh"
  for longer than the TTL nominally allows. Acceptable —
  callers controlling cachedAt are usually replaying a fixture
  in tests.
- `evictOverflow` evicts the OLDEST entry (Map insertion
  order). That's the documented LRU posture as long as `get`
  also re-inserts on access (line 138-139 does). Verified
  intact by the existing test at line 53.
- The Anthropic prompt cache configuration (separate class)
  has its own `minCacheableTokens` field — not affected by
  this fix. Its constructor does its own clamp at use-site;
  worth a follow-up audit but distinct defect.
