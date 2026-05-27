# 541 — `cosine` returns 0 (not NaN) when an embedding contains a NaN value, protecting the RAG sort/render from `[NaN]` scores

## Why

`apps/cli/src/commands-notes-rag.ts:131` defined the
similarity-scoring helper used by `muse notes-rag query` to
rank chunks against a query embedding:

```ts
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
```

The function defended against the zero-magnitude case
(`na === 0 || nb === 0 → 0`), but NOT against NaN values
inside the embeddings themselves. If a stored chunk embedding
ever contained `NaN` (a corrupted notes-rag-index.json, a
hand-edited fixture, an unusually-failed embed call that
emitted NaN), then:

- `dot += NaN * b[i]` → `dot = NaN`
- `na += NaN * NaN` → `na = NaN`
- `na === 0 || nb === 0` → `NaN === 0` → both false →
  return `NaN / Math.sqrt(NaN * NaN)` → `NaN`

The downstream consumer (`commands-notes-rag.ts:430`):
```ts
.sort((a, b) => b.score - a.score)
```
NaN comparisons all return false; JS sort behaviour on a
NaN-containing array is unspecified — entries with NaN scatter
unpredictably and may end up among the top-k. Then the render
at line 440 prints `[NaN] file.md#3` literally, confusing the
operator.

Same NaN-leak defect class as goals 511/512/518/527 — a NaN
that should be filtered at the producer leaks through to the
consumer's render/sort/aggregate. Here on a freshly-uncovered
surface (RAG cosine scoring).

## Slice

- `apps/cli/src/commands-notes-rag.ts` — added a finite-result
  guard at the end of `cosine` and promoted it to `export`:
  ```ts
  export function cosine(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i += 1) { … }
    if (na === 0 || nb === 0) return 0;
    const result = dot / Math.sqrt(na * nb);
    return Number.isFinite(result) ? result : 0;
  }
  ```
  Behaviour byte-identical for every clean numeric embedding
  pair — only the NaN/Infinity path now falls back to 0.
- `apps/cli/src/commands-notes-rag.test.ts` — added one new
  `describe(...)` block with 4 focused tests:
  - length mismatch → 0
  - zero-magnitude vector → 0 (regression pin)
  - clean parallel vectors → 1.0
  - NaN in either vector → 0 (THE defect this iteration closes)

## Verify

- New tests 4/4 green; full `@muse/cli` suite green (927
  passed, +6 vs baseline 921, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  finite guard back to the bare `na === 0 || nb === 0 ? 0 :
  dot / Math.sqrt(na * nb)` makes the NaN test fail with the
  precise pre-fix symptom — `expected NaN to be +0` (the NaN
  in either embedding propagates through to the score). Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure scoring helper — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the
  `muse notes-rag query` ranking + render, not the model loop.

## Status

Done. A corrupted chunk embedding with NaN values no longer
produces `[NaN]` scores in the operator's `muse notes-rag
query` output, no longer scatters unpredictably through the
sort, and no longer surfaces among the top-k matches as a
phantom high-score result. The NaN-leak defence convention
now covers six sibling sites:

- scheduler execution-log durationMs (511)
- observability token-cost INSERT row (512)
- multi-agent orchestration-history summary (518)
- compat run-history latency distribution (526)
- observability latency query `computeDurationMs` (527)
- RAG cosine scoring (this goal)

Each rejects NaN/Infinity at the producer rather than letting
it propagate into downstream sort/aggregate/render.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a NaN-leak `fix:` on the RAG
cosine helper, recorded honestly with this backlog row — not
a false metric.

## Decisions

- Step-8 redirect from the empty-env-shadow run (539/540) to
  a fresh NaN-leak defect class on a different surface (RAG
  scoring instead of file-path resolution). Productive
  variation, not same-area churn.
- Defended at the cosine function rather than the render:
  the sort step at line 430 (`b.score - a.score`) is the
  load-bearing call — NaN comparisons leave the sort
  unspecified, so a NaN score could place the corrupt chunk
  anywhere in the top-k, not just at the end. A render-side
  fix would mask the visible "NaN" but the ranking would
  still be corrupted. Cosine-side is the right boundary.
- Returned 0 (not undefined) on the NaN path: callers
  expect `number`, and 0 is the "no similarity" sentinel
  that already exists for `na === 0 || nb === 0`. Same
  shape, same downstream behaviour. Mirrors goal 526's
  "route NaN to unknown" decision but with the bucket
  semantics inverted (0 = no signal here vs. unknown bucket
  there).
- Promoted `cosine` to `export` so the unit tests pin the
  defence directly. Pre-fix it was internal; no other
  caller existed in the module.
- The mutation reverts only the 3-line guard back to a bare
  one-liner; the test failure (`expected NaN to be +0`)
  reproduces the pre-fix observable byte-for-byte — NaN
  propagates through scoring instead of being clamped.
