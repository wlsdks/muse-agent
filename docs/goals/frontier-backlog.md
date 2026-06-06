# Frontier backlog — 6대 프론티어 (2026 연구 → Muse 적용)

> 출처: 2026-06-06 진안 지시 — 6대 영역을 **2026 최신 공개 연구(유명/비유명 불문)로
> 실제 적용 + 진짜 효과 검증 후** 발전시킨다. 매 루프 fire가 여기서 **한 항목씩** 골라
> 실제 적용 + 로컬 실측(before/after) 검증하고 커밋한다. 이 백로그는
> muse-frontier-research 워크플로(6테마×웹조사 24후보 → 적대적 검증 → 종합)의 산출물.
> 메모리: [[project_frontier_six_directive]].

## 불변 규율 (모든 항목이 지킨다)

- 로컬 **qwen3:8b · MUSE_LOCAL_ONLY** 유지. 클라우드/대형모델 의존 항목은 **거부**(드롭됨).
- 결정적 **grounding 플로어가 최우선** — 어떤 항목도 verifyGrounding을 약화/우회하지 않는다.
  fabrication-rate=0 릴리스 게이트가 바닥. 모든 항목은 (a) grounding 게이트를 강화하거나
  (b) 게이트에 들어가는 신호 품질을 높이거나 (c) 올바른 도구가 올바른 인자로 실행되게 한다.
- **검증=로컬 실측** 없으면 미배달. 한 커밋 사이즈 슬라이스. 보안=코드(프롬프트 아님).

## 횡단 정직 결론 (리서처 6명 + 적대적 검증 합의)

- **세션:** Muse는 명시적 "세션" 개념이 **필요 없다.** 2025-2026 합의는 하드 리셋이 아니라
  *연속 user-level 메모리 + 롤링 단기 컨텍스트(tiering)*. → #2/#5/#6이 그 방향.
- **멀티에이전트가 로컬 8B에서 해로운 곳:** ① 순차 도구체인(컨텍스트 리셋 오버헤드로 8B가
  앞 결과를 잃음) ② 단일에이전트가 이미 잘하는 단순 회상(패널은 지연·토큰만 2배) ③ 공유-쓰기
  (병렬 워커가 캘린더/메모리를 각자 갱신→불일치). **쓰기는 단일 코디네이터로 직렬화, 팬아웃은
  읽기/평가만.**
- **로컬 8B에서 값하는 서브에이전트 = 추론 팬아웃이 아니라 "모델이 보는 것을 줄이는" 격리.**
  maker≠checker 검증(짧고 바운드된 PASS/FAIL)은 값하지만, 각 분기가 풀 추론을 도는 패턴
  (멀티홉 리서치 팬아웃·반복 정련)은 더 느리고 더 약하다(qwen3:8b는 2-3스텝 후 일관성 저하).
- **도구호출 지배적 실패 = 잘못된 인자값**(잘못된 선택 아님). #1(인자 예시)·#3(문법제약 디코딩)·
  #11(스키마 컴파일)이 이 축. (실증: startsAt 리네임 0/8→8/8 = [[project_tool_time_field_naming]].)

## 우선순위 백로그 (rank 1 = 먼저)

### #1 — Inject concrete argument examples into MuseToolDefinition.description at serialization time
- **테마:** ONE-SHOT TOOL-CALLING RELIABILITY  ·  **노력:** S  ·  **임팩트:** high
- **왜:** The dominant failure mode on local 8B is wrong/missing argument values, not wrong tool selection — confirmed by the tool_time_field_naming memory note (startsAt: 0/8 → 8/8 from a single rename). Adding one concrete call example per high-failure tool (calendar startsAt/title, reminder dueAt, task priority) into the description string passed via ModelTool costs ~20 tokens per tool and gives the local model a template to copy rather than infer from abstract JSON. Zero latency overhead. Directly tightens the grounding edge: a tool never called with wrong args = a tool that can't corrupt grounded state (calendar/reminder writes).
- **Muse seam:** packages/tools/src/index.ts — MuseToolDefinition interface (add optional `examples?: readonly JsonObject[]`); the `toModelTool` serializer that builds ModelTool.description; individual tool files in packages/mcp/src/tools/ (calendar.ts, reminders.ts, tasks.ts) where examples are declared
- **첫 슬라이스:** Add `examples?: readonly JsonObject[]` to `MuseToolDefinition` in packages/tools/src/index.ts. Patch `toModelTool` to append `Example: ${JSON.stringify(examples[0])}` to the description when present. Populate for calendar (startsAt + title + durationMinutes), reminders (dueAt + title), and tasks (title + priority). Run `pnpm eval:tools` before and after with `MUSE_EVAL_REPEAT=3` to record argMatches/argsPresent delta.
- **검증:** `pnpm eval:tools` — argsPresent and argMatches scorers for calendar, reminder, and task cases must show a measurable improvement (target: ≥90% argsPresent). `pnpm --filter @muse/tools test` must stay green to confirm description serialization is not broken.

