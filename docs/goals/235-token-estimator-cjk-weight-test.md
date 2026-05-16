# 235 — lock the CJK/Korean token-weight invariant

## Why

`computeApproximateTokens` (@muse/memory) is load-bearing: it
backs `prompt-budget.ts`'s per-section measurement AND the
working-budget compaction trigger. Its character-class
heuristic correctly weights CJK/Korean heavier than Latin
(latin ≈ chars/4 ≈ 0.25 tok/char; cjk ≈ (chars*2+1)/3 ≈ 0.67
tok/char) — this is exactly what keeps a Korean-primary user
(the project's primary language) from silently overflowing a
small-context Qwen window: under-counting Korean ~2.7× would
make the compaction trigger fire too late / never.

The existing test asserted only tiny inputs:

```ts
expect(computeApproximateTokens("abcd")).toBe(1);
expect(computeApproximateTokens("안녕")).toBe(1);
```

Both floor to 1, and the function's `Math.max(1, …)` floor
means a regression to a **naive English `chars/4`** (dropping
the CJK class entirely) would *still* yield `1` for `"안녕"`
— the existing test **cannot catch the most dangerous
regression** for the primary user. The user-critical relative
weighting was effectively untested.

## Scope

- `packages/memory/test/memory.test.ts`: a new case locking
  the relative weighting — `computeApproximateTokens` of a
  90-char Latin string is exactly 22 (`floor(90/4)`), of a
  90-char Korean string is exactly 60 (`floor((90*2+1)/3)`),
  Korean > Latin, Korean > the naive `floor(90/4)` heuristic,
  and a mixed `"hello 안녕하세요"` string is 4 (both classes
  contribute, CJK dominates). A regression to `text.length/4`
  would yield 22 for the Korean string → the test fails.
  Test-only; no source change. Korean is plain UTF-8 literal
  text (not control bytes).

## Verify

- `pnpm --filter @muse/memory test` — 147 pass (1 new;
  existing token-estimator + memory cases unchanged → no
  regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Test-only hardening of a pure deterministic helper — no
  model invoked, no real-LLM path; explicitly a valid
  refining/hardening iteration ("tests") per the loop. No
  smoke:live needed.

## Status

done — the CJK/Korean-heavier-than-Latin token-weight
invariant that protects the Korean-primary user's
context-budget / compaction trigger on small-context Qwen is
now pinned by an exact-value regression test that a naive
English `chars/4` rewrite would fail. The existing weak
tiny-input assertions are kept (no behaviour change).
