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

## fire 2 · 2026-06-16 · skill loop-creator · (this commit)
meta: value-class=wiring(measure-first redesign) · pkg=apps/cli · kind=measure · verdict=N/A(measure) · firesSinceDrill=2
ratchet: testFiles 1045 · fabrication 0 · eval:multihop hit@4 40% (baseline, unchanged)
- 무엇: slice 1a(ask 인라인→rankKnowledgeChunks 전환)를 measure-first(Sonnet 독립 분석)로 검증 → 4 divergence 발견(graph-expansion 손실/re-embed 느림/preGapScored 손실/per-clause RRF 손실). 1a 폐기, "ask 인라인에 직접 second-hop AUGMENT"(1b′)로 재설계, backlog 갱신. 코드 변경 없음.
- 왜: ask 인라인 recall이 rankKnowledgeChunks보다 풍부(graph/cache/preGap/per-clause) → 순진한 전환은 4기능 회귀. measure-first가 빌드 전 차단(notes-prefix ROI 0와 같은 패턴 — 측정이 헛다리를 막은 2번째 사례).
- 리뷰지점: 1b′=인라인 cosine 재사용 second-hop, graph-expansion과 공존, AUGMENT-never-displace, weak일 때만. 다음 fire(신선)가 1b′ 빌드.
- 리스크: ask recall wedge-critical — second-hop도 single-hop 보존(append-only). 세션 cron 컨텍스트 누적 中 → 빌드 fire는 신선 세션 권장.

## fire 3 · 2026-06-16 · skill loop-creator · (this commit)
meta: value-class=new-capability/wiring · pkg=@muse/recall+apps/cli · kind=capability · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1045 · fabrication 0 · eval:multihop hit@4 40%→80% (AUGMENT arm)
- 무엇: ask 인라인 recall에 second-hop AUGMENT(`secondHopAugmentChunks` @muse/recall chunks.ts +5 tests; commands-ask.ts wiring, MUSE_RECALL_SECOND_HOP gated; verify-multihop.mjs AUGMENT arm). 첫 실제 capability 빌드(fire 1·2는 decompose/measure). worker(Opus)+judge(별개 Opus) maker≠judge.
- 왜: two-hop 질문이 single-hop으로 bridged note 못 닿음(measure ROI+); 1a 전환 폐기(4 divergence) 후 1b′ 직접 추가로 회피. eval:multihop 40→80% 검증.
- 리뷰지점: single-hop 회귀 0(hit@1 1/5 동일, mutation test로 never-displace 증명). default-off staging → 1c에서 promotion + same-base A/B control(judge flag). org.md 1/5 여전 miss.
- 리스크: default-off라 프로덕션 미활성(1c promotion 후속); eval 두 arm 다른 base ranker(builder 정직 공개). 세션-cron 컨텍스트 누적 → 빌드를 worker 격리로 우회(이번 fire 검증).

## fire 4 · 2026-06-16 · skill loop-creator · (this commit)
meta: value-class=wiring(promotion+eval) · pkg=@muse/recall+apps/cli · kind=capability-promotion · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1045 · fabrication 0 · eval:multihop 3-arm inline-no-hop 60%→inline+hop 80%(same-base)
- 무엇: second-hop을 confidence-gated default-ON promotion(`shouldSecondHop`: confident면 skip); verify-multihop 3-arm same-base A/B(control/+hop/engine); eval:multihop을 eval:agent CI 번들 추가(fail-close). measure-first가 ungated single-hop 노이즈(15/15 append) 발견→gated 결정. 일회성 measure 스크립트는 drop(verify-multihop 3-arm이 영구 가드).
- 왜: 1b′ default-off는 dead feature(judge flag); default-on이 가치지만 ungated는 single-hop 오염→confidence-gate. latency negligible(0.05ms).
- 리뷰지점: worker+별개 Opus judge PASS. 정답 top-1 15/15 유지; hop 경로 verdict weak-cap(grounded 불가)→fabrication 0; 13/15 ambiguous append는 4 containment로 무해. structural 안전(confidence cap), gate 자체는 약함(2/15 protect).
- 리스크: 미래에 hop이 grounded verdict 도달하면 unsafe(현재 구조적 차단). org.md 1/5 여전 miss. 연속 allPASS=2(fire 3·4), firesSinceDrill=4 — JUDGE-DRILL 카운터 <임계.

## fire 5 · 2026-06-16 · skill loop-creator · (rollback — no code commit)
meta: value-class=new-capability(ROLLED BACK) · pkg=apps/cli vision · kind=capability · verdict=FAIL(judge)→rollback · firesSinceDrill=5
ratchet: testFiles 1045 · fabrication 0 · (no change — git restore)
- 무엇: vision 추출→action에 deterministic grounding gate(`groundVisionFields` + 독립 describeImage evidence) 시도. measure-first가 갭 REAL 확인(system-prompt instruction뿐). worker 빌드(eval:vision 5 pass)했으나 별개 Opus judge FAIL → git restore 롤백. backlog ◦에 재시도 스펙.
- 왜(FAIL): ① number match `every`가 worded-month date(2026-06-07 vs "June 7")·country-code phone을 false-drop(라이브 재현, legitimate 액션 파괴); ② empty-evidence fail-open이 text 선례(fail-close)와 inverted → describeImage 실패 시 hallucination 통과(floor 약화).
- 리뷰지점: maker≠judge 게이트가 결함 슬라이스를 커밋 전 차단(정상 fail-close 작동 — 이 루프의 핵심 안전장치 실증). 방향은 옳음(vision fabrication 갭 real), 보수성·fail-open framing이 문제.
- 리스크: 연속 allPASS 리셋(2→0). 다음 fire = vision gate 재시도(수정 3개) 또는 다른 capability. value-class 다양성은 유지(첫 non-recall 시도).