### #2 — Preserve citation source-IDs through compaction: inject a 'Grounding continuity' block when trimConversationMessages drops cited messages
- **테마:** SESSION / CONTEXT MANAGEMENT — grounding edge hardening  ·  **노력:** S  ·  **임팩트:** high
- **왜:** The grounding edge is Muse's non-negotiable invariant. trimConversationMessages already fires when workingBudgetTokens is exceeded (the seam is live and tested). Today it silently drops messages that contain [from notes/foo.md] citations, causing verifyGrounding to fail on follow-up queries referencing those sources. This is a direct fabrication surface: the model can repeat a previously-grounded claim whose evidence is now gone. The fix is deterministic code in trimConversationMessages — no LLM call — and requires no new infrastructure beyond the already-present citedSourcesIn function and COMPACTION_SUMMARY_PREFIX constant.
- **Muse seam:** packages/memory/src/memory-token-trim.ts — trimConversationMessages, where dropped messages are identified. packages/agent-core/src/knowledge-recall.ts — citedSourcesIn (already exported, parses [from X] citations). packages/memory/src/index.ts — COMPACTION_SUMMARY_PREFIX constant for the injected block.
- **첫 슬라이스:** In `trimConversationMessages`, after identifying messages to drop (before returning the result), call `citedSourcesIn` on each dropped message's content. Collect the union of unique source strings. If non-empty, prepend a pinned system message `[Grounding continuity] Sources cited in compacted turns: ${sources.join(', ')}` to the returned messages array. Gate the whole path with a `preserveCitationSources?: boolean` option (default true) in ConversationTrimOptions so it can be disabled in tests.
- **검증:** `pnpm --filter @muse/memory test -t 'compaction citation'` — a new test: build a 60-turn history with 5 [from notes/foo.md] citations in turns 1-20, trigger compaction (workingBudgetTokens exceeded), assert the returned messages array contains a system message listing notes/foo.md. Then `pnpm --filter @muse/agent-core test -t 'grounding post-compaction'` — run verifyGrounding on a follow-up query referencing that source and assert verdict is not 'ungrounded'.

### #3 — Grammar-constrained decoding via Ollama's format parameter for single-tool-call turns
- **테마:** ONE-SHOT TOOL-CALLING RELIABILITY  ·  **노력:** M  ·  **임팩트:** high
- **왜:** Ollama's /api/chat already accepts a `format` JSON Schema field. buildNativeChatBody assembles the native body but never passes `format`. When exactly one tool is expected, deriving the grammar from ModelTool.inputSchema and passing it as `format` eliminates structurally malformed argument JSON at the decode layer — the model physically cannot emit invalid shapes. This closes the argument-shape failure mode independently of the example-injection technique (rank 1 addresses value correctness; this addresses structural correctness). They compose.
- **Muse seam:** packages/model/src/adapter-ollama.ts — buildNativeChatBody (private method, line 316). ModelRequest already has a `responseFormat` field. The tool's `inputSchema: JsonObject` (from ModelTool) is the grammar source. The change is confined to a single private method.
- **첫 슬라이스:** In `buildNativeChatBody`: when `request.tools` has exactly one entry and `request.responseFormat` is not already set, add `format: request.tools[0].inputSchema` to the returned body. Guard with a check that the schema is a non-null object. No change to agent-core or any other layer — purely adapter-level. Run `pnpm --filter @muse/model test` then `pnpm eval:tools` with `MUSE_EVAL_REPEAT=3` to record ArgumentCorrectness before/after.
- **검증:** `pnpm eval:tools` — ArgumentCorrectness (argsPresent + argMatches combined) on structured-arg cases must rise. `pnpm --filter @muse/model test` must stay green. A negative case: multi-tool prompts must not receive a format field (assert in a unit test that buildNativeChatBody with 2 tools does not include `format`).

