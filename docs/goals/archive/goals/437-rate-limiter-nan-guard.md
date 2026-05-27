# 437 — A non-finite rate-limiter option can't self-DoS /api/chat (436 sibling)

## Why

Safety/availability fix — the tight, single-sibling continuity of
goal 436 (NOT a speculative `Math.max(N, x ?? d)` sweep; the
436-class has ~20 call sites — this picks the one that, like 436,
silently breaks a safety/availability *bound*).

`apps/api/src/chat-rate-limiter.ts` clamped its options with
`Math.max(N, options.x ?? default)`. `??` only catches
`null`/`undefined`, not `NaN`/`Infinity`, and
`Math.max(1, NaN) === NaN`. A non-finite `capacity` (corrupt
config / `Number(badEnv)` / a computed value) made
`this.capacity = NaN`; in `consume()` the first request seeds
`tokens = NaN - 1 = NaN`, and every subsequent request hits
`existing.tokens >= 1` → `NaN >= 1` → **false** → **denied**,
with a `NaN` `retryAfterSeconds`. So one non-finite option turns
the per-IP guard on the core `/api/chat` endpoint into a
**self-inflicted DoS** (everything 429s after the first call).
`Infinity` capacity → `Math.max(1, Infinity)` = Infinity → the
opposite failure: an *unbounded* limiter (no protection). Same
`??`-doesn't-catch-NaN class as goals 414/418/428/436, on an
availability/security bound, and uncovered (every test passed
finite options).

## Slice

- `apps/api/src/chat-rate-limiter.ts` — module `finiteOr(value,
  fallback)` = `Number.isFinite(value) ? value : fallback`,
  applied inside the existing `Math.max(...)` for `capacity`
  (60), `windowMs` (60_000) and `evictAfterMs` (5 min). Prior
  semantics preserved exactly (the floors, explicit finite
  values); only `NaN`/`Infinity` → the safe default instead of a
  broken limiter. Mirrors the 436 agent-runtime clamp.
- `apps/api/test/server.chat-rate-limit.test.ts` — regression: a
  `NaN` capacity allows the default-60 budget (pre-fix: denied
  from the 2nd request); `Infinity` capacity is still bounded at
  60 (not unlimited); a `NaN` windowMs still bounds normally
  (refill math not poisoned). Fails on the pre-fix code.

## Verify

- `@muse/api` server.chat-rate-limit.test.ts 6/6 (+1); the
  existing finite-option / per-IP / retry-after tests unchanged
  (the clamp is identity for finite values — no regression); tsc
  strict (api) clean.
- `pnpm check` EXIT=0, every workspace green (api 195→196, cli
  737, …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan
  clean; `git status` shows only the two intended files.
- Deterministic limiter logic verified with a frozen clock — not
  a model request/response path; no `smoke:live` applies.

## Status

Done. A corrupt/computed non-finite rate-limiter option now
degrades to the safe default (60 req / 60 s) instead of either
DoSing `/api/chat` (NaN → deny-all) or removing the protection
entirely (Infinity → unbounded). The per-IP chat guard survives
a non-finite config.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a safety fix to an existing guard, recorded
honestly as a `fix(api):` change with this backlog row — not a
false metric.

## Decisions

- One sibling, not a sweep: the 436-class has many `Math.max(N,
  x ?? d)` sites, but most degrade to a benign empty-result on
  NaN. The rate limiter is picked because — exactly like 436 —
  NaN/Infinity silently breaks a *safety/availability bound*
  (self-DoS or no-protection), the high-severity subset. The
  remaining benign sites are deliberately NOT mass-edited
  (loop-banned defensive churn without observed impact).
- `finiteOr` rejects `Infinity` too (it is not finite): an
  unbounded rate limiter is as wrong as a broken one for a
  cost/abuse guard — both collapse to the documented default.
