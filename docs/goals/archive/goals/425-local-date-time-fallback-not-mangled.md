# 425 — `formatLocalDate`/`formatLocalTime` don't mangle the passthrough fallback

## Why

User-facing correctness fix on a fresh axis (`apps/cli`
`human-formatters.ts` — the shared local-time renderer on EVERY
`muse tasks` / `muse remind` / `muse today` / `muse brief` /
calendar glance; never touched by the recent cluster).

`formatLocalDateTime` deliberately **passes an unparseable input
straight through** (its own NaN/short-string guard returns the
raw string — graceful degradation). But the date/time flavors
decided whether to slice using a **length check**:

```ts
formatLocalDate:  dateTime.length >= 10 ? dateTime.slice(0, 10) : dateTime
formatLocalTime:  dateTime.length >= 16 ? dateTime.slice(11, 16) : dateTime
```

A raw passthrough string can also be ≥10 / ≥16 chars, so it got
sliced into garbage. Probed:

```
formatLocalDate("not-a-date-string-here")  → "not-a-date"   (should be the original)
formatLocalTime("not-a-date-string-here")  → "strin"        (should be the original)
```

So a malformed/imported `dueAt` or a bad calendar timestamp
surfaced in `muse today` / `muse brief` as nonsense like
`"not-a-date"` or `"strin"` instead of the original value. The
existing test only checked the *short* `"nope"` (below both
thresholds), so the contract it asserts ("returns the input
unchanged for unparseable strings") was silently violated for
any long unparseable string.

## Slice

- `apps/cli/src/human-formatters.ts` — gate the slice on the
  canonical formatted shape `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$`
  (the only thing `formatLocalDateTime` ever emits on success)
  instead of a length heuristic. Non-canonical (passthrough /
  bare date) → return `dateTime` whole, degrading exactly like
  the parent. Valid output is byte-identical to before.
- `apps/cli/src/human-formatters.test.ts` — extend the existing
  "unparseable" test with a LONG unparseable string (both
  flavors return it whole) and a bare `2026-05-20` (no time →
  not sliced to a bogus time). Fails on the pre-fix code.

## Verify

- `@muse/cli` human-formatters.test.ts 16/16; the existing valid
  date-boundary / HH:MM cases unchanged (canonical gate doesn't
  touch valid output — no regression); full `@muse/cli` suite
  green (69 files / 731); tsc strict (cli) clean.
- `pnpm check` EXIT=0, every workspace green (api 194, cli 731,
  …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- Pure deterministic formatter verified with fixtures + a probe;
  not a model request/response path — no `smoke:live` applies.

## Status

Done. An unparseable or bare-date timestamp now degrades
gracefully through the date/time flavors (returned whole, like
`formatLocalDateTime` already did) instead of being chopped into
a meaningless substring in the user's daily glance.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a correctness fix to an existing renderer,
recorded honestly as a `fix(cli):` change with this backlog row
— not a false metric.

## Decisions

- Gate on the canonical shape, not a smarter length/parse
  re-check: the flavors should slice iff the parent produced its
  one canonical success shape — anything else is the parent's
  fallback and must be echoed verbatim to honour its contract. A
  regex of the exact emitted shape is the precise, drift-proof
  signal.
- Did not change `formatLocalDateTime`'s own passthrough policy
  (it is correct and widely relied on); scope held to the two
  flavors that mis-handled its fallback.