### #4 — Ensure GroundingReverify checker always receives a fresh message array (true context-reset maker-checker)
- **테마:** SELF-IMPROVING / MEMORY — sub-agent verification  ·  **노력:** S  ·  **임팩트:** high
- **왜:** GroundingReverify is architecturally correct — it receives only {query, answer, evidence} — but callers in verifyGroundingWithReverify, verifyReflectionsGrounding, and verifyCouncilGrounding construct the reverify ModelRequest by calling `buildGroundingReverifyPrompt` whose output feeds into a generate call that may share ambient model state via the same provider instance. Adding a structural assertion that the messages array passed to the reverify generate call has exactly [{role:'system',...}, {role:'user',...}] (no prior turns) makes the maker-checker property verifiable by test rather than by convention. This prevents context contamination as the codebase evolves.
- **Muse seam:** packages/agent-core/src/knowledge-recall.ts — verifyGroundingWithReverify and the GroundingReverify type (the `judge` function receives only GroundingReverifyInput). The builder `buildGroundingReverifyPrompt` constructs the messages. apps/cli/src/commands-ask.ts — the reverify wiring in groundingVerdictNotice.
- **첫 슬라이스:** In `verifyGroundingWithReverify`, extract the messages array built from `buildGroundingReverifyPrompt` and assert (throw in dev, log in prod) that it contains exactly 2 entries (system + user) with no prior conversation turns. Add a unit test in packages/agent-core/ that injects a mock judge which asserts `messages.length === 2` — failing before the fix and passing after. Then run `pnpm eval:agent` (eval:adversarial battery) to confirm must-refuse precision holds.
- **검증:** `pnpm eval:agent` — eval:adversarial must-refuse cases must pass. New unit test `pnpm --filter @muse/agent-core test -t 'reverify context reset'` must pass. No regression on `pnpm eval:self-improving` faithfulnessRate.

### #5 — Chain-of-Memory adaptive truncation: token-budget-capped renderEpisodicSection with contribution threshold
- **테마:** MEMORY COMPACTION — episodic store  ·  **노력:** S  ·  **임팩트:** med
- **왜:** renderEpisodicSection currently concatenates top-K narratives verbatim with a 1500-char soft cap (MAX_EPISODIC_CHARS) but no per-fragment contribution filter — low-signal fragments still occupy context. Replacing the concat loop with a greedy ranked-fragment accumulator (add sentence-split fragments by similarity score until MUSE_EPISODIC_RECALL_TOKEN_BUDGET is hit; drop fragments below a contribution threshold) is a pure code change in one function. No new store, no LLM call, no new dependency. Directly frees context for the model's answer and improves grounding quality by ensuring injected evidence is highest-signal.
- **Muse seam:** packages/agent-core/src/episodic-recall.ts — renderEpisodicSection (lines 40-107); the EpisodicRecallSnapshot.matches array is already sorted by similarity score. A new `tokenBudget?: number` and `contributionThreshold?: number` field on the render options.
- **첫 슬라이스:** Replace the for-loop in `renderEpisodicSection` that iterates `snapshot.matches` with a greedy accumulator: split each match.narrative by sentence (split on '. '), rank by the match.similarity score already on EpisodicMatch, add fragments until `charsUsed > tokenBudget * 4` (4 chars ≈ 1 token), skip fragments whose marginal similarity falls below `contributionThreshold` (default 0.1). Add a unit test: 10 episodes of varying length and similarity → assert output under budget and highest-similarity episode always fully included.
- **검증:** `pnpm --filter @muse/agent-core test -t 'episodic.*budget'` — new unit test passes. Measure `[Episodic Memory]` block character count on a 30-session smoke run before/after (target: ≥30% reduction). `pnpm smoke:broad` confirms no regression on the ask wedge.

