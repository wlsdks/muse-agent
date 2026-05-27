# 641 — `RuntimeSettings` constructor finite-guards `cacheTtlMs` so a NaN / Infinity / 0 / negative value falls back to the 30-second default instead of degenerating the cache into always-miss (NaN) or never-expire (Infinity)

## Why

`packages/runtime-settings/src/index.ts:RuntimeSettings` is the
shared TTL-bounded cache fronting `RuntimeSettingsStore`. It's
used by the agent runtime to read live config values (feature
flags, model overrides, drift thresholds) without hammering the
DB on every lookup. Pre-fix constructor:

```ts
constructor(store, options = {}) {
  this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
  this.now = options.now ?? (() => new Date());
}
```

The `??` coalescing **does NOT catch NaN / Infinity / 0 /
negative**. Four poison shapes the operator can supply via
config / env / programmatic instantiation, each breaking the
cache in a distinct but silent way:

1. **NaN** (corrupt config: `Number("not-a-number")`, JSON
   round-trip loss, parseFloat on a unit-suffixed string).
   The cache write does `expiresAt = now.getTime() + NaN =
   NaN`. The cache read checks `cached.expiresAt > now()` —
   `NaN > anyNumber` is always `false`, so the cache always
   misses. Every getValue() hits the store. Cache is silently
   disabled with no diagnostic.
2. **Infinity** (a "cache forever" typo / `Number("inf")` /
   `1 / 0`). `now + Infinity = Infinity`. `Infinity > now` is
   always `true`, so the cache entry never expires. Worse:
   the cache survives `set()` calls on a SIBLING service
   instance (admin tools, scheduled re-loads, programmatic
   overwrites), so the agent reads stale values forever.
3. **0** (a deliberate "disable cache" attempt — but the
   contract is "0 means default", not "0 means disabled").
   `expiresAt = now + 0 = now`. `now > now` is false →
   always-miss. Cache silently disabled, same as NaN.
4. **Negative** (a unit confusion: `-30` seconds vs.
   milliseconds). Every entry is born expired. Same
   always-miss behavior.

### Reachability

- The `RuntimeSettingsOptions.cacheTtlMs` is operator-supplied
  via the autoconfigure wiring layer. A future env knob
  `MUSE_RUNTIME_SETTINGS_CACHE_TTL_MS` (not currently wired but
  trivially could be) would route through one of the env-
  parsers, which can produce NaN on bad input (parseInteger
  rejects, but parseFloat-style is more permissive).
- Programmatic callers in tests / admin tools could pass
  `Number(badConfig.ttl)` directly. If the JSON had
  `"ttl": "forever"` the result is NaN.
- The defect is silent — no error, no warning, just degraded
  performance (always-miss) or degraded correctness (stale
  cache). Both are observable only via store-hit-rate
  metrics, which a typical operator doesn't watch.

### Defect class

This iter's defect class — **`??` doesn't catch non-finite
numbers; a poison TTL silently degenerates an LRU/TTL cache
into always-miss or never-expire** — is fresh. Same family
as goals 608 (runtime-settings integer safety), 609 (cost
finite-clamp), 618 (ambient context cap finite-guard) — all
"`?? default` doesn't catch NaN/Infinity" — but the SURFACE
is different (cache TTL, not a token count or USD value).
Last `??`-finite-guard iter was 618, 23 iters back.

Against the recent window:

- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth bypass)
- 637: lenient base64 decode (loopback tool)
- 636: HTTP timeout
- 635: per-file concurrent write (memory store)
- 634: sort tiebreaker
- 633: surrogate-pair truncation
- 632: tilde-expansion
- 631: per-file concurrent write (messaging)

No finite-guard fix in the recent window. Solidly fresh.

## Slice

- `packages/runtime-settings/src/index.ts:RuntimeSettings`:
  - Constructor now extracts `rawTtl = options.cacheTtlMs ??
    30_000` first, then checks `Number.isFinite(rawTtl) &&
    rawTtl > 0` before storing. Non-finite / non-positive
    values fall back to the same 30-second default.
  - One short WHY comment names the threat model (NaN
    poisons, Infinity never-expires, 0/negative
    always-misses).
