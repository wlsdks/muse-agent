# 378 — Knows-you · anticipates · asks (OUTWARD-TARGETS P0)

Category: epic / outward (P0 — foundational; interwoven with P1)

## Why

Falsifiable-outward: after P0 ships, Muse **learns the user from
real use across every surface** (not just the REPL chat-only path)
and applies what it learns — so the just-delivered channel
conversation (P1) is no longer "hollow." Exercised by: talk to
Muse on a wired channel / the API with tools, then see a stated
fact/preference influence a later answer.

## Slices (the P0 bullets)

1. **Auto-extract on the API runtime + tool-using turns** — the
   user model grows from real use, including channel chats.
2. **Embedding-similarity recall + preferences actually applied** —
   a stored preference changes a differently-worded later answer.
3. **Infer an unstated need and surface it unasked** — from
   calendar / inbox / patterns context.
4. **Ask a clarifying question instead of guessing** on an
   ambiguous request.

## Verify

- Per slice: the bullet's mandated integration check green +
  `pnpm check` + `pnpm lint` 0/0.

## Status

slice 3 done — **P0-b2 parent flipped** (all split children met).
`StoreBackedEpisodicRecallProvider` (the production episodic-recall
provider built by `buildEpisodicRecallProvider`) gained an optional
`embed`: when set it cosine-ranks narratives instead of Jaccard;
**fail-open** — a thrown embedder (Ollama down / model not pulled)
degrades that resolve to Jaccard so recall never breaks. The
assembly now wires a zero-cost local-Ollama embedder
(`/api/embeddings`, `nomic-embed-text`, default-on; opt out with
`MUSE_EPISODIC_RECALL_EMBED=false`) by default. Integration tests
(deterministic embedder, no network): production StoreBacked
paraphrase recall works; throwing embedder → Jaccard fallback (no
crash); no embedder → Jaccard back-compat. So production
cross-session recall IS embedding-similarity (zero-cost, safe),
the preference-applied child was already true by design — P0-b2
genuinely delivered, parent `[x]`.

Verification: the embedder calls Ollama `/api/embeddings` (not the
chat round-trip; zero-cost local) and is fail-open, so a missing
Ollama can't break recall; P0-b2's mandated check is "integration"
— the green deterministic StoreBacked tests are the gate (smoke:live
is the chat path, untouched).

slice 2 — P0-b2 SPLIT (parent stays `[ ]` until all children met,
per the contract split rule). Investigation found P0-b2 bundled two
separable things on a partly-stale premise:
- "notes RAG already has cosine" is **stale** — `loopback-notes.ts`
  explicitly avoids embeddings ("cheaper than pgvector"); there was
  **no reusable cosine/embedder primitive** in the repo.
- "a stored preference applied to a differently-worded later
  request" is **already true by design**: `applyUserMemory`
  injects every preference wholesale into the system prompt for any
  userid run (not query-matched), so wording never gates it —
  pinning that with a test would be banned already-covered work.

Delivered this slice (the real recall half): `cosineSimilarity` +
`EmbeddingEpisodicRecallProvider` in `episodic-recall.ts` — an
async `EpisodicRecallProvider` (the interface already permits
`Promise`) that ranks narratives by cosine to an injected embedder
instead of Jaccard token overlap, reusing the same recency /
threshold / per-user-visibility / topK. Integration test
`episodic-recall-embedding.test.ts` (deterministic concept
embedder, no network): a zero-token-overlap **paraphrase** recalls
the right memory, the Jaccard `InMemoryEpisodicRecallProvider`
structurally **misses** the same query (score 0 < minScore), and a
decoy stays correct — proving exactly the gap embedding closes.

No bullet flip / no `CAPABILITIES.md` line this slice (parent
P0-b2 stays `[ ]`; appending a non-flipping line would be thin —
honest epic decomposition, like 377 s1). The remaining child =
wire a zero-cost local-Ollama embedder into the assembly so
production episodic recall uses this provider (Rejected-ledger
note added). Right-sized: shipping the verified provider as one
coherent slice, not over-building the production embedder wiring +
half-testing it in the same commit.

slice 1 done — flips OUTWARD-TARGETS **P0-b1**. The auto-extract
hook (`createUserMemoryAutoExtractHook`, `afterComplete` —
tool-agnostic) was ALREADY wired into the API AgentRuntime via the
assembly (`autoconfigure/index.ts` `runtimeHooks`), so the bullet's
"REPL-only" premise was stale for the API path. The genuine,
concrete P0↔P1 seam gap: the inbound-channel agent run (goal 377)
set **no `metadata.userId`**, so `readUserId` returned undefined
and the hook no-opped — channel conversations never grew the user
model ("a channel chat is hollow if it doesn't know you").

Fix: `apps/api/src/server.ts` inbound runner now sets
`metadata: { userId: \`${providerId}:${source}\` }` (the channel
identity is that chat's user-memory scope, consistent with the
goal-377 thread-store keying). Integration test
`packages/agent-core/test/auto-extract-tool-turn.test.ts` composes
the real hook + an LLM-shaped extractor + JSON extraction +
sanitisation + `InMemoryUserMemoryStore` on a tool-using-turn
context: with the channel userId a fact is stored; **without a
userId nothing is stored** — pinning exactly the gap the channel
userId closes.

## Decisions

- Auto-extract is `afterComplete` and tool-agnostic — wiring it as
  a runtime hook is precisely what fixes the old REPL "skip
  extraction when tools enabled" behaviour; the integration drives
  the hook the way the runtime does, on a tool-using-turn context
  (a full bespoke tool-loop runtime would be gold-plating and
  verifies nothing extra about the hook).
- The LLM round-trip / `agentRuntime.run` message shape is
  unchanged (only `metadata.userId` added); auto-extract's extra
  `generate` is the existing wired hook behaviour, now reachable
  for channel runs. P0-b1's mandated check is "integration" — the
  green agent-core test — so re-running full smoke:live is not the
  proportionate gate.