### #6 — Salience gate in captureEndOfSessionEpisode: pre-filter turns by entity-density + decision-marker signals before summariseSession
- **테마:** MEMORY — write-path salience gate  ·  **노력:** S  ·  **임팩트:** med
- **왜:** captureEndOfSessionEpisode currently assembles all turns from extractCurrentSessionTurns and passes them verbatim to summariseSession (an LLM call). A 15-turn weather-chat session and a 3-turn task-creation session cost the same summarisation call, and the weather chat produces an episode that dilutes future episodic recall. The existing scoreMessageImportance in packages/memory/src/message-importance.ts already scores messages on decision-language hints — extending it with entity-density (named-entity count) and using the score as a salience filter before the LLM call is a pure deterministic code change with no new dependency. Reduces LLM call cost AND improves recall precision.
- **Muse seam:** apps/cli/src/chat-end-session.ts — captureEndOfSessionEpisode (line 89), where turns are assembled before calling summariseSession. packages/memory/src/message-importance.ts — scoreMessageImportance and DECISION_HINTS (already covers decision-language; extend with entity-density heuristic).
- **첫 슬라이스:** In `captureEndOfSessionEpisode`, after `extractCurrentSessionTurns`, apply a salience filter: score each SessionTurnLine using `scoreMessageContent` (already imported from @muse/memory), map user/assistant turns to ConversationMessage shape for scoring, keep turns with score ≥ 0.35 OR those that are the only turn in the session. Pass only the filtered list to `summariseSession`. Add a test: 30-turn history (20 low-salience + 10 high-salience) → assert `summariseSession` is called with ≤14 turns and all 10 high-salience turns are present.
- **검증:** `pnpm --filter @muse/agent-core test -t 'salience'` — new test passes. `pnpm eval:self-improving` — recall F1 must not regress. Measure: summariseSession token cost on a synthetic 30-turn session drops by ≥30% vs baseline.

### #7 — Add heatScore to StoredEpisode and weight it into EmbeddingEpisodicRecallProvider resolve ranking
- **테마:** MEMORY — heat-scored episodic promotion  ·  **노력:** M  ·  **임팩트:** high
- **왜:** The EmbeddingEpisodicRecallProvider scores purely on cosine similarity + recency. A high-frequency topic the user revisits weekly should outrank a stale topic from last month at equal similarity. MemoryOS proves heat-scoring (access-frequency × recency decay) delivers +49% F1 on retrieval benchmarks — the arithmetic is model-agnostic and deterministic. The seam is well-isolated: StoredEpisode gains one optional field, and the scored.push block in resolve gains one additive term. No new store, no new LLM call.
- **Muse seam:** packages/agent-core/src/episodic-recall.ts — StoredEpisode interface (add `heatScore?: number`); EmbeddingEpisodicRecallProvider.resolve's scoring loop (add `heatBoost` computed from heatScore to the similarity + recencyBoost sum); EmbeddingEpisodicRecallProvider.add (optional heat increment on re-add or recall hit). packages/mcp/src/personal-episodes-store.ts — persisted schema gains heatScore.
- **첫 슬라이스:** Add `heatScore?: number` to `StoredEpisode`. In `EmbeddingEpisodicRecallProvider.resolve`, compute `heatBoost = Math.min(0.1, (episode.heatScore ?? 0) * 0.01)` and add it to the similarity score before threshold check. Write a test: 20 episodes (10 with heatScore=5, 10 with heatScore=0), resolve with a query that matches both groups equally — assert top-K contains ≥8/10 high-heat episodes.
- **검증:** `pnpm --filter @muse/agent-core test -t 'heat'` — new test passes. `pnpm eval:self-improving` must not regress on recall metrics. `pnpm --filter @muse/agent-core test` full suite stays green.

