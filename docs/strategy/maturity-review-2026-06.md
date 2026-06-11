# 4-domain maturity review — 2026-06-10

> Jinan's question: "컨텍스트 엔지니어링·메모리·서브/멀티에이전트·RAG — 마스터급인가?"
> Read-only review with code evidence (full findings in the session record; grades + gaps here).

| Domain | Grade | One-line verdict |
|---|---|---|
| RAG | **A−** | Literature-complete stack, each piece source-cited, exceptional eval honesty (negative results recorded). Gaps: contextual chunk annotation, multi-hop (measure first), reranker. |
| Context engineering | **B+** | Real write/select/compress/isolate pipeline, KV-stable prefix, per-section budget METER — but the meter never ENFORCES, blocks lack ablation evidence, and ask's hand-assembled blocks live outside the marker system. |
| Memory | **B** | Mem0-class ops + provenance + no-forge-episodes design + encryption on 5 stores. Embarrassment: **ACT-R shipped dead** (nothing populates accessTimesIso; store-backed provider bypasses it). Cross-key contradiction (stale-fact grounded lie) still open. |
| Multi-agent | **C+** | Clean plumbing + the council surface is genuinely good (gated, live batteries). But handoff is blank-only-validated (no typed schema), zero live orchestration eval, and `race`/`parallel` on ONE local GPU is a latency fiction — mostly museum, not product. |

## Do-next (review's top 5)

1. **Wire the dead ACT-R path** — populate access timestamps on recall hits; switch StoreBackedEpisodicRecallProvider to episodeTimeBoost. (Memory)
2. **Multi-hop recall battery FIRST** — 5-10 KO/EN two-hop cases; decide if decomposition matters at personal scale. (RAG)
3. **Contextual chunk annotation, deterministic slice** — prepend title/heading path at index time; A/B on embedder-ab. (RAG, −49% pedigree)
4. **Prompt-budget enforcement + one block-ablation arm** — meter→dropper; clone the reasoning-principles A/B onto feeds or reflection. (Context)
5. **Multi-agent: subtract then type** — park `race`, decide product-vs-museum for the API routes; survivors get a Zod-typed handoff + ONE live orchestration battery. (Multi-agent)

## DELETE list (subtraction principle)

- Duplicate time line in ask's prompt + next_up/today_events double-listing (unproven ~40 tokens).
- Episodes MCP `search` mode "llm-judge" (maker=judge path on a store that was deliberately model-proofed).
- `race` mode (single-GPU fiction).
- Duplicated chunkers (commands-notes-rag vs knowledge-recall + ad-hoc 1200-char calls) — one chunker before contextual annotation ships.
