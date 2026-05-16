# 285 — duplicate-numbered exemplars collided on id and were silently dropped

## Why

`parseExemplarMarkdown` (`@muse/prompts`) turns the answer-quality
exemplar file into few-shot documents that
`InMemoryExemplarRetriever` scores and injects into **every**
system prompt. Each document's `id` was derived from the parsed
header number:

```ts
documents.push({ body: block, id: `exemplar-${index}`, index, scenario, title });
```

The header regex matches **both** `[Example N - …]` and the
Korean `[예시 N - …]`. A bilingual exemplar file (this is a
Korean-primary project) that has `[Example 1 - …]` *and*
`[예시 1 - …]` — two distinct, legitimate few-shot examples —
parses both to `index = 1`, hence the **same** `id`
`"exemplar-1"`. Downstream that id is treated as a unique handle:

- `InMemoryExemplarRetriever.retrieveTopK` dedups by
  `seen.has(document.id)` — the second same-id exemplar is
  **silently dropped** even when it is a top scorer, halving the
  few-shot signal for one language.
- `pinnedIds.map(id => documents.find(d => d.id === id))` only
  ever resolves the first, so the second can never be pinned.

A relevant exemplar quietly vanishing from the prompt degrades
answer quality with zero signal — the prompt-assembly analogue of
the silent-wrong class this loop keeps closing.

## Scope

`packages/prompts/src/index.ts` — `parseExemplarMarkdown`:

- Track emitted ids; the first block for a number keeps the
  stable `exemplar-N` id (preserving the public contract that
  `pinnedIds` configs and existing tests rely on), and a
  colliding block is suffixed with its parse position
  (`exemplar-N-<pos>`) so it is unique, stable, and reachable.
  `index` (the human number, used for sort/display) is unchanged.
  One short WHY comment records the bilingual-collision
  rationale.

Behaviour-preserving for every well-formed file: uniquely
numbered exemplars still get exactly `exemplar-1`, `exemplar-2`,
… (a suffixed id `exemplar-N-<pos>` can never equal an
`exemplar-<digits>` base, so no cross-collision).

## Verify

- `pnpm --filter @muse/prompts test` — 24 pass. New regression: a
  bilingual file with `[Example 1 …]` + `[예시 1 …]` parses to
  **2** documents with distinct ids (first is `exemplar-1`), and
  `InMemoryExemplarRetriever` renders **both** (pre-fix the second
  was dropped by id-dedup). The existing
  `exemplar-1`/`exemplar-2`/`exemplar-3` parse + pinned-dedup +
  fallback tests stay green (well-formed contract unchanged).
- `pnpm check` — every workspace green (prompts 24, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure deterministic
  markdown parsing). A live Qwen run cannot reproduce a
  duplicate-number collision on demand, so the deterministic
  regression is the rigorous verification — same stance as goals
  261 / 274–284.

## Status

done — exemplars that legitimately share a number (e.g. a
bilingual English/Korean file) now get unique, reachable ids
instead of collapsing into one, so a relevant few-shot example is
no longer silently dropped from the system prompt. Well-formed
single-language files are unchanged.
