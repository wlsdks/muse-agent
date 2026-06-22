# capability-parity loop journal

Theme: bring Muse to hermes/openclaw-grade PEER on the 4 pure agent capabilities
they have and Muse is thin/missing on, deterministic-first, while keeping the
grounding/local moat as the floor. Source: code-level inventory of
/Users/jinan/ai/hermes-agent + /Users/jinan/ai/openclaw (studied as DATA only —
public IR mechanisms reimplemented on Muse's own primitives, never copied).
Tier1: LOCAL COMMIT ONLY, never push. Worktree /tmp/muse-capability-parity,
branch loop/capability-parity.

## fire 1 · 2026-06-23 · skill v2.0.0 · 97731bcb2
meta: value-class=new-capability · pkg=@muse/recall · kind=lexical-search-core · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1110→1118 (+8 history-search) · fabrication 0 (no grounding surface touched) · pnpm check green (was RED on a pre-existing byte-hygiene baseline regression, fixed this fire)

- 무엇: `searchHistory(query, records, opts)` in @muse/recall — a deterministic,
  Ollama-free history-search core (Gap1-S1, the biggest gap: both competitors
  have an agent-callable "find where we talked about X"; Muse's episodic recall
  was internal-only). BM25 over CJK-aware content tokens (Muse's own
  `bm25Scores`/`lexicalTokens` from @muse/agent-core — hermes FTS5 / openclaw
  BM25 studied as DATA, Cormack RRF SIGIR 2009), snippet centered on the match,
  precision floor (no token overlap → zero hits), recency tiebreak, topK cap.
  8 vitest cases. The tool wrapper (S2) + hybrid cosine fusion (S3) are later.
- 왜: Gap1 is the largest pure-agent-capability gap vs hermes/openclaw and the
  cleanest high-value slice — a fresh pure module, no shared-loop blast radius,
  fully provable deterministically (OUTCOME = the search returns the right
  ranked hits / empty on no-overlap / Korean query matches Korean records),
  reusing proven CJK-safe primitives instead of reinventing FTS.
- 리뷰지점: searchHistory is a RETRIEVAL helper — it ranks lexical matches and
  asserts nothing is true, so the fabrication=0 / grounding floor is untouched
  (a hit's snippet is a quote of stored text, not a claim). When S2 exposes this
  as an agent tool, the grounding gate still adjudicates any answer built on it.
- 리스크: lexical-only this fire (no embeddings) → a paraphrase with no shared
  content term won't match; that is the intended S3 hybrid-fusion follow-up, not
  a defect. The pre-existing byte-fix (NUL→\x00) is runtime-identical and the
  knowledge-recall-ranking suite (24/24) proves no behavior change.

note: the shared backlog's "★ capability-parity" section existed only as
UNCOMMITTED working-tree edits in the main repo (gap-scout never committed it);
my worktree branched from the committed HEAD legitimately lacked it. Per
concurrent-loop hygiene I did not entangle with that uncommitted work — the
write-back ✓ line went to the top of my worktree's backlog (append-only, low
conflict risk) and the full detail lives here.

## fire 2 · 2026-06-23 · skill v2.0.0 · 3d94f370d
meta: value-class=new-capability · pkg=@muse/recall (+@muse/autoconfigure wiring) · kind=tool-exposure · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1111→1113 (+2: history-search-tool unit + history-search wiring) · toolCases 342→349 (+7 eval:tools golden) · fabrication 0 (retrieval tool quotes stored text, no-overlap → explicit no-match) · pnpm check exit 0 · lint exit 0 · eval:tools history-search 7/7 STABLE 3/3 live (gemma4:12b)

- 무엇: `createHistorySearchTool` in @muse/recall — wraps fire-1's deterministic
  `searchHistory` core as the agent-callable `history_search` tool (verb_noun,
  read-risk, required `query` + optional `topK` with KO+EN example-bearing
  descriptions, a "use when / do NOT use" line disambiguating it from
  knowledge_search and the recent-activity feed). Wired into the production
  runtime tool registry (buildRuntimeToolRegistry), default-ON
  (MUSE_HISTORY_SEARCH_ENABLED) because it is pure/CJK-lexical — no Ollama cost
  unlike the embedding knowledge_search — feeding the user's episodes via
  readEpisodes, fail-soft to a no-match notice. The competitor-parity move: both
  hermes (session_search_tool FTS5) and openclaw (memory-search) have an
  agent-callable "find where we talked about X"; Muse's episodic recall was
  internal-only until now.
- 왜: highest-value continuation of the largest gap (Gap1) into something the
  AGENT actually uses, and diversity-correct (fire 1 = lexical-search-core in
  @muse/recall; fire 2 = tool-exposure + cross-package wiring). The runner-up
  Gap3-S1 was found STALE — episodic-recall.ts already calls
  approximateActivationBoost when recallStats is present; there is no
  useActrRanking flag, so it would have been a declaration-only no-op (the exact
  trap the ④b judge guards against).
- 리뷰지점: history_search is a RETRIEVAL tool — a hit is a quote of stored
  episode text labelled [source:ref], and a zero-token-overlap query returns an
  explicit "Nothing was found — do not invent a past discussion" rather than a
  fabricated memory. So the fabrication=0 / grounding floor is untouched; the
  grounding gate still adjudicates any answer the agent builds on a hit. OUTCOME
  was proven (not declaration): the wiring test goes through createMuseRuntimeAssembly,
  asserts the tool is in toolRegistry.list() AND executes it to return the right
  labelled hit / excludes the non-match; the eval proves the local 12B SELECTS it.
- 리스크: production records feed only `episodes` this fire (not notes/memory) —
  matches Gap1-S2's episodic scope; the hybrid cosine-fusion + broader sources
  are the explicit S3 follow-up, not a defect. New internal deps (recall→tools,
  autoconfigure→recall) are acyclic and verified by pnpm check exit 0.

note: sibling-audit found a pre-existing eval-tool-selection.mjs bug —
buildWebSearchScenario + buildUnitConvertScenario import the web/url servers as
`mcp.createSearchMcpServer` / `mcp.createWebReadMcpServer`, which live in
@muse/domain-tools and are NOT re-exported by @muse/mcp → both undefined → both
scenarios silently SKIP. Fire 2's new scenario imports correctly from
domain-tools; the two older ones are logged as a backlog ◦ to patch.

## fire 3 · 2026-06-23 · skill v2.0.0 · 189040717
meta: value-class=capability-durability · pkg=@muse/multi-agent · kind=store · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1113→1114 · fabrication 0 · eval:orchestration PASS (no regression)

- 무엇: Gap4-S1 — `SubAgentRunRegistry` (@muse/multi-agent), a deterministic
  in-memory store tracking the LIVE lifecycle of spawned sub-agent runs: run id,
  parent→child linkage, status (running/completed/failed/timed-out), per-run
  timeoutMs, heartbeat liveness, and stall detection (detectStalled pure read +
  markStalledAsTimedOut observable transition). 21 OUTCOME-state vitest.
- 왜: openclaw `subagent-registry.ts` has a persistent run registry with
  orphan/stall recovery; Muse's lead-worker/council was in-memory with NO run
  registry, so a stalled or orphaned child run was invisible. Muse's existing
  OrchestrationHistory only records FINISHED runs for audit (mandatory
  finishedAt, no running/timed-out status, no parent-child, no heartbeat) — it
  cannot detect a live stall. This registry is the missing live-lifecycle layer
  Gap4-S2 (orphan recovery policy) builds on. Diversity: fires 1+2 were BOTH
  @muse/recall; this moves to a NEW (pkg=@muse/multi-agent, kind=store).
- 리뷰지점: pure deterministic store — no model call, no network, no fabricated
  content, injected clock for all time reads; fabrication=0 / grounding floor
  untouched. OUTCOME-graded not declaration: tests assert real state transitions,
  stall-detection results at the exact boundary, frozen-record immutability, and
  orphan-by-construction rejection (unknown parent throws). MUTATION-FIRST: stall
  `>`→`>=` boundary and heartbeat-revives-terminal both confirmed RED then GREEN.
  Clean reimplementation (9 plain fields vs openclaw's ~40-field framework
  record); openclaw already attributed in THIRD_PARTY_NOTICES.md.
- 리스크: the registry is built + exported but not yet WIRED into the live
  orchestrator (MultiAgentOrchestrator still uses in-memory state) — this fire
  ships the durable store + its policy primitives (detectStalled/recovery hook);
  wiring it into the orchestrator run loop and the orphan-recovery policy are the
  explicit Gap4-S2/S4 follow-ups, not a defect. No new internal deps (the store
  is dependency-free); index.ts edit is additive re-exports only.

## fire 5 · 2026-06-23 · skill v2.0.0 · 3ac6c4a57
meta: value-class=wiring · pkg=@muse/multi-agent · kind=wiring · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +2 (orchestrate-run-registry.test.ts @muse/multi-agent, server.multi-agent-runs.test.ts @muse/api) · fabrication 0 · eval:orchestration PASS pass^3 (gemma4)
- 무엇: SubAgentRunRegistry(fire 3에서 만들었으나 inert였던 store)를 라이브 MultiAgentOrchestrator에 배선 — 실제 run이 parent + 각 child worker run을 register하고 running→completed/failed/timed-out로 전이; deadline 초과 worker는 detectable한 timed-out 레코드(새 markTimedOut). apps/api 양 orchestrate 라우트(JSON+SSE 공유 prepareOrchestration)에도 배선 + 라이브 GET /api/multi-agent/runs 표면 신설.
- 왜: built-but-unwired store = 이 루프가 막으려는 "looks done but isn't live" 트랩. fire 3가 명시적으로 flag한 inert-store 리스크를 닫음. 부작용 전용(오케스트레이션 result 불변, no-registry run은 backward-compatible).
- 리뷰지점: grounding/citation 경로 미접촉(fabrication=0 유지). OUTCOME-graded — 테스트는 레지스트리 결과 STATE(parent/child status, parent→child 관계, activeCount, timed-out 탐지)를 검증, 호출-여부 아님. MUTATION-FIRST ×2 RED 확인(내 mutation: child complete 제거; ④b 독립 mutation: parent complete 제거 → 둘 다 RED→GREEN). 독립 Opus ④b PASS(7개 점검 항목 전부 concrete 증거). pnpm check exit 0(api 960 + cli 2996 pass), lint clean.
- 리스크: deadline→timed-out 매핑이 에러 메시지 regex(/exceeded the .* deadline/u)에 의존 — withDeadline의 메시지 포맷에 결합. ④b가 오분류 없음 확인했으나 그 메시지 문자열을 바꾸면 매핑이 조용히 깨짐(향후 sentinel 에러 타입이 더 견고). 동일 worker id가 한 run에 중복 시 child 레코드 공유(throw 아님, benign).

## fire 6 · 2026-06-23 · skill v2.0.0 · fb59bd602
meta: value-class=capability · pkg=@muse/recall · kind=core-algorithm · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +0 (9 tests added to existing history-search.test.ts) · fabrication 0 · deterministic gate (pnpm check exit 0; Gap1 slice = no new agent tool, so eval:tools N/A)
- 무엇: `searchHistoryHybrid` in @muse/recall — fire 1의 pure-lexical `searchHistory` 옆에 하이브리드. queryVector + record embedding이 있으면 BM25 lexical 랭크와 cosine semantic 랭크를 fuseByReciprocalRank(Cormack SIGIR 2009)로 fusion → 유저가 질문과 다르게 표현한 과거 기록(파라프레이즈)도 surfacing. embedding 없으면 byte-identical lexical fallback.
- 왜: openclaw의 hybrid BM25+vector recall 대비 Gap1의 마지막 격차. lexical-only는 동의어/패러프레이즈를 놓침; RRF fusion이 그걸 메우면서 결정론·근거 floor 유지.
- 리뷰지점: OUTCOME-graded — 헤드라인 테스트는 lexical이 0 hit인 기록을 hybrid가 surfacing함을 검증(declaration 아님). MUTATION-FIRST: fuseByReciprocalRank([lex, cos])→[lex]로 1줄 깨면 3개(src+dist=6) RED 확인→restore GREEN(470/470). 독립 Opus ④b가 mutation 직접 재현 + 6개 점검 전부 PASS. grounding floor: lexical 점수 0 AND cosine<minCosine면 어느 랭크리스트에도 안 들어가 fused에 없음(fabrication 0). pivot 정당성=Gap2(skill curator)는 이미 fully built+wired(recordUsage/curate/consolidate + 라이브 callers), Gap3-S1 stale, Gap3-S2 fragile live-eval gate — ④b가 honest pivot으로 확인.
- 리스크: 코어 함수는 출하·export됐으나 agent-callable `history_search` tool(fire 2)에는 아직 미배선 — 그 surface는 의도적으로 embedder-free(no Ollama cost). 하이브리드를 tool에 켜려면 optional embedder 주입이 필요(S3b 후속). 이번 fire는 순수 코어+테스트만(diversity: recall 3번째 fire이나 대안들이 pre-check로 실격).

## fire 7 · 2026-06-23 · skill v2.0.0 · 2a3dd61b0
meta: value-class=safety · pkg=@muse/multi-agent · kind=schema-validation · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0 (7 cases added to existing handoff-validation.test.ts) · fabrication 0 · eval:orchestration STABLE 3/3 (gemma4) · consecutivePASS≈6 (fires 1,2,3,5,6,7) — JUDGE-DRILL 임계(8 연속 or firesSinceDrill≥10) 근접, 다음 fire가 8번째 연속 PASS면 DRILL 강제
- 무엇: `parseHandoffPart` — worker→synthesizer fan-in seam의 typed-schema 검증기(zod-comparable 결정론 파서, 신규 dep 없음). buildOrchestrationResponse의 completedParts를 이 게이트로 필터링해, neutralize 후 placeholder로 붕괴한 poisoned 워커 파트(content-free yet non-blank)를 fail-close 드롭 → synthesizer/detectConflicts/detectRedundancies가 빈 껍데기를 진짜 답인 양 소비 못 함. INJECTION_SPAN_PLACEHOLDER를 agent-core에서 export(공유 계약).
- 왜: fire 5(worker boundary 배선)·fire 3(run registry)에 이어 Gap4의 마지막 genuinely-open 슬라이스. 기존엔 non-empty만 검증 — fan-in은 RAW가 아닌 NEUTRALIZED 출력으로 파트를 만들어서, 전체가 injection span인 워커가 worker boundary는 통과하고 fan-in에서 placeholder로 붕괴해 합성에 흘러듦(MAST FM information-withholding이 두 번째 경계에서 캐스케이드). zod 명시됐으나 repo 전체가 zod 미사용 → "or comparable" 결정론 파서로 패턴 일치.
- 리뷰지점: OUTCOME-graded — 헤드라인 테스트 2개가 실제 MultiAgentOrchestrator를 end-to-end 구동해 (1) synthesizer가 substantive 워커만 받음(드롭된 워커는 여전히 completed step + raw.workers에 보고), (2) 전부 content-free면 synthesis skip. MUTATION-FIRST: 필터를 `=> true`(no-op)로 1줄 깨면 두 OUTCOME 테스트 RED 확인→restore GREEN(284/284). 독립 Opus ④b가 mutation 직접 재현 + 7개 점검(behavioral·mutation·invariant·unrelated-state·dep-cycle·no-copy·gates) 전부 PASS. over-rejection 회피 확인: placeholder가 substantive 내용과 함께면 ACCEPT(SOLELY placeholder일 때만 reject) → 진짜 답 손실 없음(fabrication/grounding floor 불변).
- 리스크: placeholder-rejection이 정확한 문자열 동등(trim 후)에 결합 — agent-core가 INJECTION_SPAN_PLACEHOLDER 문자열을 바꾸면 그 특정 reject 분기가 조용히 무력화(구조적 reject들은 영향 없음; 이제 공유 export라 결합이 명시적). 게이트는 FUSION 입력만 영향 — 감사 추적(per-worker concat·status·history·registry) 전부 불변이라 blast radius 좁음. diversity: @muse/multi-agent 3번째 fire이나 kind는 schema-validation으로 새로움(이전 fires: store·wiring).

## fire 8 · 2026-06-23 · skill v2.0.0 · 0f154e109
meta: value-class=durability · pkg=@muse/multi-agent · kind=policy · verdict=PASS · firesSinceDrill=8
ratchet: testFiles +0 (5 cases added to existing subagent-run-registry.test.ts) · fabrication 0 · eval:orchestration PASS (in-process deterministic, run under MUSE_EVAL_REPEAT=3) · consecutivePASS=7 (fires 1,2,3,5,6,7,8) — fire 4 crashed, NOT counted as PASS so it does NOT extend the streak; firesSinceDrill 7→8, below the DRILL threshold (8 consecutive PASS OR firesSinceDrill≥10) → NORMAL slice this fire, DRILL forced NEXT fire if it would be the 8th consecutive PASS
- 무엇: SubAgentRunRegistry에 결정론 orphan-recovery 정책 2개 추가. orphan = parent가 terminal(completed/failed/timed-out)인데 child가 아직 running — parent가 그 결과를 영영 소비 안 함. `detectOrphaned()`가 이를 flag(이미-terminal parent에 등록된 child 포함), root run·이미-terminal child는 무시. `recoverOrphaned(error?)`가 orphan을 `failed`로 전이(finishedAt/error 기록), heartbeat-stall의 `timed-out`과 의미적으로 구분, 무관한 running 상태는 불변.
- 왜: openclaw subagent-registry의 orphan-recovery 메커니즘 재구현(MIT, 코드 미복사). fire 3(registry)·5(라이브 배선)·7(fan-in 스키마)에 이은 Gap4 S2b — heartbeat-stall(detectStalled)은 이미 있었으나 parent-종료-고아 클래스는 미커버였음. diversity: @muse/multi-agent 4번째 fire이나 kind=policy로 새로움(이전: store·wiring·schema-validation 각각 다름).
- 리뷰지점: OUTCOME-graded — 5개 테스트가 라이브 데이터구조 STATE 전이를 검증(register→parent terminate→detect/recover→status=failed·finishedAt·error·activeCount 감소·무관 run 불변), declaration 아님. MUTATION-FIRST: `&& TERMINAL_STATUSES.has(parent.status)`를 제거하면 2개 테스트 RED 확인→restore GREEN(289/289). 독립 Opus ④b가 그 mutation을 직접 재현 + 7개 점검 전부 concrete 증거로 PASS. 오케스트레이터 배선은 의도적 미추가 — parent-failure catch는 orphan에 unreachable(runSequential/runParallel이 worker 에러를 삼켜 children이 parent settle 전에 항상 terminal), 그래서 inert no-op이 될 것; ④b가 코드(orchestrator.ts ~230/365-430) 추적해 revert가 옳다고 독립 확인. 정책은 향후 scheduled sweep을 위한 tested defensive primitive로 출하.
- 리스크: orphan→`failed` 매핑은 의미적 선택(parent-abandonment ≠ stall) — 미래에 별도 `orphaned` status를 원하면 enum 확장 필요. 정책은 현재 어떤 라이브 경로에서도 자동 호출 안 됨(외부 supervisor / Gap3-S3 scheduled arm가 호출해야 동작) — 의도된 분리지만 "built-but-uncalled" 라벨에 유의(테스트로 동작은 증명, 라이브 트리거는 후속). vein-status: capability-parity는 사실상 dry — Gap1/2/4 완료, Gap3는 stale(S1)·fragile-live-eval(S2)·large-blast-radius scheduling(S3) 만 남음.

## fire 9 · 2026-06-23 · skill v2.0.0 · e49e9e99c
meta: value-class=honesty-fix · pkg=@muse/recall(+autoconfigure) · kind=honesty-fix/wiring · verdict=PASS · firesSinceDrill=9 · consecutivePASS=8 (fires 1,2,3,5,6,7,8,9) — ★8 연속 PASS 도달 → 다음 fire(10)는 JUDGE-DRILL 강제(8-consecutive 임계 충족; firesSinceDrill도 9→10 근접)
ratchet: testFiles +1 (history-records-provider.test.ts @muse/autoconfigure) · fabrication 0 · eval:tools 124/124 100% PASSED (gemma4, history_search 7케이스 전부 PASS) · pnpm check exit 0 · lint clean
- 무엇: 독립 적대감사 A1(MAJOR honesty/floor) 수정. `history_search` 도구가 "episodes·notes·remembered facts" 검색을 광고하나 라이브 records provider는 episodes만 읽어 "노트/팩트 못 찾음"을 검색도 없이 사용자에게 말함(claimed-but-unsearched = fabrication=0 위반). FIX: `buildHistoryRecords`(autoconfigure 신규 모듈) — episodes + notes(list+read body) + user-memory facts/preferences를 각자 올바른 source 라벨로 병합, per-source fail-soft. runtime-tool-registry.ts의 history_search records provider에 배선.
- 왜: 권장(fuller-wiring) 경로 선택 — 리더가 깨끗이 존재(notesRegistry.primary()·userMemoryStore가 이미 registry deps; knowledge_search가 동일 리더 사용 패턴 입증)하고 1 fire에 맞음. 좁히기(fallback) 대신 광고된 능력을 실제 전달. 도구 설명/doc/NO_MATCH는 이미 3소스를 정확히 광고 → 이제 현실이 일치(sibling-audit: 셋 다 consistent, 수정 불요).
- 리뷰지점: OUTCOME-graded — 6 테스트가 createHistorySearchTool을 e2e 구동해 실 NOTE가 [notes:note-1], 실 FACT가 [memory:fact:allergy] 라벨로 반환됨을 검증(pure-function 아님), + per-source fail-soft(throwing notes → episodes+memory 여전히 반환) + notes/memory 미설정 → episodes-only 보존. MUTATION-FIRST: resolveNoteRecords를 []로 1줄 깨면 2 테스트 RED 확인→restore GREEN. 독립 Opus ④b가 mutation 직접 재현 + 6개 점검(advertised==searched·really-returned·mutation-RED·fabrication=0·unrelated-untouched·builds) 전부 concrete 증거 PASS.
- 리스크: 노트 본문을 list()+read()로 per-note 읽어 인덱싱 비용이 노트 수에 비례(maxNoteChars=4000으로 본문 절단; episodic embedding처럼 결정론·로컬, no Ollama). 큰 노트 코퍼스는 per-query read 비용 — 현재 결정론 lexical floor 우선이라 수용, 후속 캐싱/하이브리드(A2)가 최적화 여지. source 라벨은 레코드 실 source에서 파생(하드코딩 아님)이라 오라벨 불가.
