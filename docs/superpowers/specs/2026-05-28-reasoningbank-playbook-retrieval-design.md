# ReasoningBank for Muse — Slice 1: relevance-ranked playbook injection

Status: design / approved-direction
Date: 2026-05-28
Paper: ReasoningBank — Scaling Agent Self-Evolving with Reasoning Memory
(arXiv 2509.25140, Google Cloud AI Research, 2025-09)

## Why

Muse already has the ACE playbook (arXiv 2510.04618) as its single,
canonical self-improvement channel: `~/.muse/playbook.json` +
`muse playbook add|list|remove` + the runtime-wide `[Learned
Strategies]` injection. Commit `3b79006c` deliberately removed the
parallel `muse feedback` channel because "two parallel channels give
the small local Qwen two overlapping directive blocks."

ReasoningBank's contribution over plain ACE is twofold:

1. **Self-evolving** — strategies are *distilled automatically* from
   run outcomes (success AND failure), not only hand-authored.
2. **Retrieved, not dumped** — only strategies *relevant to the
   current task* are surfaced, instead of injecting the whole bank.

Today Muse has neither: strategies are 100% manual (`muse playbook
add`) and injection is **inject-all** (`renderPlaybookSection` over
every entry, capped at 100).

This is a multi-slice feature. Per `iteration-loop.md` it is
decomposed:

- **Slice 1 (this doc):** relevance-ranked top-K injection
  (deterministic, no LLM). The foundation — once distillation grows
  the bank, inject-all would dilute the small model's directive
  block.
