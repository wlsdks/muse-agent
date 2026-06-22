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
