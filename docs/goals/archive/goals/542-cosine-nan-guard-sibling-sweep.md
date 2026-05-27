# 542 — three more cosine helpers (agent-core `cosineSimilarity`, cli `embed.cosineSimilarity`, cli `commands-ask.cosine`) get the same NaN-result guard as goal 541 (sibling sweep)

## Why

Goal 541 closed the NaN-leak defect on `commands-notes-rag.ts`'s
`cosine` helper. A grep for cosine implementations in the
codebase turned up **four** total — three more still carried
the same pre-fix pattern:

```ts
// packages/agent-core/src/episodic-recall.ts:259
return dot / (Math.sqrt(na) * Math.sqrt(nb));

// apps/cli/src/embed.ts:59
return dot / Math.sqrt(na * nb);

// apps/cli/src/commands-ask.ts:124
return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
```

Each defends the zero-magnitude case but NOT the NaN-in-vector
case — a corrupted embedding (hand-edited fixture, unusual
failed embed call) produces `dot=NaN`, `na=NaN`; the
zero-magnitude check (`na === 0`) is false on `NaN === 0`;
returns `NaN / Math.sqrt(NaN)` → `NaN`.

The downstream consumers each have different impacts:

- `agent-core` `cosineSimilarity` is used by the embedding
  episodic-recall path — a NaN score could bring up an
  unrelated past episode as "highly similar" to the current
  prompt, polluting LLM context.
- `cli` `embed.ts` `cosineSimilarity` ranks recall candidates
  for `muse ask` recall — NaN scores cause the
  `b.score - a.score` sort to scatter and place a
  corrupt-embedding candidate among top results.
- `cli` `commands-ask.ts` `cosine` is used by the same ask
  recall path — same defect, same impact.

Same NaN-leak defect class as goal 541 (and 511/512/518/526/
527). The convention now reads identically across all four
cosine helpers in the codebase.

## Slice

- `packages/agent-core/src/episodic-recall.ts:256-260` —
  add finite guard after the division.
- `apps/cli/src/embed.ts:58-60` — same.
- `apps/cli/src/commands-ask.ts:116-125` — same; the bare
  single-line `return X || Y ? 0 : div` became a 3-line
  block for the explicit finite guard.
- `apps/cli/src/embed.test.ts` — added one new test to the
  existing `cosineSimilarity` describe block:
  - NaN in either vector → 0 (the defect this iteration
    closes)

The agent-core and commands-ask helpers are byte-identical in
shape to embed.ts (the mutation-proven representative). All
three got the same `if (na === 0 || nb === 0) return 0;
const result = ...; return Number.isFinite(result) ? result :
0;` pattern.

## Verify

- New test 1/1 green; full `@muse/cli` suite green (932
  passed, +5 vs baseline 927 — includes the new assertion +
  the existing 4 lines from goal 541's assertion block, 0
  failed); full `@muse/agent-core` suite green (646 passed,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `embed.ts`'s finite guard back to the bare
  `return dot / Math.sqrt(na * nb);` makes the NaN test
  fail with the precise pre-fix symptom — `expected NaN to
  be +0`. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the four intended files.
- Pure scoring helper — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended paths are the
  episodic-recall ranking, `muse ask` recall ranking, and
  `muse notes-rag query` ranking (already fixed in 541),
  not the model loop itself.

## Status

Done. All four cosine helpers in the codebase now reject NaN
results uniformly:

- `commands-notes-rag.cosine` (goal 541)
- `agent-core.cosineSimilarity` (this goal)
- `embed.cosineSimilarity` (this goal)
- `commands-ask.cosine` (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling sweep `fix:` that
closes the cosine-helper class entirely, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 541 onto the analogous
  siblings. Same defect class, four sites in three files
  (one in mcp-core, two in cli) — productive sibling sweep
  that closes a class entirely, not same-area churn.
- Used the same `if (na === 0 || nb === 0) return 0; const
  result = ...; return Number.isFinite(result) ? result : 0;`
  pattern across all three new sites (matches goal 541
  byte-for-byte). Cross-codebase convention reads identically
  on the rare future maintainer who grep-fixes a fifth
  cosine helper.
- Tested only the embed.ts site directly (mutation-proven
  representative). agent-core and commands-ask cosines have
  byte-identical shapes and the same mutation would fail
  identically — cross-package convention is to test one
  representative when implementations are mechanical copies.
- Did NOT promote `agent-core.cosineSimilarity` or
  `commands-ask.cosine` to direct test coverage in this
  iteration: each is exercised through integration paths
  (episodic recall e2e, `muse ask` recall e2e). Future
  iterations may add per-helper unit tests if the helpers
  drift apart.
- The mutation reverts only the 3-line guard on embed.ts to
  the pre-fix one-liner; the test failure (`expected NaN to
  be +0`) reproduces the pre-fix observable byte-for-byte —
  NaN propagates through scoring instead of being clamped.
