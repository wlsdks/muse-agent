# 218 — `embed()` must reject an empty / non-finite embedding vector

## Why

`embed()` (`apps/cli/src/embed.ts`) is the single RAG
embedding chokepoint — shared by `muse notes` semantic search
(notes-rag), the episode index (goal 090), and `muse recall`
(goal 091). Its validation was:

```ts
if (!body.embedding || !Array.isArray(body.embedding)) {
  throw new Error("embedding response missing 'embedding' field");
}
return body.embedding;
```

That rejects a missing / non-array field, but **accepts an
empty array `[]` or a vector with non-finite / non-number
elements**. A wrong model id, an empty prompt on some
backends, or an OpenAI-compat embed endpoint with a different
shape can produce exactly that. The consequence is silent:
`cosineSimilarity` returns `0` for an empty vector and `NaN`
for a non-finite one, so **every hit scores 0/NaN** and the
ranking becomes garbage — with no error surfaced. The RAG
core silently returns meaningless recall results.

Also: `embed.ts` (both `embed` and `cosineSimilarity` — the
RAG core) had **zero direct test coverage** (implicit-only),
an explicit testing-rule gap.

## Scope

- `apps/cli/src/embed.ts`: tighten the guard to also reject
  an empty array and any element that isn't a finite number
  (`Array.isArray && length>0 && every(finite number)`),
  failing fast with
  `embedding response missing a valid numeric 'embedding'
  vector`. Callers already handle a thrown `embed` error
  (recall's `try/catch`, notes-rag's `ollama pull`
  notice), so this surfaces a clear actionable failure
  instead of silent garbage ranking — the goal-194/210/211
  "validate, don't silently propagate garbage" lesson at the
  RAG chokepoint. Happy path (a valid numeric vector) is
  byte-for-byte unchanged.
- New `apps/cli/src/embed.test.ts`: direct unit coverage for
  both exports — `cosineSimilarity` (identical / orthogonal /
  length-mismatch / empty / zero-norm) and `embed` (valid
  vector, non-2xx status+body, missing/non-array, **empty
  array**, **non-finite/non-number elements**) via an injected
  fake fetch.

## Verify

- `pnpm --filter @muse/cli test` — 528 pass (new test file;
  no regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Verification scope (transparent, same stance as the other
  deterministic-validator goals 194/210/214): the change is a
  pure validator over the parsed response, exhaustively
  unit-tested with an injected fetch (authoritative per the
  testing rules). The happy path (200 → numeric vector) is
  unchanged, and the real Ollama `/api/embeddings` round-trip
  behaviour — `200 → vector` and `404` when the embed model
  isn't pulled — was already observed empirically on real
  Ollama this session (the `embeddings 404 … ollama pull
  nomic-embed-text` notice in goals 201/204/216). Pulling an
  embed model purely to re-confirm an unchanged happy path
  adds nothing, so no separate dog-food was run.

## Status

done — a degenerate embedding response now fails fast with an
actionable error instead of silently corrupting notes-rag /
episode-index / recall ranking, and the RAG core (`embed` +
`cosineSimilarity`) finally has direct unit coverage.