- `packages/runtime-settings/test/runtime-settings.test.ts`:
  - One new test in the existing `RuntimeSettings` describe.
    Four ttl-poisoning scenarios:
    1. **NaN** — pre-fix the cache always missed; the test
       seeds the store with `"on"`, reads via the service
       (caches `"on"`), then upserts directly to the store
       (`"off-but-cached"`); the SECOND read MUST still see
       `"on"` (cached). Pre-fix it would see `"off-but-cached"`
       because the cache always missed.
    2. **Infinity** — sanity check, falls to the default.
    3. **0** — sanity check, falls to the default.
    4. **Negative** — sanity check, falls to the default.

## Verify

- `@muse/runtime-settings` suite green (11 passed, +1 vs the
  pre-iter baseline of 10, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  `Number.isFinite(rawTtl) && rawTtl > 0` check back to the
  bare `?? 30_000` makes the new test fail with the EXACT
  pre-fix symptom — `Received: "off-but-cached"` (the cache
  missed and re-fetched the store value) vs. `Expected: "on"`
  (the cached value should still be returned). The 10
  pre-existing tests pass both pre- AND post-fix.
- `pnpm check` green: apps/api 261/261, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched. `smoke:live`
  doesn't apply.

## Status

Done. `RuntimeSettings` cache TTL is now resilient to every
realistic poison shape:

| `cacheTtlMs`           | Before                                | After                       |
| ---------------------- | ------------------------------------- | --------------------------- |
| Positive finite (5_000)| 5-second TTL                          | unchanged                   |
| undefined (default)    | 30-second TTL                         | unchanged                   |
| **NaN**                | **always-miss (cache disabled)**      | 30s default (**fixed**)     |
| **Infinity**           | **never-expire (stale forever)**      | 30s default (**fixed**)     |
| **0**                  | always-miss                           | 30s default (**fixed**)     |
| **Negative (-1)**      | always-miss (entries born expired)    | 30s default (**fixed**)     |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ finite-guard `fix:` on the runtime-config cache layer.
Recorded with this backlog row.

## Decisions

- **Falls back to 30-second default** for ALL invalid shapes,
  not throw. RuntimeSettings is a fail-open utility — it
  shouldn't break agent boot over a bad config value. The
  trade-off: a silent default vs. a loud failure. Silent
  default matches the established pattern in 608, 609, 618.
- **`rawTtl > 0`** rejects 0 too, not just negative. The
  documented contract is "TTL in milliseconds, default 30s";
  `0` is ambiguous (zero-second cache vs. unset) — choosing
  the safer default keeps the contract unambiguous.
- **Did NOT also guard `now`** (the injected clock factory).
  `options.now ?? (() => new Date())` — if `options.now` is
  defined-but-not-a-function, the lookup at `this.now()`
  would throw. But that's a type error caught at compile
  time by `() => Date`; no runtime defense needed.
- **Did NOT add a similar guard inside `cache.set()`** for
  the per-entry `expiresAt`. The store-level guard at
  construction time means `cacheTtlMs` is always finite-
  positive by the time we reach `now + cacheTtlMs`. One
  bottleneck, one check.
- **One short WHY comment** at the constructor names the
  threat model. Required because the test is the only place
  where "NaN cacheTtlMs" semantics is visible — a maintainer
  reading the line without context wouldn't see why bare
  `??` is insufficient.
- **Mutation choice.** Reverted only the
  `Number.isFinite(rawTtl) && rawTtl > 0` ternary back to
  `options.cacheTtlMs ?? 30_000`. One test fails with the
  exact "cache missed → read stale upsert" symptom. The 10
  pre-existing tests cover the happy path; they pass both
  pre- and post-fix.

## Remaining risks

- **Per-instance cache, not shared.** If multiple
  RuntimeSettings instances point at the same store (one
  in the agent runtime, one in an admin tool), they each
  have their own cache. A write through one instance
  invalidates that instance's cache via `this.cache.delete
  (input.key)` at line 152 — but the OTHER instance's
  cache stays warm with the old value until its TTL
  expires. This is the documented "never-expire" hazard
  on the Infinity branch, but applies to ANY positive TTL
  on multi-instance deployments. Not addressed; a pub/sub
  invalidation mechanism would be its own iter.
- **Other `?? default` sites might still need finite-
  guarding.** A grep for `?? \d+` finds many positions —
  most are not on cache TTLs but on default values that
  flow into bounds (`Math.max(min, ?? default)` etc).
  Each is its own audit; this fix bounded the
  RuntimeSettings cache TTL specifically.
- **Comment density.** The codebase prefers minimal
  comments; this fix's comment is justified per the
  CLAUDE.md exception ("non-obvious constraint or
  invariant"). A future style-tightening pass might
  prefer the comment shorter or absent.
