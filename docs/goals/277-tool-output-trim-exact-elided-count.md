# 277 — trimToolOutput's elision marker under-reported the elided char count

## Why

`trimToolOutput` (Context-Engineering step 1.b) is applied to
**every** tool result before it lands in the conversation — tool
output is Anthropic's named #1 source of context bloat. When it
truncates, it inserts a marker the doc explicitly designs to be
agent-facing and grep-able by downstream tooling:

> `[truncated: <N> chars elided of <M> total]`
> "Original size is surfaced so the agent can decide whether to
>  re-fetch with narrower scope."

The elided count was computed as:

```ts
const elidedChars = originalLength - maxChars;
```

But the marker occupies part of the `maxChars` budget, so the
characters actually kept are `head + tail = maxChars -
marker.length`, and the characters actually dropped are
`originalLength - (maxChars - marker.length)`. The reported
`elidedChars` was therefore **systematically short by the full
marker length** (~40–90 chars depending on the hint). With
`maxChars: 120` on a 1000-char input the marker claimed `880 chars
elided` while ~960 were actually gone. The `of <M> total` figure
was correct, but the "elided" number — a factual statement in
text the agent reads to size a re-fetch — was wrong on every
single truncation.

## Scope

`packages/memory/src/memory-tool-output-trim.ts` — `trimToolOutput`:

- Build the marker through `markerFor(elided)`. Reserve head/tail
  space against `markerFor(originalLength)` — an **upper bound**,
  since the elided count can never exceed `originalLength` (zero
  content kept), so its decimal width ≤ `originalLength`'s. This
  breaks the otherwise-circular "marker length depends on the
  number it prints" problem and guarantees the output still never
  exceeds `maxChars`.
- Compute the **exact** elided count from the real retained
  slices: `originalLength - head.length - tail.length`, and print
  that in the final marker. `head.length`/`tail.length` equal the
  reserved `headChars`/`tailChars` by construction (the input is
  longer than the cap), so the figure is exact, not approximate.
- The pathological tiny-budget branch now keys off the reserved
  marker width.

Behaviour preserved: `truncated`, `originalLength`, head/tail
ordering, `headRatio` split, the `maxChars <= 0` / already-fits
no-ops, and idempotency (output length ≤ `maxChars`, so a
re-trim at the same cap still passes through) are all unchanged.
The only change is that the printed elided count is now exact and
head/tail are sized against the slightly-wider reserved marker
(at most ~1 digit's worth fewer retained chars — a negligible
trade for a truthful number).

## Verify

- `pnpm --filter @muse/memory test` — 149 pass. New regression
  uses a single repeated char so every retained char is
  countable, with and without a hint: asserts the marker's
  `<N>` exactly equals `originalLength - retainedChars` (pre-fix
  it equalled `originalLength - maxChars`, off by the marker
  length), `<M>` equals the true original size, and the output
  still fits the cap. Existing trimToolOutput tests (head+tail
  preservation, hint surfacing, `headRatio` asymmetry, no-ops)
  stay green.
- `pnpm check` — every workspace green (memory 149, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic pure
  string transform). The fix is a string-arithmetic property
  exhaustively pinned by the exact-count regression — a live Qwen
  run cannot reproduce it on demand — so the deterministic unit
  test is the rigorous verification, same stance as
  goals 261 / 274 / 275 / 276.

## Status

done — the tool-output elision marker now states the exact number
of original characters that were dropped instead of under-counting
by its own length, so the agent's "should I re-fetch a narrower
slice?" decision is based on a truthful figure. Output still never
exceeds the cap and every other behaviour is unchanged.