- **Slice 2 (later, separate brainstorm):** correction-driven
  auto-distillation — at session end, an LLM distills a generalised
  strategy from a *corrected* trajectory into the SAME playbook with
  provenance. Reliable failure signal only; no fragile small-model
  self-judgement (cf. arXiv 2404.17140, "Small Language Models Need
  Strong Verifiers to Self-Correct Reasoning").

This doc covers **Slice 1 only**.

## Constraints honoured

- **One channel.** Writes/reads the existing `~/.muse/playbook.json`;
  no new store, no parallel directive block.
- **Local-first, deterministic.** Token-overlap relevance, no
  embeddings, no LLM call, no new dependency. Swap-point left open
  for embeddings later (same function signature).
- **Small-model tight context.** Bounds the injected directive block
  to a few most-relevant strategies (`tool-calling.md`: keep the
  prompt's directive surface tight).
- **Cited in code.** A one-line WHY comment names the paper + id at
  the implementation site, per `OUTWARD-TARGETS.md` open-research
  rules.

## Architecture

### New pure function — `rankPlaybookStrategies`

Location: `packages/agent-core/src/playbook.ts` (beside
`renderPlaybookSection`, same module, no new file — it is small and
cohesive with the existing render logic).

```ts
export interface RankPlaybookOptions {
  readonly topK?: number;       // default 6
  readonly minScore?: number;   // default 0 (any overlap counts)
}

export function rankPlaybookStrategies(
  strategies: readonly PlaybookStrategy[],
  queryText: string,
  options?: RankPlaybookOptions
): readonly PlaybookStrategy[];
```

Behaviour:

1. If `strategies.length <= topK` → return all, ordered best-first
   (identical *set* to today; only ordering changes). This keeps the
   common small-bank case behaviourally unchanged.
2. Else score each strategy by relevance to `queryText`:
   - token-overlap between `queryText` tokens and the strategy's
     `text` (+ `tag`) tokens, reusing the project's existing
     CJK-aware, stopword-filtered tokenisation (the same approach
     `episodic-recall` / `knowledge-recall` use — reuse, do not add
     a new tokeniser). Korean matters (the user is Korean), so the
     CJK-aware path is required.
   - small additive boost when `queryText` contains the strategy's
     `tag` as a token.
3. Select the `topK` highest-scoring with `score > minScore`,
   best-first.
4. **Recency floor:** if fewer than `topK` clear `minScore`, top up
   from the *tail* of the input array (file order is insertion order
   = oldest→newest, so the tail is most recent). Guarantees a
   non-empty bank never injects zero strategies.

No schema change: recency comes from input array order, so
`PlaybookStrategy` / `PlaybookEntry` are untouched (`createdAt` not
needed in the ranker).

### Wiring — both injection paths reuse the one function

- **Runtime path (`applyPlaybook`, `--with-tools`):** extract the
  latest user message text from `context.input.messages`, pass it as
  `queryText`, rank, then `renderPlaybookSection` over the ranked
  subset. Conservative + fail-open semantics preserved (no provider /
  no userId / empty → unchanged input; throwing provider → no-op).
- **Chat-only path (`muse ask`):** in `commands-ask.ts` around the
  existing `queryPlaybook → renderPlaybookSection` block
  (~line 750), insert `rankPlaybookStrategies` using the user prompt
  as `queryText`.

### Config

- `MUSE_PLAYBOOK_INJECT_TOPK` (default `6`) — tune the injected cap.
- `MUSE_PLAYBOOK` (existing on/off) unchanged.

## Data flow

```
user turn ─┬─ (--with-tools) applyPlaybook
           │      listStrategies(userId) ─► rankPlaybookStrategies(_, latestUserText)
           │      ─► renderPlaybookSection ─► [Learned Strategies] system block
           │
           └─ (chat-only) commands-ask
                  queryPlaybook(file,userId) ─► rankPlaybookStrategies(_, prompt)
                  ─► renderPlaybookSection ─► composeChatSystemContent
```

## Edge cases

- Empty/whitespace `queryText` → no overlap computable → recency
  top-K (never crash).
- All scores 0 (no overlap) and bank > topK → recency top-K (never
  inject zero when the bank is non-empty).
- Bank ≤ topK → all strategies, best-first (today's set, reordered).
- Strategy with no `tag` → text-only scoring.
- Security: `sanitizeInline` in `renderPlaybookSection` still runs;
  the ranker only reads text for scoring, adds no injection surface.

## Verification (the falsifiable check)

Deterministic logic, so unit + integration are the real gate (not
smoke:live):

- `packages/agent-core/test/playbook.test.ts` (extend):
  - relevant strategy ranks above an irrelevant one for a given
    query;
  - `bank ≤ topK` → all returned (set unchanged), best-first;
  - `bank > topK` → least-relevant dropped; the query-matching
    strategy is present, an unrelated one absent;
  - recency floor: zero-overlap query over a `> topK` bank returns
    the `topK` most-recent;
  - empty query → stable (recency top-K), no throw.
- Chat-only integration (`commands-ask-playbook.test.ts`, extend):
  for an email-themed prompt with a `> topK` bank, the email
  strategy is injected and a scheduling-only strategy is not.
- Gates: `pnpm --filter @muse/agent-core test`, the CLI ask test,
  `pnpm lint` (0/0). smoke:live is a *secondary* confirmation (it
  touches the system-prompt path) but the model semantics are
  unchanged, so the deterministic tests are authoritative.

**Effect measured, not just "code runs":** the integration test
asserts that *which* strategies reach the model changes with the
query — the paper's "retrieved, not dumped" claim, made observable.

## Out of scope (Slice 1)

- Auto-distillation (Slice 2).
- Embedding-based ranking (swap-point only).
- A "pinned/global, always-apply" strategy flag (revisit only if a
  global strategy is observed dropping once the bank exceeds topK).
- Lost-in-the-Middle edge-loading of the directive list (the list is
  ≤ topK short; best-first ordering is enough — no edge-load).

## CAPABILITIES.md line (on delivery)

`- [Presence] The learned-strategy playbook injects only the
strategies RELEVANT to the current turn, not the whole bank
(ReasoningBank, arXiv 2509.25140: retrieve relevant reasoning memory
rather than dump it) — rankPlaybookStrategies wired into both
applyPlaybook and the chat-only muse ask path — playbook.test.ts +
commands-ask-playbook.test.ts — research-applied slice`