### #8 — Upgrade defaultShouldOrchestrate to 3-way topology routing (trivial → single / recall → sequential / compound → panel)
- **테마:** MULTI-AGENT ORCHESTRATION  ·  **노력:** S  ·  **임팩트:** med
- **왜:** The current binary heuristic (regex + length ≥ 40) fires the full 3-agent council panel on greetings and simple factual lookups. AdaptOrch shows that even a deterministic DAG-topology classifier outperforms binary routing. For local Qwen the wasted aggregation call is material (adds 2-4s of latency on trivial prompts) and the aggregation step is itself a fabrication risk — merging 3 proposals can introduce un-sourced synthesis claims. A 3-way split (trivial single-call / single-retrieval-need sequential / multi-aspect compound) is achievable with deterministic heuristics and directly reduces the surface area for grounding violations.
- **Muse seam:** packages/agent-core/src/orchestrate.ts — defaultShouldOrchestrate (line 77), currently returns boolean. Change return type to `'single' | 'sequential' | 'panel'`. Update callers in apps/cli/src/commands-orchestrate.ts and any other orchestrate caller.
- **첫 슬라이스:** Replace `defaultShouldOrchestrate(question): boolean` with `classifyOrchestrationTopology(question): 'single' | 'sequential' | 'panel'`. Trivial (< 14 chars OR pure greeting pattern) → 'single'. Single-retrieval keywords (what, who, where, when without compound connectors) → 'sequential'. Multi-clause / compound (how/why/explain/compare OR length ≥ 60 with multiple aspect markers) → 'panel'. Update the boolean callers to treat 'panel' as true, 'single'/'sequential' as false for backward compat — making the topology change additive. Add a unit test covering 10 trivial + 10 single + 10 compound cases.
- **검증:** `pnpm --filter @muse/agent-core test -t 'topology'` — new test: 30 cases classified correctly ≥27/30. `pnpm eval:tools` must not regress on tool selection accuracy. `pnpm smoke:broad` green.

### #9 — Add activationCondition + reward to AuthoredSkillStore; prune low-reward skills at consolidation time
- **테마:** SELF-IMPROVING — skill store evolution  ·  **노력:** S  ·  **임팩트:** med
- **왜:** AuthoredSkillStore has similarity-dedup and quarantine but no activation-condition predicate and no outcome tracking. A skill written once and never reinforced persists indefinitely and can be selected by the model for prompts where it is not relevant. The PlaybookStrategy.reward field and the decay math in clampReward are already proven patterns in this codebase. Porting the same pattern to AuthoredSkillStore (add reward field; prune skills whose cumulative reward falls below a threshold during consolidate()) closes the symmetry gap between playbook and skill memory without new infrastructure.
- **Muse seam:** packages/skills/src/authored-skill-store.ts — SkillDraft interface (add `activationCondition?: string`); serializeAuthoredSkill (serialize the field to YAML frontmatter); consolidate() (prune where reward < threshold after N sessions). packages/agent-core/src/playbook.ts — reuse clampReward / PLAYBOOK_REWARD_MIN constants. packages/tools/src/nl-tool-selection.ts — parseNaturalLanguageToolSelection where skill activation is evaluated.
- **첫 슬라이스:** Add `reward?: number` to SkillDraft and serialize it to YAML frontmatter in `serializeAuthoredSkill`. In `consolidate()`, after the dedup pass, filter out any authored skill whose reward is defined and < -2 (analogous to the playbook floor). Add a unit test: inject 3 skills with rewards [-3, 0, 2]; call consolidate(); assert only the -3 skill is pruned.
- **검증:** `pnpm --filter @muse/skills test` — new test passes. `pnpm eval:tools` must not regress on skill-selection cases. `pnpm check` stays green.

### #10 — Add sourceEpisodeId provenance to StoredEpisode and wire a raw-log escalation arm into verifyGroundingWithReverify
- **테마:** MEMORY — provenance-gated escalation  ·  **노력:** M  ·  **임팩트:** high
- **왜:** When verifyGrounding returns 'weak', the system currently either drops the claim or keeps it weakly-grounded — it cannot go back to the source. TierMem proves that adding a provenance pointer (sourceEpisodeId) to the compressed narrative and fetching the raw episode when the summary is insufficient raises 'grounded' verdicts by >10pp. The grounding gate already exists and is fail-close; this adds the escalation arm that converts 'weak' → 'grounded' when the raw text actually supports the claim. Directly strengthens the non-negotiable grounding edge.
- **Muse seam:** packages/agent-core/src/episodic-recall.ts — StoredEpisode (add `rawEpisodeId?: string`); EpisodicMatch (add `rawEpisodeId?: string` to surface it to callers). packages/agent-core/src/knowledge-recall.ts — verifyGroundingWithReverify: when verdict is 'weak' and a rawEpisodeId is available on the matched KnowledgeMatch, re-fetch the raw episode text and retry verifyGrounding with expanded evidence. packages/mcp/src/personal-episodes-store.ts — episode persistence gains the rawEpisodeId field.
- **첫 슬라이스:** Add `rawEpisodeId?: string` to StoredEpisode and EpisodicMatch. In EmbeddingEpisodicRecallProvider, populate it on matched episodes (just re-use sessionId as rawEpisodeId in the in-memory store for the first slice). In verifyGroundingWithReverify, after a 'weak' verdict, check if any match has rawEpisodeId; if so, call the reverify judge a second time with the raw narrative appended to evidence. Add a test: synthetic corpus where the compressed narrative omits a key phrase present in the raw episode → first verify returns 'weak', escalation returns 'grounded'.
- **검증:** `pnpm eval:self-improving` — grounded-verdict rate on the episodic battery must improve (target: +5pp). New unit test `pnpm --filter @muse/agent-core test -t 'provenance escalation'` must pass. `pnpm smoke:broad` green.

