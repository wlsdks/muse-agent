# capability-boost loop — journal

Theme: measure-first capability/orchestration 강화 → Muse를 개인 AI 에이전트 중 최강으로.
Cron `7d79e9c9` (every 20m, session-scoped). Tier1 (local commit, no push). Started 2026-06-16.

## Candidate queue (fire ② reads this first; value-first, not easy-first)

**Measured ROI POSITIVE (build-ready):**
- **multi-hop recall wiring** — `rankKnowledgeChunksWithHop` (packages/agent-core/src/knowledge-recall.ts:1144) is fully built + tested (AUGMENT-never-displace, query-relative cosine), and `packages/autoconfigure/src/knowledge-corpus.ts:485,582` calls it with `secondHop` gated on `MUSE_RECALL_SECOND_HOP==="true"` — but the `muse ask` notes-recall path does NOT route through knowledge-corpus, so two-hop questions are unserved. Live measure (this session, `eval:multihop`): single-hop hit@4 = 2/5 (40%) on two-hop queries → decomposition has ROI. Wire it into ask retrieval (seed from confident matches → re-query on seed text), gate "second-hop only when single-hop weak" for speed. Guard: `eval:multihop` hit@4 40%→target ≥80%.

**Measured ROI ZERO (do NOT build — dropped):**
- notes-index task prefix: KO→EN note hit@4 already 7/7 without prefix (notes rank by relative cosine). Cancelled.
- reranker, proactive cosine-only, nearestHeading label bug: measured ~0 retrieval impact.

## Workflow deep-scan (49 agents, 36→31 confirmed, 2026-06-16) — verified findings, by ROI

HIGH/MEDIUM roiVerdict (build candidates after a measure where flagged):
- [observability] `muse ask` never writes `success:false` failure trace — scout/doctor failRate gets zero fuel from the wedge surface (errorMessage seam built but dead; chat-repl already does it). SMALL.
- [cli-ux] slow/leaked-fd pipe into `muse ask`/`chat` silently drops piped stdin (chat-repl.ts readPipedStdin 200ms first-byte → resolves '' with NO signal). Fail-open stderr notice gated on isTTY===undefined. SMALL, wedge-puncture.
- [architecture] chat-gate value-guard short-circuit: `chatGatePrecheck` first line `if(!isPersonalFactRecall(question)) return "pass"` makes all 5 verbatim guards + verifyGrounding unreachable for recall phrased without 1st-person possessive — fabrication=0 chat bypass. MEASURE-FIRST (over-refusal calibration on gemma4).
- [model-routing] request-timeout AbortSignal discarded (model-invocation.ts:146) → timed-out Ollama generation not cancelled, retry stacks a 2nd gen on the saturated GPU. SMALL. measure-first (only bites 120s tail).
- [context-eng] trim budget (128k) vs Ollama num_ctx (32768) independent → 32k–51k prompt passes trimmer then Ollama silently front-truncates system prompt + grounding evidence. SMALL. measure-first.
- [vision] vision structured-extraction→write path has NO deterministic grounding gate (fabrication risk on a write surface). MED.
- [storage] consent / proposed-action drafts / vetoes / belief-provenance use raw fs, never encrypted-file → MUSE_MEMORY_KEY can't protect the most sensitive data. MED, proven per-store pattern.
- [eval-coverage] grounding live batteries default to LEGACY embedder (nomic-embed-text) not shipped v2-moe; eval:self-improving counts SKIP as PASS — the release gate validates the wrong thing / green-washes. TINY. (capability-first 진안 directive로 후순위지만, 다른 grounding 작업 검증의 전제 — capability 슬라이스에 grounding 변경이 끼면 이걸 먼저.)

Cross-cutting themes (workflow synth):
1. Silent-failure-with-zero-signal is the dominant motif (pipe drop, no failure trace, gate short-circuit, front-truncation) → "every silent drop emits a deterministic signal".
2. Grounding gate is asymmetric + self-blinding (implemented twice w/ divergence, no parity test; bypassed by chat regex; batteries test wrong embedder).
3. Single-GPU saturation invisible to Muse (orphan generations, 89s verdict, trim/ctx mismatch).
4. Observability seams built-but-unread (timings written never read, errorMessage dead, hash chain manual-only) — "wire the built seam into doctor/scout".

## Also queued
- lead-worker orchestration depth: ask-decompose sub-task dedup (council dedupes, lead-worker doesn't — MAST duplicated-work), evaluator-optimizer re-synthesis loop missing from reflection-guard registry (packages/multi-agent/src/index.ts:712).
- ask post-answer verification latency: ~50-70s of an 89s ask is per-claim full-evidence re-prefill (commands-ask.ts:2325/2420; knowledge-recall.ts:1610). Truncate per-claim evidence to that claim's top chunk + ensure embed-screen suppresses model calls on short grounded answers. MEASURE-FIRST (re-prove fabrication=0).

## Fires

## fire 1 · 2026-06-16 · skill loop-creator · (this commit)
meta: value-class=wiring(decompose) · pkg=apps/cli+@muse/agent-core · kind=decompose · verdict=N/A(decompose) · firesSinceDrill=1
ratchet: testFiles 1045 · fabrication 0 · eval:multihop hit@4 40% (baseline, unchanged)
- 무엇: top 후보 multi-hop recall wiring을 DECOMPOSE-ON-DEFER로 loop-sized 3슬라이스(1a 전환-baseline / 1b secondHop-gated / 1c e2e-eval)로 분해, backlog ★ 기록. 코드 변경 없음.
- 왜: ORIENT로 ask가 `rankKnowledgeChunks`를 안 쓰고 자체 인라인 recall(commands-ask.ts:1001-1078)임을 확인 → multi-hop = 라이브러리화+second-hop = >1 fire wedge-critical. 등록 세션이 무거워 풀 빌드 부적합, 분해가 정직한 산출(다음 fire 신선 컨텍스트가 1a 빌드).
- 리뷰지점: 1a 전환이 single-hop hit@1 동등(회귀 0)인지 measure-first 먼저; 1b secondHop 트리거는 weak-grounding일 때만(속도).
- 리스크: ask recall은 wedge-critical — 전환 시 hybrid/diversify/MMR/RRF 동작 보존 필수. self-eval green(회귀 0) 유지.