### #11 — TSCG-style deterministic schema compiler: strip additionalProperties, flatten $defs, inline $ref before assembling ModelRequest.tools
- **테마:** ONE-SHOT TOOL-CALLING — schema compilation  ·  **노력:** S  ·  **임팩트:** med
- **왜:** Raw JSON Schemas in the tool-list prompt are designed for machine parsing, not LLM attention. TSCG's 8 composable operators (strip additionalProperties, flatten $defs, inline $ref, compact enum lists) provably reduce token cost ≥51% on well-formed schemas and restore argument-selection accuracy on 14B models from 0% to 84%. For Muse's local 8B the benefit is amplified. The operator set is purely structural, deterministic, and stateless — a pure helper function with no new dependency. Composes with rank-1 (examples) and rank-3 (grammar-constrained decoding) without conflict.
- **Muse seam:** A new pure helper `packages/tools/src/schema-compiler.ts` exporting `compileTSCG(schema: JsonObject): JsonObject`. Applied in `toModelTool` (the serializer in packages/tools/src/index.ts that maps MuseTool → ModelTool) just before returning the ModelTool.inputSchema.
- **첫 슬라이스:** Create `packages/tools/src/schema-compiler.ts` with a `compileTSCG` function implementing 4 of the 8 operators (most impactful): strip `additionalProperties`, strip `$schema`/`$id`, flatten top-level `$defs` by inlining any `$ref` they appear in, remove empty `allOf`/`anyOf` wrappers. Apply in `toModelTool`. Add a unit test: take the calendar tool's inputSchema, run compileTSCG, assert (a) no `additionalProperties` key present, (b) token count (chars/4) is lower, (c) all required fields still present.
- **검증:** `pnpm --filter @muse/tools test` — new schema-compiler unit tests pass, required fields preserved. `pnpm eval:tools` — toolScorers.selected and argsPresent must not regress; measure token count of tool-list section before/after (log in eval output, target ≥20% reduction). `pnpm check` green.

### #12 — Speculative parallel embed+rank in the ask wedge: fire rankKnowledgeChunks concurrently with tool-selection inference
- **테마:** SUB-AGENT / ORCHESTRATION — speculative parallelism  ·  **노력:** S  ·  **임팩트:** med
- **왜:** In commands-ask.ts the embed+rank call (rankKnowledgeChunks) runs sequentially after the model selects knowledge_search. On a local machine the embed call runs on CPU and the model call runs on GPU — they can genuinely overlap. Firing the embed speculatively (before tool-selection completes) and accepting the result if the model selects knowledge_search cuts latency by the embed call duration (~50-200ms per turn). No semantic change: the speculative path only pre-computes; the result is discarded if the tool is not selected. This is a pure async restructuring in one file.
- **Muse seam:** apps/cli/src/commands-ask.ts — the sequential rankKnowledgeChunks call after intent detection. packages/agent-core/src/knowledge-recall.ts — rankKnowledgeChunks (the function to be speculatively called).
- **첫 슬라이스:** In the ask pipeline where rankKnowledgeChunks is called after tool selection, start a speculative `rankKnowledgeChunks(query, ...)` Promise before the model generate call (capture it as a const, do not await). After generate returns: if the tool call is knowledge_search, await the already-in-flight speculative Promise (resolves immediately if complete) instead of starting a new call; otherwise discard the Promise. Add a timing assertion in a test: two runs of the same query — sequential vs speculative — speculative total time ≤ sequential time.
- **검증:** Wall-clock timer test: measure median ask latency over 5 runs before (sequential) and after (speculative) on a knowledge_search query. Target: ≥40ms reduction. `pnpm eval:self-improving` must not regress (grounded answers must be identical — same rankKnowledgeChunks result). `pnpm smoke:broad` green.

## 시퀀싱/노트

## What to do FIRST and why

**Rank 1 (MuseToolDefinition examples) is the single best first commit.** It is an S-effort pure data+serializer change with no new files, no new dependency, no architecture change, and it directly closes the #1 local-8B failure mode (wrong/missing arg values). The `eval:tools` argsPresent scorer gives an immediate measurable before/after signal. It also composes with every other tool-calling improvement — grammar-constrained decoding (rank 3) and schema compilation (rank 11) stack on top of it without conflict.

**Rank 2 (compaction citation continuity) is the second commit** because it is also S-effort and closes a live grounding-edge gap that worsens with every long session. `citedSourcesIn` is already exported and tested; `COMPACTION_SUMMARY_PREFIX` is already a constant. This is essentially wiring two already-built pieces together.

## Dependencies and sequencing

- Rank 1 → Rank 3 → Rank 11: the three tool-calling techniques are fully independent but stack in order of impact. Do 1 first so eval:tools establishes a clean baseline before adding grammar constraints (rank 3) or schema compilation (rank 11).
- Rank 2 is a standalone; no dependency on any other item.
- Rank 5 (renderEpisodicSection budget) and Rank 6 (salience gate) are both write-path episodic improvements with no mutual dependency — either can go before the other, but rank 5 is the cheaper first slice.
- Rank 7 (heat scoring) depends on StoredEpisode having a heatScore field; rank 10 (provenance escalation) also extends StoredEpisode with rawEpisodeId. Do NOT interleave those two in the same commit — the interface change collides. Rank 7 first, then rank 10.
- Rank 4 (reverify context reset) is a hardening of the already-built GroundingReverify seam. It unblocks rank 10 (provenance escalation) from being mis-evaluated in tests because a contaminated reverify context inflates false 'grounded' verdicts.

## What was dropped and why

- **Online-Optimized Tool-RAG** (embedding online updates for tool retrieval): effort L, requires online gradient update loop against the embedding model, no proven Ollama API surface for this — too speculative for the local setup.
- **CLAG cluster-local memory** (both the self-improving and memory-compaction variants): effort L, requires a new sidecar cluster-profile store and a local-Qwen routing call per write. Overlaps with rank 7 (heat scoring) and rank 5 (budget truncation) which deliver similar precision gains at S/M effort.
- **JitRL logit-bias** (non-parametric logit shaping): effort M, but Ollama's `logit_bias` API surface is tool/token-id based, not action-string based — mapping PlaybookStrategy reward signals to token IDs for Qwen requires reverse-tokenization that is not yet in the adapter and is fragile across model versions. Deferred, not dropped.
- **ContextBudget sub-agent boundary compression** (rank 24): effort M, but the multi-agent buildOrchestrationResponse path is lower-traffic than the ask wedge. Rank 12 (speculative parallelism) delivers latency wins on every ask turn at S effort.
- **Blackboard-Driven Shared Evidence State**: effort L and requires replacing the OrchestrationProposal struct which is used across the multi-agent surface. High reward but architectural; defer until the 3-way topology routing (rank 8) has shipped and the panel path is better understood.
- **CoDA Planner/Executor context split**: effort M but touches orchestrate.ts and the harness handoff contract simultaneously — high merge-conflict risk with other ongoing work. The rank-8 topology routing achieves 70% of the win at S effort by simply not firing the panel when it's unneeded.

## Grounding-edge invariant across all items

Every item in this backlog either (a) directly strengthens a grounding gate (ranks 2, 4, 10), (b) improves the signal quality of what enters the grounding gate (ranks 5, 6, 7), or (c) ensures the right tool fires with correct arguments so the grounded action actually executes correctly (ranks 1, 3, 11). Nothing in this list weakens or bypasses verifyGrounding. The fabrication-rate = 0 release gate remains the floor throughout.

