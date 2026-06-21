# Muse dev backlog — the living ledger

- ✓ stale-fact caution propagated to the chat persona (buildMusePersona staleKeys + chat-repl staleFactKeys) — full ask↔chat mark-parity (contested/provisional/stale); fire-16 deferred chat-side done (doctrine P3 #3) — context-strategy fire 20 (detail in docs/goals/loops/context-strategy.md)

- ✓ conversation-trim summary overshoot fixed: trimConversationMessages reconciles against the HARD budget after inserting the compaction summary (re-trims removable history; summary + last user turn never dropped) — context-strategy fire 19 (detail in docs/goals/loops/context-strategy.md)

- ✓ URL-guard filename carve-out (bare filename like report.txt no longer false-refused; zip/mov gTLDs stay guarded) + JUDGE-DRILL passed (verifier caught a wired-but-inert + tautological-test slice) — context-strategy fire 18 (detail in docs/goals/loops/context-strategy.md)

- ✓ exemplar selection precision: stop-word down-weighting in @muse/prompts scorer (function-word-only query no longer injects an off-topic few-shot demo into the 12B window; doctrine P1/P4; arXiv:2506.03100) — context-strategy fire 17 (detail in docs/goals/loops/context-strategy.md)

- ✓ stale-fact point-of-use caution in <<memory>> grounding block (staleFactKeys via classifyFactFreshness; contested→provisional→stale precedence) — months-stale fact no longer asserted as confident (doctrine P3 #3; SSGM arXiv:2603.11768) — context-strategy fire 16 (detail in docs/goals/loops/context-strategy.md)

- ✓ URL/domain grounding-value guard on the sync chat gate (answerAssertsUnsupportedUrl → abstain) — closes the fabricated-link class the number/email/identifier guards miss (doctrine P2; Netcraft phishing-URL harm) — context-strategy fire 15 (detail in docs/goals/loops/context-strategy.md)

- ✓ orchestrate-path worker output neutralized (buildOrchestrationResponse both fan-ins) — completes fire-13's ASI07 hole; tracked results keep raw for trace fidelity (doctrine P5) — context-strategy fire 14 (detail in docs/goals/loops/context-strategy.md)

- ✓ sub-agent worker output neutralized at the lead-worker fan-in (runOne neutralizeInjectionSpans) — blocks inter-agent injection/forged-citation propagation (doctrine P5, OWASP ASI07) — context-strategy fire 13 (detail in docs/goals/loops/context-strategy.md)

- ✓ episodic-fade reinstatement-on-reaccess: a faded session re-engaged recently (live recallStats) is exempted from FADE_PENALTY — never silently down-rank a still-recalled source (doctrine P3/P4; mem0 decay-unless-reaccessed) — context-strategy fire 12 (detail in docs/goals/loops/context-strategy.md)

- ✓ durable/provisional/contested fact-caution PARITY on chat persona (buildMusePersona marks volatile/once-seen facts like ask does; doctrine P3 consolidation-spine sub-slice 1) — context-strategy fire 11 (detail in docs/goals/loops/context-strategy.md)
- ✓ RESOLVED (agent-hardening fire 12, `2f62ee0f`): single-marker dependent decomposition — a request with ONE sequencing marker + a real cross-step dependency ("노트를 검색한 뒤 그 결과를 요약해줘") now fans out (was dropped to single-agent by the `sequencing >= 2` gate, starving the sequenced-threading). Done the structurally-sound (split-first) way the fire-11 blocker prescribed: new `singleMarkerDependentSplit` helper splits on the ordered marker FIRST (`extractSequencedSteps`), then runs the existing `listHasBackReference` on the split clauses (items[1..]); wired as a `sequencing >= 1 && singleMarkerDependentSplit` gate rule. STABLE-0 new-rule FP on a 31-case adversarial benign corpus incl. the fire-11 mention-of-a-step class; independent Opus ④b judge PASS (0/22 over-fires on its own corpus). REMAINING (conservative under-fire, low priority): a sentence-INITIAL KO marker ("먼저 …하고 그 결과를 …") leaves the marker at clause position 0 so the split yields 1 clause and the rule can't admit it — a future fire could add a leading-marker-aware split if real traffic shows the miss matters. Also latent (pre-existing, fire-11-noted): "step 1"/"next," each in BOTH SEQUENCING_SIGNALS and the back-ref set → a benign "Next, what did step 1 say?" double-counts to seq=2 and trips the EXISTING `sequencing>=2` rule.
- ✓ RESOLVED (agent-hardening fire 14, `4db07c35`): MARKER-LESS dependent two-step decomposition — the no-ordered-marker half of the MAST gap (fire 12 closed the single-marker half). "오늘 매출을 집계해. 그 결과를 정리해." / "Pull the list. Use those results to draft a note." carry a real cross-step dependency but had NO ordered marker, so they ran BLIND on a single agent (step 2 acts ON step 1's absent output → fabricated result the per-subtask grounding gate can't catch). FIX: new `sentenceSplitDependentTwoStep` SPLITS on sentence boundaries (`.。!！?？`), then requires `listHasBackReference` in a NON-interrogative TAIL clause (act-ON "그 결과를 정리해" fires; ask-ABOUT "그 결과는 어땠어?" excluded); gated `signals.sequencing === 0` so it's strictly additive (marker requests still owned by the marker path). Wired into BOTH shouldDecompose + decomposeRequestWithKind (gate↔split consistent → lead-worker threads step 1 output into step 2, e2e-probe confirmed). STABLE-0 new-rule FP: maker 16-note + independent Opus ④b judge's own 22-note KO+EN benign corpus, both zero over-fires; ④b judge re-ran all mutations (force-false→4 RED, drop-`?`-guard→1 RED) VERDICT PASS. REMAINING (low priority): a 3+-sentence dependent CHAIN only threads the 2-step shape today (each tail clause still gets prior context, but the helper's name reflects the 2-step framing); a sentence-INITIAL marker case is still owned by the fire-12 path. eval:orchestration + eval:decomposition PASS live.
- ✓ RESOLVED (agent-hardening fire 15, `96da29f2`): one-shot tool-calling reliability — the Ollama adapter's `safeParseToolArgs` returned `{}` on any `JSON.parse` failure of a STRING-typed `tool_calls[].function.arguments`, silently dropping ALL of a local model's tool arguments when the emitted string carried a recoverable surface-form defect (a markdown ``` fence, leading/trailing preamble prose). gemma4:12b then fired the tool argument-less despite SELECTING correctly AND filling args. FIX: new pure `recoverToolArgsJson` (`packages/model/src/adapter-ollama.ts`) — on parse failure it (a) strips a markdown fence + reparses, then (b) runs a STRING-AWARE balanced-brace scan to extract the outermost `{...}` (a `}` inside a string value never terminates early) + reparses, returning the object only if it's a plain object else `undefined` (caller keeps `{}`). LOCATE-only — never rewrites token contents, so recovered values are byte-faithful (STABLE-0 fabrication: `"not json"`, arrays, scalars, Python literals, single-quoted JSON all stay `{}`). Diversifies off the saturated @muse/tools arg-coercion seam (f9/f10/f13): different pkg (@muse/model), different layer (provider response parse, not post-validation coercion). Selection-neutral. MUTATION-FIRST: neuter → 6 recovery tests RED, 14-case FP corpus GREEN; independent Opus ④b judge's own 50+-case adversarial corpus (cross-object splice / nested hijack / brace-in-string) found zero fabricated values — VERDICT PASS. REMAINING (deferred, low priority): the OpenAI-compatible adapters (`adapter-openai.ts`) parse tool-arg strings via their own path; a future fire could audit whether they share this drop-on-defect class (the OpenAI Responses/chat shape rarely wraps args in prose, so lower traffic).

- ✓ content-free grounding-header guard: optionalGroundingSections drops present:true blocks with empty body (no citable-looking header backing nothing; doctrine P2/P4) + JUDGE-DRILL passed (verifier caught an inert unwired-helper slice) — context-strategy fire 10 (detail in docs/goals/loops/context-strategy.md)

- ✓ memory-fact value now wrapper-marker-escaped (escapeSystemPromptMarkers in renderMemoryFact) — closes the <<memory>> block breakout/forged-citation vector (OWASP ASI06, doctrine principle 5) — context-strategy fire 9 (detail in docs/goals/loops/context-strategy.md)

- ✓ selectFilePassages per-source char-budget overshoot fixed (fit-before-admit + top-1 floor; AdaGReS arXiv:2512.25052) — context-strategy fire 8 (detail in docs/goals/loops/context-strategy.md)

- ✓ shared the lexical matcher (tokenMatchesKeywordWord exported from @muse/tools, agent-core copy deleted) — closes the fire-5 drift bug class structurally; arXiv:2502.04073 — context-strategy fire 7 (detail in docs/goals/loops/context-strategy.md)

- ✓ query-relevance threaded into the cross-block edge-place — fire-1's dormant relevance? path activated (episode recall score blended with tier on a shared 0-1 scale; arXiv:2410.05983) — context-strategy fire 6 (detail in docs/goals/loops/context-strategy.md)
- ✓ NL tool-SELECTION parser skips a negation-led tool mention — "don't use X, use Y" / KO "X은 쓰지 말고 Y" no longer resolves to the REJECTED tool X (MAST reasoning-action mismatch, arXiv:2503.13657); earliest NON-negated mention wins, all-negated → no tool; affirmative path + eval:tools:nl 7/7 unmoved — agent-hardening fire 13 (`7880ab64`, detail in docs/goals/loops/agent-hardening.md)

- ✓ JUDGE-DRILL (fire 10) — confirmed the ④b independent Opus judge CATCHES a deliberately vacuous (declaration-only) test for a tool-arg-repair slice; then shipped the real slice: numeric tool-arg coercion accepts an explicitly-signed-positive value ("+5" → 5) so a one-shot call from the local model executes — agent-hardening fire 10 (`8cec8359`, detail in docs/goals/loops/agent-hardening.md)

- ✓ inflection-aware tool-relevance matching — capToolsByRelevance ranking now agrees with the @muse/tools selection layer (lights→light kept past the cap; CJK 할 일 over-match fixed) — context-strategy fire 5 (detail in docs/goals/loops/context-strategy.md)

- ✓ query-anchored span retention in the per-result cap (ACON arXiv:2510.00615 / Lost-in-the-Middle arXiv:2307.03172; keeps the load-bearing middle span the query needs, verbatim, neutralize-first) — context-strategy fire 4 (detail in docs/goals/loops/context-strategy.md)
- ✓ default relevance-ranked tool-exposure ceiling on the live runtime path (Less-Context-Better-Agents arXiv:2606.10209 / MemTool arXiv:2507.21428; enforces tool-calling.md ≤5-7, lossless tail-drop) — context-strategy fire 3 (detail in docs/goals/loops/context-strategy.md)
- ✓ stale-observation masking in the model loop (The-Complexity-Trap arXiv:2508.21433 / ACON arXiv:2510.00615; ref-recoverable, fixes unbounded multi-turn context growth) — context-strategy fire 2 (detail in docs/goals/loops/context-strategy.md)
- ✓ cross-block grounding-block edge-placement (Lost-in-the-Middle arXiv:2307.03172 / Attention-Basin arXiv:2508.05128) — context-strategy fire 1 (detail in docs/goals/loops/context-strategy.md)
- ✓ RGV recall gate ignored the conformal-calibrated MUSE_GROUNDING_MIN_COSINE (KnowNo arXiv:2307.01928) — paper-grounded fire 1 (`b415f08f`)
- ✓ whetstone misgrounding axis was blind on the CHAT surface (ASK-only); chat now records it (ALCE arXiv:2305.14627) — paper-grounded fire 2 (`1ee899bf`)
- ✓ web Tasks 체크박스 버튼(open/done)이 aria-label 없어 스크린리더에 이름 없는 "button" — TaskCheckbox 추출 + aria-label — surfaces fire 53 (`4a337c3b`)
- ✓ desktop 음성모델 다운로드 % 버블 truncation("99%" 고착)·sub-1% "0%" 노이즈·no-clamp("101%") + NaN trap — downloadProgressBubble(round+clamp+≥1%, NaN-safe) — surfaces fire 54 (`2a756c0a`)
- ✓ web Dashboard tool-accuracy `Math.round(x*100)`이 극값 붕괴(0.999→"100%" 거짓 완벽·0.004→"0%") — formatAccuracyPct(비극단 보장) — surfaces fire 55, fire 54의 크로스-표면 형제 (`7b2f708c`)
- ✓ cli "1 notes"/"1 entries" 복수 하드코딩(notes folders·feeds list·history 헤더 3곳, count=1) — 공유 `pluralize` 헬퍼 추출 후 라우팅 — surfaces fire 56 (④b judge가 형제 2개 적발→배칭) (`4f4894e7`)
- ✓ web MCP 서버 관리 콘솔 — McpServersView(목록·상태·connect/disconnect, API 기존 완비) — surfaces fire 57, 진안 "웹에서 다 관리" 요청 1번째 (`05c219ba`)
- ✓ 자기강화 대시보드 **API 토대** — `GET /api/self-improvement/weaknesses`(whetstone 약점원장 read-only, shapeWeaknesses 정렬) — surfaces fire 58; NEXT=웹 뷰가 이 API 소비 (`f9f1ddca`)
- ★ **웹 관리/자기강화 콘솔 로드맵** (진안 요청 "openclaw/hermes처럼 웹에서 MCP·설정·스킬·자기강화 다 관리"). MCP 콘솔(fire 57 done)에 이어 surfaces 루프가 fire별 배송:
  - ◦ web 자기강화 대시보드 — whetstone 약점원장·playbook 전략·learned·eval 스코어보드 *읽기* (신규 API GET 라우트 + 웹 뷰; 데이터는 ~/.muse 로컬파일이라 HTTP 노출부터)
  - ◦ web 스킬 컨트롤 — skills 목록 + reward/curate/author (신규 API + 웹)
  - ◦ web 설정/daemon 토글 — proactivity·episodic·skill학습·watch daemon on/off (PUT /settings/:key 기존, ~80 env 플래그는 env→runtime 브리지 필요)
  - ◦ web MCP 콘솔 확장 — add/remove 서버 + allowlist(`/api/mcp/security`) 편집 (API 기존, 웹만)
- ✓ Playbook eviction PEVI-parity (PEVI arXiv:2012.15085): `retainPlaybookEntries` now ranks bank-overflow survival on the Wilson-LCB `retentionUtility` (inline-replicated `rankingUtility`, NOT the rolled-back `effectiveStrategyReward` shrinkage), so a thin-but-lucky strategy no longer evicts a battle-tested one; no-tally falls back byte-identically to clampReward(reward) — self-improvement fire 1
- ✓ chat resolves a topic's grounding-gap on a GROUNDED SUCCESS (`isChatGroundedSuccess` + `chatResolveWeakness`, BKT mastery, ask-parity) so a now-answered recurring gap stops nudging — self-improvement fire 4 `9f2f484b`
- ✓ doctor `WEAKNESS_AXIS_LABEL` friendly labels for source-conflict + misgrounding (user-facing `formatWeaknesses`) — self-improvement fire 5 `1bde1536`
- ✓ ACT-R spacing guard on memory PROMOTION (`selectPromotableMemories.minDistinctAccessDays`, default 2): a single-session burst doesn't graduate into the always-on persona; PROMOTE-side sibling of fire-3 fade floor — self-improvement fire 6 `8b12d589`
- ✓ Self-consistency WRITE-admission gate on distilled strategies (`distillConsistentStrategy`, conformal-abstention arXiv:2405.01563 + ReasoningBank MaTTS 2509.25140): k=3 drafts, bank the medoid only if they AGREE (mean Jaccard ≥0.5) — extends fabrication=0 from read→learning-write — self-improvement fire 8 `b467b9c3`
  - ✓ FOLLOW-UP DONE (self-improvement fire 10 JUDGE-DRILL): `distillConsistentStrategy.onReject(agreement)` telemetry fires on the disagreement-reject path (read-only) so the 0.5 floor's false-reject rate is measurable — `af25e7c2`. ✓ NEXT DONE (fire 12): `distillSessionCorrections` consumes it → `DistillResult.lowConsistencyRejected` observable from a real session — `66d153e4`.
- ✓ Salience-weighted eviction for the REFLECTION store (Generative Agents arXiv:2304.03442): `scoreReflectionRetention`/`selectRetainedReflections` (@muse/mcp reflections-store) trim cap-overflow by recency+salience(min(1,support/5)) not pure recency, so a high-support recurring insight isn't evicted for a thinner newer one; equal-support → legacy recency — self-improvement fire 11 `c9e7fe4b`
  - ✓ FOLLOW-UP closed: `selectReflectionsForRecall` (salience+recency, reusing scoreReflectionRetention) now orders the ask-grounding recall surface, so a RETAINED high-support old insight actually reaches the top-K injected prompt; `listReflections` stays newest-first for display. — self-improvement fire 23 `602b675b`
  - ✓ Skill write-time body-subsumption dedup (Voyager arXiv:2305.16291): `writeOrPatch` now skips authoring a draft whose PROCEDURE-body is a subset (directional containment ≥0.85) of an existing skill — the name/desc Jaccard never inspected the body, so fresh-named near-dups slipped through to the curator's idle merge. Directional (superset never suppressed), fail-open, non-destructive. — self-improvement fire 24 `35bd3dd9`
    - ◦ NIT (judge fire 24, low-prob): `consolidate`'s umbrella write routes through `writeOrPatch`, so an umbrella could in principle be subsumption-skipped against an unrelated surviving skill and then mis-reported as merged. Near-zero (umbrellas are supersets → low containment) + non-destructive; if it ever bites, add a `writeOrPatch(draft, {skipSubsumption:true})` opt for the consolidate path.
- ✓ Doctor `formatWeaknesses` excludes MASTERED topics (`!isMasteredWeakness` + "· N mastered" note) — runtime-nudge mastery parity, no more nagging a fixed topic — self-improvement fire 13 `e7656eb8`
- ✓ Write-time NOVELTY gate on episodic memory (Mem0 NOOP arXiv:2504.19413 + SAGE arXiv:2605.30711): `isEpisodeNovelVsRecent` in `captureEndOfSessionEpisode` drops a near-dup session (token-Jaccard ≥0.8 vs 10 most-recent); embedder-free, fail-open, subtractive — self-improvement fire 14 `fd2a3516`
- ✓ Utility-aware authored-skill eviction (SkillOps arXiv:2605.13716 + TinyLFU arXiv:1512.00727): `rankSkillsForEviction` makes `enforceCap` evict lowest-utility (never-used before ever-used, ties LRU) not FIFO-by-age; degrades to FIFO with no usage data (no regression) — self-improvement fire 15 `1f86f39c`
- ✓ RESOLVED (agent-hardening fire 16, `0304823e`): **Memory factHistory refine-vs-contradict LABELING** (Mem0 arXiv:2504.19413; Zep arXiv:2501.13956). Both decomposed halves shipped in one cohesive slice. (a) `FactSupersession.kind?: "refine"|"contradict"` set by the EXISTING `classifyValueChange` (token-subset) in `collectFactSupersessions`; File store serialize/deserialize round-trips it (deserialize validates the enum, drops corrupt); back-compat (absent on legacy → "was" framing). (b) `buildFactTimeline`/renderer (commands-memory.ts) carries `kind` into `FactTimelineEntry.previous[]` and prints "refined from" / "changed from" / "was". STRICTLY ADDITIVE (previousValue byte-faithful, kind DERIVED not invented — fabrication 0); conservative-safe (a real flip is ALWAYS "contradict" by the strict subset check; case-only + KO token-disjoint refinements fall to "contradict" = over-warn, never hide). Sibling-audit: muse-persona/chat-ink read only key/previousValue/replacedAt (invisible to the new field). MUTATION-FIRST RED ×2 (neuter classifier→3 refine tests RED; drop render kind-propagation→carry test RED). Independent Opus 4.8 ④b judge (own 15-case KO+EN corpus, mutation re-run, scope audit) VERDICT PASS. @muse/memory 484/484 + @muse/cli 2814/2814 + lint clean.
- ✓ Self-consistency write gate on the IDLE distiller (`distillQueuedCorrections`, @muse/autoconfigure) — sibling parity with the sync path; the default-on autonomous learner now draws k=3 drafts and banks only on agreement (was single one-shot draft). arXiv:2405.01563 — self-improvement fire 17 `1fd3fb8b`
- ★ **EFFICACY AUDIT findings (fire 17, 3 Opus audits, codegraph-verified)** — answering "is self-improvement REAL / are the mechanisms correct?". HEALTHY+live-default: whetstone ledger, Mem0 auto-extract + belief-provenance (File store), Playbook ranking (rankingUtility Wilson-LCB, no regression), skill select/usage/eviction. Open findings ranked:
  - ✓→partial **Cross-turn "experience-helps" — DETERMINISTIC retrieval proof** (the audit's #1, landable half): `experience-recall-cross-session.test.ts` proves an experience persisted in session 1 is RECALLED by a fresh provider in session 2 (file is the only link → InMemory fails it), with empty-store/unrelated-query negatives. CI-gated, no Ollama, mutation-verified. — self-improvement fire 22 `6a99f621`
    - ◦ REMAINING (LIVE, Ollama-gated): the answer-QUALITY delta — same fixed tasks, EMPTY vs PRIMED store, assert the model ABSTAINS empty / GROUNDS+CITES primed (guards GROUNDED≠TRUE). `runEvalSuite` already passes `scenario` to `solve` (no harness change needed) → a `verify-experience-delta.mjs` battery with two scenarios. Pre-verify STABLE 3/3 — but smoke:live stalls on the loop box (assembled-agent path); do when Ollama is stable. Also: userId-isolation negative (a save under a different user must not leak).
  - ◦ **Episodic capture INERT for the default agent** — `captureEndOfSessionEpisode` early-returns unless `MUSE_EPISODIC_MEMORY_ENABLED` (default false), so ALL its write gates (outcome/grounding/salience + fire-14 NOVELTY) never fire for default users; the persona block that reads the episodes file always sees empty. Decide: flip default-on (it's fail-soft + write-gated so it won't store junk; privacy is local-only by construction) OR stop counting it as a default capability. Pre-verify pass^3 end-to-end (episode lands + surfaces next session).
  - ✓ Summary-store recall INERT in CLI — added `FileConversationSummaryStore` (@muse/memory) + defaulted the no-DB factory to it (PERSIST=false escapes to in-memory); summaries now persist across CLI processes so cross-session recall works + fade/promotion get fuel. Mutation-verified 2-process. — self-improvement fire 19 `932c3020`
    - ✓ FileTaskMemoryStore — in-progress task state (goal/plan/decisions/blockers) now persists across CLI processes; wrap-delegate-persist over InMemoryTaskMemoryStore (rebuilds active-session index, preserves timestamps so retention isn't reset), nested Dates round-trip, factory defaults no-DB to File (PERSIST=false escape). Mutation-verified cross-session. — self-improvement fire 21 `4926fce8`
  - ✓ CORRECTION: fire-17 wrongly rejected audit Finding "buildPlaybookProvider drops origin" as a hallucination — it was REAL (searched @muse/agent-core, but the fn lives in @muse/autoconfigure). Fixed fire 18 `7b860f8e`: origin now carried through `buildPlaybookProvider` (runtime/--with-tools/API) AND `selectPlaybookSection`/`topAppliedStrategy` (@muse/recall, default `muse ask` path) — reflected ranking penalty + CBR gate live again on all three. — self-improvement fire 18
- ◦ **Playbook reinforcement-credit by INJECTED-ID set** (precision gap, fire-16 scout). `applyPlaybook` (playbook.ts:923) records only `metadata.playbookApplied:true`, NOT which strategy ids were injected, so the decay/credit path `moveReward` (chat-distill-corrections:141) RE-DERIVES the target by cosine (`selectCreditTargetSemantic`) — a correction can decay the WRONG strategy. Decomposed (3 seams):
  - ◦ (a) @muse/agent-core: `applyPlaybook` records the injected strategy id list in run metadata (additive).
  - ◦ (b) @muse/cli: session-history persists that id list across the turn.
  - ◦ (c) @muse/cli: `moveReward` credits the recorded ids directly (cosine only as fallback when ids absent — legacy). OUTCOME: a correction decays the actually-injected strategy, not the nearest-cosine one.

- ✓ performConsentedAction followed redirects with the Bearer credential attached (credential-exfil, gap-scout DONE): `consented-action.ts` fetched with the default `redirect:"follow"`, but the host-binding guard vets only the ORIGINAL url — so a 3xx from the consented host pointing elsewhere had `fetch` auto-re-issue the request WITH `Authorization: Bearer <credential>` to an un-consented host (irreversible scoped-credential exfil; outbound-safety.md rule 5). web-action.ts already closed this with `redirect:"manual"`; the credential-carrying consent path hadn't. Fixed: `redirect:"manual"` + fail-close on any 3xx (refuse, credential never re-sent). Verified: @muse/mcp 1853 tests (+1 acceptance: a 302→evil host yields performed:false, fetch called exactly once on the consented host, the Bearer token never reaches evil.example.net) + full check + lint green.
- ✓ performConsentedAction action-log omission — core-hardening fire 2 (rule 4: every outbound, sent OR refused, records a reviewable entry). Added opt-in `actionLogFile?`/`now?`/`idFactory?` + a `log()` helper appending one rationale-bearing `ActionLogEntry` before ALL 7 return branches (veto/no-consent/invalid-url/host-mismatch/timeout-or-transport-failed/redirect/performed); credential never logged, body secret-scrubbed+capped; absent file ⇒ no log (back-compat). Mirrors web-action.ts. OUTCOME-verified (@muse/mcp 1860 tests + Opus ④b PASS).
- ✓ Gemini/Anthropic adapters lose .retryable on a transport-level fetch rejection (gap-scout DONE): both called `this.fetchImpl(...)` with NO try/catch, so a connection-level failure (ECONNREFUSED/DNS = a raw `TypeError` with no HTTP status) escaped untyped — the OpenAI-compatible + Ollama paths wrap it into `ModelProviderError(retryable:true)` but these two cloud adapters didn't. architecture.md: "ModelProviderError.retryable is the source of truth" — the same blip was then classified inconsistently (api server `isRetryableUpstreamError`→false=permanent; agent-core catch-all→true). Fixed by lifting the wrapper into a shared exported `fetchOrThrowAsProviderError` in `provider-base.ts` (one source of truth for transport-error shaping) and calling it from all three adapters (OpenAI-compat refactored to delegate; Gemini + Anthropic wrapped). Ref: MDN fetch (network error → TypeError, no status). Verified: @muse/model 318 tests (+2: a rejecting fetch yields ModelProviderError retryable:true for each cloud adapter) + full check + lint green. (Note: only reachable under MUSE_LOCAL_ONLY=false, but the adapter contract must hold regardless.)
- ✓ ReAct path enum/const argument enforcement (gap-scout DONE): the default `muse ask`/chat ReAct loop (`agent-runtime.ts` `executeToolCall`) coerced types + checked required args but did NOT enforce closed-vocabulary `enum`/`const` constraints — only the plan-execute path did (`validateEnumArguments`), so an 8B fabricating an out-of-schema enum value (`to:"base64"` for an enum of binary/octal/decimal/hex) reached the handler (crash, or a write/actuator running a meaningless mode) — a `tool-calling.md` #3 + same-runtime (`cli-product.md`) inconsistency. Fixed by wiring the existing `validateEnumArguments` into the ReAct path right after the required-arg check, fail-close: an out-of-enum value returns a `blockedToolResult` (the model self-corrects within `maxToolCalls`), the handler is never invoked. Ref: BFCL AST argument-value checks (gorilla.cs.berkeley.edu). Verified: agent-core 2436 tests (+2: out-of-enum blocked & handler-never-invoked, valid-enum executes) + full check + lint green.
- ✓ ask failure-trace observability (capability-boost fire 6 retry → DONE): `commands-ask.ts` now defines a fail-soft `writeAskFailureLog(errorMessage)` and calls it from all 3 ask failure paths (`--with-tools` runtime-missing, the agent-run catch, the chat-only stream-error) — each reuses the already-tested `buildAskRunLog({ success:false, grounded:null, errorMessage, … })` and `return`s BEFORE the end-of-run success trace, so there's no double-write. A failed `muse ask` now leaves a `success:false` run-log trace, so `scout-signals` / doctor failRate can finally see ask failures (chat-repl already did). Verified: build + lint green, cli suite green, and a fire-6 payload-contract test in program-helpers.test.ts pins the exact emitted shape (success:false + non-empty error + grounded:null + empty response/tools). Honest bound: the 3 call sites are wiring over a tested builder (the ask mega-command has no integration harness in-repo); the builder + payload contract are unit-tested, the wiring is build-verified.

- ✓ vision write-path grounding gate (capability-boost fire 5 retry → DONE): `vision-actions.ts` now runs an INDEPENDENT evidence transcription (a separate `describeImage` pass) and a deterministic `gateVisionAction`/`fieldIsGrounded` over every extracted field — a value not confirmable in the evidence lands in `action.unverified`, is flagged in the draft, and the `--apply` path REFUSES the autonomous write while unverified is non-empty (code gate, not a prompt). The 3 fire-5 defects are fixed: (a) digit grounding requires only ≥4-length runs (year/amount/phone-block) so a worded-month date ("June 7" ⇒ "2026-06-07" via the year) and a country-code phone are NOT false-dropped, with a word/entity (incl. CJK) majority fallback for text; (b) empty/failed evidence fails CLOSED (every field unverified), matching the text precedent; (c) false-drop regression tests landed (worded-month date, country-code phone, separator amount, CJK). Verified: 9 new unit tests + `eval:vision` asserts the gate doesn't over-drop the real fixtures' headline fields — STABLE 3/3 on gemma4:12b; full check + lint green.

## ★ Open — Muse edge hardening (WIDENED loop theme, 진안-directed 2026-06-20 after fire 8)

The grounding/injection sub-theme below is essentially COMPLETE (fires 1-7 + SSRF/curator/recall already built). 진안 widened the loop to four surfaces — **memory-integrity · self-development · orchestration · grounding-floor** — keeping the grounding edge as the maintained floor. Candidates below are GAP-SCOUT-VERIFIED open (Opus, codegraph-checked — three named items [skill curator, playbook RL, ask→orchestration wiring] were confirmed ALREADY BUILT and are NOT listed). Pick the top ★ by value.

- ✓ (G1) **Surface the `source-conflict` weakness axis for remediation** — DONE (competitor-grounding fire 9, self-development): `source-conflict` (the user's OWN saved notes disagree — written to the ledger since fire 5 but read by NO selector) is now user-remediable: `USER_REMEDIABLE_AXES = {grounding-gap, source-conflict}` in `selectRemediableWeaknesses`, `RemediableWeakness` carries its `axis`, and new `remediationHint(axis, topic)` renders the DIFFERENT fix per axis ("add a note about X" vs "your saved notes about X disagree — reconcile them"). The evening recap (`commands-recap.ts`) renders each via its hint under an axis-agnostic header. OUTCOME-verified end-to-end (a source-conflict ledger entry → gatherEveningRecap → reconcile copy, NOT "add a note") + Opus ④b judge PASS 6/6 (verified EXHAUST: of the 7 axes, only 4 are production-WRITTEN and all 4 now read by a selector — source-conflict was the lone written-but-unread). RESIDUAL ◦: doctor `WEAKNESS_AXIS_LABEL` lacks friendly labels for source-conflict/misgrounding (safe `?? axis` fallback today — cosmetic).
- ✓ (G2) **Unify the injection neutralizers — give the live-surface neutralizer policy's evasion-decoding** — DONE (competitor-grounding fire 10, grounding-floor; this fire was also the JUDGE-DRILL). BOTH chokepoints now match against `@muse/policy`'s `normalizeForInjectionDetection` (entity-decode + NFKC + zero-width-strip + homoglyph-fold + diacritical-strip): `isMemoryInjection` (atomic facts) + `neutralizeInjectionSpans` (ALL tool/MCP/sub-agent output via capToolOutput + the two plan-execute paths + note/episode/feed prose). So a homoglyph-`іgnore` / `&#105;gnore` injection in tool output / recall prose is now neutralized. KEY DESIGN: `neutralizeInjectionSpans` uses a clean-text FAST PATH — if the normalized form has no injection it returns the ORIGINAL byte-identical, so normalization's diacritical/NFKC collateral is paid ONLY on injection-containing (untrusted) text; clean accents/fullwidth recall content is never mangled. Judge verified NO fast-path false-negative (normalization only ADDS matchability for the ASCII patterns → superset). OUTCOME-verified end-to-end (capToolOutput + note-chunk homoglyph neutralized; clean accented byte-identical) + Opus ④b judge PASS 6/6. Closes T1-c-resid ii.
- ✓ (G3) **Per-fact provenance (firstSeen / lastConfirmed / confirmCount / freshness)** — DONE (competitor-grounding fire 11, memory-integrity). STALE-finding corrected: NO risky `facts`-store migration was needed — the per-fact provenance DATA already exists in the append-only `BeliefProvenance` log (`@muse/memory/belief-provenance-store.ts`: `learnedAt` written on every learn, by auto-extract + `muse memory set`). New `deriveFactProvenance(entries)` aggregates the log per key → `{firstSeen=min, lastConfirmed=max, confirmCount, source=user-outranks-auto, value=at-latest}`; new `classifyFactFreshness({lastConfirmed,now,agingDays=30,staleDays=90})` → fresh/aging/stale. Wired end-to-end into `muse memory why <key>` (renders "confirmed N× since <firstSeen> · <freshness>"). OUTCOME-verified + Opus ④b judge PASS 6/6 (mutation-tested). UNBLOCKS G4.
- ✓ (G4) **Memory-promotion gate — durable user-fact promotion from gated recurrent confirmation** — DONE (competitor-grounding fire 12, memory-integrity). New `selectPromotableFacts(provenance, {now, minConfirmCount=3, recentDays=90, isInjection?})` (mirrors `selectPromotableMemories`): a fact earns DURABLE status iff NOT injection-flagged AND (`source==="user"` [user truth outranks inference, immediate] OR (`confirmCount≥3` AND recent)). FAIL-CLOSE: an injection-flagged value is NEVER promoted however often confirmed; the `isInjection` check is dependency-injected (CLI passes the real `isMemoryInjection`) so @muse/memory stays agent-core-free. Pure (selects, never promotes-in-place — no partial side-effects). Wired into `muse memory why <key>` ("· durable" / "· provisional"). OUTCOME-verified (5 gate cases + the end-to-end fail-close via the wired detector) + Opus ④b judge PASS 6/6. Consumes G3's `deriveFactProvenance`.
- ✓ (G4-followup) **Tie durable-vs-provisional to GROUNDING** — DONE (competitor-grounding fire 14, memory-integrity + grounding-floor). New pure `provisionalFactKeys(matchedKeys, provenance, {now, isInjection?, normalizeKey?})` (@muse/memory) = matched facts KNOWN in the provenance log but NOT durable (a key with no provenance entry is UNKNOWN, not over-marked). `buildMemoryContextBlock(facts, {provisionalKeys})` (@muse/recall) renders a provisional fact with " (unconfirmed — learned once, not yet re-confirmed)". `muse ask` (commands-ask.ts) loads the belief-provenance log, derives, computes provisional keys (real `isMemoryInjection` + `normalizeMemoryKey`), passes them — FAIL-SOFT (no provenance ⇒ no mark). So a once-seen auto-extract (possible mis-extraction) is grounded cautiously, not asserted as confirmed (GROUNDED != TRUE on the source side). OUTCOME-verified end-to-end (log → provisional → annotated block; injection value marked AND defanged = defense-in-depth) + Opus ④b judge PASS 7/7. (Honest scope: deterministic marking + prompt signal — not a claim the 8B fully obeys the tag.)
- ⊘ (G5) **Chat-path auto-orchestration parity with `ask`** — DEFERRED (competitor-grounding fire 13, Opus orchestration scout). Verified genuinely-unbuilt (chat-repl.ts has ZERO decompose refs), BUT a POOR FIT: chat is a STREAMING continuous-companion REPL; `runDecomposedAgentAsk` is a non-streaming BATCH (N subtask runs + 1 synthesis, sequential on one GPU) → bolting it in = a multi-second silent mid-conversation stall = UX regression on the exact surface built for liveness. The "don't fork behavior" non-negotiable is ALREADY satisfied at the ENGINE level (both surfaces share `agentRuntime`); decomposition is an ask-specific PRESENTATION concern, not core behavior. Defer, don't build.
- ✓ (G6) **Subtask deduplication gate (MAST #3: no duplicated sub-agent work)** — DONE (competitor-grounding fire 13, orchestration). The Opus scout verified this was the ONE genuinely-open MAST gap (the other 4 — typed hand-off, bounded termination, failure-propagation, context-isolation — already enforced+tested). New `dedupeSubtasks` in `lead-worker.ts` (normalized-text keep-first, re-id, drop-empty) applied in `runLeadWorkerTask` AFTER both subtask sources (structural `decomposeRequest` + model `planner`) and before fan-out → one chokepoint covers both AND the ask path (runDecomposedAgentAsk → runLeadWorkerTask). ALSO fixed `parsePlannerLines` (the dedup surfaced it): the old `^[-*•\d.)\s]+` ate the leading `1` from `1분기 정리` → `분기 정리`, MANUFACTURING identical subtasks; precise `^(?:[-*•]|\d+[.)])\s*` preserves `1분기`. OUTCOME-verified (duplicate planner subtask → execute called once; distinct unaffected; markers stripped, 1분기 kept) + Opus ④b judge PASS 6/6. Residual ◦: structural-source dup covered-by-construction but not directly tested.

### Refill batch 2 (gap-scout fire 15, codegraph-verified open; G1-G6 + follow-ups all ✓)
- ✓ (H1) **Fan-in objective-satisfaction verifier for the live `ask` decomposition (maker≠judge)** — DONE (competitor-grounding fire 15, orchestration). The CLI ask synthesis was a shallow self-report (MAST "done-by-self-report"); the server had `verifyFinalAnswer` but the CLI path did not. New deterministic `verifySynthesisCoverage(finalAnswer, executions)` (@muse/multi-agent): a COMPLETED non-empty sub-task whose salient tokens are ENTIRELY absent from the synthesis is flagged dropped (conservative — a paraphrase passes). `LeadWorkerDeps.verifySynthesis?` + `LeadWorkerResult.synthesisIncomplete` (fail-soft); wired in `runDecomposedAgentAsk`; `muse ask` surfaces "⚠ some sub-results may be missing" instead of returning confident-incomplete. OUTCOME-verified + Opus ④b judge PASS 6/6. (Flag-only originally.)
- ✓ (H1-followup) auto re-synthesis — core-hardening fire 5 (orchestration): `runLeadWorkerTask` now does ONE verifier-gated re-synthesis when the first synthesis drops a sub-result. Refactored to a `runSynthesis` helper; the retry prompt NAMES the dropped sub-results (`reinforceSynthesisRequest`, not a bare "try again") and is accepted ONLY if it was itself VERIFIED and drops STRICTLY FEWER results — so a retry can never worsen the answer, and an errored-verifier retry never clears the flag (no false completeness). Registered in `scripts/reflection-guard.test.mjs` (external verifier = `verifySynthesisCoverage`, arXiv 2510.18254). OUTCOME-verified (@muse/multi-agent 123 tests + ask-decompose wiring 4-vs-5-run cases + eval:orchestration PASS + Opus ④b PASS).
- ✓ (H2) **Value-volatility signal in the durable-promotion gate** — DONE (competitor-grounding fire 16, memory-integrity; fixes a flaw in the builder's OWN fire-12 gate). `FactProvenance` gains `distinctValueCount` (`deriveFactProvenance`: `new Set(group.map(e=>e.value.trim())).size`). `selectPromotableFacts`' AUTO branch now requires `distinctValueCount === 1` (stable) on top of confirmCount≥3 + recent — so a belief the auto-extractor gave CONFLICTING values for (address X→Y→Z, distinctValueCount 3) no longer auto-promotes as durable (it was the INVERSE signal: re-confirmation of a CHANGING belief). A USER-stated fact still promotes regardless of flips (latest = their truth). The provisional chain is AUTOMATIC (volatile → not durable → `provisionalFactKeys` → "(unconfirmed)" in grounding, fire 14). `muse memory why` shows "value changed N× (volatile)". OUTCOME-verified + Opus ④b judge PASS 5/5 (the chosen distinctValueCount metric is MORE conservative/fail-safe than a current-value-run alternative, which would auto-promote a previously-contradicted value — riskier for the grounding floor). UNBLOCKS H4.
- ◑ (H3) **Cross-lingual source-conflict detection** — Hangul-labelled subset DONE (competitor-grounding fire 18 = JUDGE-DRILL, grounding-floor). `LABELLED_VALUE` was `[A-Za-z]`-only → a Hangul-labelled field ("주소: 서울" vs "주소: 부산") never parsed and a Korean source-conflict was silently missed. FIX: label class → `[\p{L}][\p{L}\p{N} ]` (BOTH chars Unicode) + Korean PROSE_LABELS (참고/참조/메모/예시/요약/주의/비고). Korean conflict now DETECTED, agreement/prose excluded, ASCII unchanged (superset). Opus ④b judge PASS 5/5 (false-positive = parity with already-accepted English prose; all guards hold). **Remaining (◦ H3b, DEFERRED):** EMBEDDING-backed semantic pass — prose contradictions + EN↔KO SEMANTIC field matching ("주소"≡"address"), needs embeddings (reuse `detectEvidenceContradictions` topic-sim → `contestedOutcome`).
- ✓ (H4) **Surface volatile beliefs in the recap (close the H2 loop)** — DONE (competitor-grounding fire 17, self-development). New pure `selectVolatileBeliefs(provenance, {now, recentDays=90, minDistinctValues=2, maxResults=3})` (@muse/memory) = recently-active AUTO beliefs the extractor keeps flipping (distinctValueCount ≥ 2); a USER-stated belief is excluded (their latest is already deliberate truth). The evening recap (`commands-recap.ts`) renders "🔄 These keep changing — confirm the current value" with a RUNNABLE `muse memory set <kind> <key> <value>` nudge. Closes the monitor→detect→remediate loop: H2 demotes a volatile belief to provisional → H4 nudges the user → `muse memory set` re-states it user-source → `selectPromotableFacts` promotes it durable. OUTCOME-verified (volatile auto surfaced, stable/user/stale excluded; end-to-end written-log → recap nudge) + Opus ④b judge PASS 5/5 (judge caught a malformed nudge command missing `<kind>` → fixed in-fire so the command actually runs).

### Refill batch 3 (gap-scout fires 19-37)
- ✓ (Z1) **Thread a TRUNCATION partiality notice into the synthesis prompt (close a fan-out GROUNDED≠TRUE leak) + JUDGE-DRILL** — competitor-grounding fire 37 (orchestration). When the lead-worker fan-out truncates the sub-task list to MAX_SUBTASKS (8), the dropped items never execute (not in `executions`, so `verifySynthesisCoverage` can't flag them). Before this fix, the synthesis prompt was identical to the untruncated path — the model presented the 8 survivors as a COMPLETE answer to an N-item (e.g. 11) request: a GROUNDED≠TRUE leak in the answer TEXT (the channel the user reads), the MAST "unaware of termination" failure for truncation-dropped subtasks. FIX: `truncatedSynthesisRequest(request, dropped)` appends an explicit partiality directive (`[부분 응답 — …${dropped}개가 처리되지 않았다…누락이 있음을 반드시 명시하라]`, mirrors the sibling `reinforceSynthesisRequest`); first synthesis + the re-synthesis retry base both carry it when truncated (sibling). ask-decompose `buildSynthesisPrompt` already embeds the engine-supplied request, so it reaches the model. This fire was the JUDGE-DRILL: a planted INERT version (helper returned the request unchanged + a test that only re-checked the pre-existing `truncated` flag) was caught FAIL by the independent Opus judge (live-captured the bare synthesis request), rolled back; the real fix went PASS 5/5 (dist-captured the directive end-to-end, mutation-proven — reverting to the inert helper turns 2 tests RED, sibling re-synthesis verified truncation-aware). multi-agent 171 / cli 2802.
- ✓ (Y1) **Scope the session-end playbook reward loop to INJECTABLE strategies (no fabricated reward attribution)** — competitor-grounding fire 36 (self-development). The session-end reward loop `moveReward` (chat-distill-corrections.ts) credited/decayed a strategy chosen by cue-similarity against the ENTIRE bank — including ones NEVER injected this session (probation guesses, avoided/stale). So a PROBATION strategy (recorded but never injected by contract) could be silently REINFORCED by a cue-similar approval — a fabricated reward attribution that corrupts future ranking via experience-following (arXiv:2505.16067). The decay daemon already scoped to `bank.filter(isInjectableStrategy)` but the session loop didn't = inconsistency. FIX: the credit candidate pool now filters `isInjectableStrategy(e) && !isStaleStrategy(e, nowMs)` — EXACTLY the injection ranker's filter (playbook.ts:686), so "creditable" ≡ "injectable" (neither looser=bug-persists nor stricter=under-credits). OUTCOME + mutation verified (dist: probation strategy NOT credited even when most cue-similar; injectable still rewarded→1; graduated-off-probation still creditable) + Opus ④b judge PASS 5/5 (filter byte-identical to ranker, no under-crediting). ◦ FOLLOW-UP (deferred big one): crediting the WRONG injectable strategy when several are cue-similar still needs injected-strategy-ID threading through run→session-log→distill. Plus the gate-recovery sub-commit (raw ESC bytes → `\u001b` in the goddess loop's commands-logo.test.ts, which was blocking pnpm check for ALL loops).
- ✓ (X1) **Date-drift gate on the ASK path (the INVERSE of fire 31 — close the gate-asymmetry, de-dup monthDayKeys)** — competitor-grounding fire 35 (grounding-floor). The CHAT hard gate catches a drifted month-day date (fire 31), but the ASK value guard `answerAssertsUnsupportedValue` (agent-core) only caught bare digits/emails/named-entities — month names are stoplisted and a drifted day digit ("14") is waved through when any "14" appears elsewhere in evidence. So `muse ask` (the wedge surface) surfaced a wrong calendar/renewal/deadline date as grounded. FIX: `monthDayKeys` (ISO+prose+KO, case-sensitive months) moved INTO @muse/agent-core + exported; `answerAssertsUnsupportedValue` checks month-day drift FIRST, then strips date expressions before the bare-number check (so a date's day isn't re-judged as a loose number — no false-fire when the same day appears only inside an ISO date). Feeds the EXISTING fail-OPEN escalation (flag→one judge pass→demote only if the judge agrees; a judge error never refuses). chat-grounding deleted its private copy + imports the shared one (de-dup, kills the divergence that opened the asymmetry). OUTCOME + mutation verified (dist: prose/KO drift→ungrounded; judge-throw→grounded fail-open; ISO↔prose-equivalent correct date→no escalation) + Opus ④b judge PASS 5/5 (fail-open preserved, no false-fire, chat date gate still 11/96 pass after de-dup, byte-clean). lesson: a guard duplicated across two surfaces (chat monthDayKeys + ask) is where a gate-asymmetry hides — share ONE copy in the lowest common package so both surfaces can't diverge.
- ✓ (W1) **Contested-fact caution on the CHAT persona path (close the gate-asymmetry — fire 20/21 pattern, for memory point-of-use)** — competitor-grounding fire 34 (memory-integrity). The `ask` path renders a contested-fact caution (a value that FLIPPED across confirmations → "(value has changed before — confirm it's current)", refinement-aware so Seoul→Seoul-Gangnam doesn't count), but the CHAT persona (`buildMusePersona`, the system prompt fed to the model on EVERY chat turn) had NO contested caution — only a value-blind `(previously X)` note. So in chat (Muse's primary continuous-companion surface) the model asserted a value Muse itself knew was volatile. FIX: `buildMusePersona` gains `contestedKeys?` (caution takes precedence over the value-blind note); derived from the belief-provenance store + wired on BOTH chat persona callers — the Ink chat (chat-ink) AND the one-shot `muse chat` (chat-repl), fail-soft. OUTCOME + mutation verified (dist: contested→caution; stable→byte-identical to before — zero over-firing on the every-turn prompt; refinement-aware; precedence) + Opus ④b judge PASS 5/5. 형제: ask's persona left un-wired (its grounding block already carries the caution — redundant); brief/proactive are non-grounded greeting/notification surfaces — honestly out of scope.
- ✓ (V1) **Surface fan-out trust signals on `muse ask --json` + the run-log (GROUNDED≠TRUE leak on the machine surface)** — competitor-grounding fire 33 (orchestration). The decomposition (lead-worker fan-out) trust signals — `subtaskConflicts` (sub-answers contradicted), `synthesisIncomplete` (a completed sub-result dropped), truncation (capped at MAX_SUBTASKS) — were surfaced ONLY on human STDERR (gated `!options.json`), NOT in the `--json` payload or run-log. So a downstream agent/script got a confident `answer` + `groundedVerdict:"grounded"` with ZERO indication the fan-out self-contradicted / dropped a result / was truncated — the leak on the one surface that can't read a banner. FIX: `LeadWorkerResult.truncated` STRUCTURED flag (was reason-string-only); `DecomposedAskResult.truncated`; pure `decompositionJsonFields` helper → a `decomposition` block emitted ONLY for a decomposed run (no single-run noise; empty arrays omitted), wired into BOTH the --json payload AND `buildAskRunLog` (so a fan-out failure no longer logs as a clean success — feeds the error-analysis flywheel). OUTCOME + mutation verified (dist: decomposed→block with conflicts/incomplete/truncated; single-run→no key; run-log carries it) + Opus ④b judge PASS (both machine surfaces wired, no third surface — api/SSE don't decompose, truncated no-drift, floor untouched). ◦ FOLLOW-UP (judge-noted, non-blocking): a command-level integration test that parses real decomposed `muse ask --json` stdout to mutation-pin the wiring (currently helper-level mutation only).
- ✓ (U1) **Close the misgrounding-resolution half of the whetstone BKT loop** — competitor-grounding fire 32 (self-development). The weakness ledger learn-loop was ASYMMETRIC: `recordWeakness` lowered BKT mastery for all 7 axes on a miss, but `recordWeaknessResolved` raised it for `grounding-gap` ONLY — so a `misgrounding` (the GROUNDED≠TRUE core failure: answered but the cited source didn't support it) accumulated monotonically and NEVER resolved, and `selectDevFixableWeaknesses`→`muse doctor` (mastery-blind) nagged a fixed topic forever. FIX: new `GROUNDED_SUCCESS_RESOLVABLE_AXES = {grounding-gap, misgrounding}` (both learned away by a later grounded success; actuator axes time-parse/wrong-tool/unbacked-action + user-action source-conflict correctly NOT auto-resolved); `selectDevFixableWeaknesses` gains `!isMasteredWeakness` (parity with the recap selector). The existing ask/chat resolve call-sites already gate on grounded-success, so a misgrounding turn can't resolve itself — only a LATER grounded answer does. OUTCOME + mutation verified (dist: misgrounding resolves to mastered + drops off doctor; time-parse/source-conflict not resolved; no false-resolution) + Opus ④b judge PASS 5/5 (floor untouched — pKnown never read by the abstain gate; 3 selectors now consistently mastery-aware, formatWeaknesses honest-historical correctly not filtered).
- ✓ (T1) **Chat date-drift gate covers PROSE/Korean dates (close the calendar-date fabrication hole)** — competitor-grounding fire 31 (grounding-floor). The hard chat gate `answerAssertsUnsupportedDate` compared ISO dates only, but the calendar grounding block renders month-name dates ("September 14, 2026") via toLocaleString, so a drifted prose calendar/deadline date passed as grounded. FIX: `monthDayKeys` extracts a script-neutral month-day key from ISO + English prose ("September 14"/"Sep 14") + Korean ("9월 14일"); year is dropped (the number guard owns it). MODAL-VERB fix (caught by the ④b judge mid-fire): "may" is matched CASE-SENSITIVELY (initial-cap) so the modal "you may 3 …" isn't a false-refusal (the ask path stoplists "may" for the same reason). OUTCOME + mutation verified (dist: prose/KO/"May 5" drift → abstain; modal "may"/ISO↔prose-equiv/month-only → no false-refusal) + Opus ④b judge PASS (re-judged after the modal fix). ◦ FOLLOW-UP: the ASK path (`answerAssertsUnsupportedValue`) stoplists month names and has NO date-drift coverage — a separate slice (different mechanism: value-escalation, not this guard).
- ✓ (S1) **Forget durability: a forgotten fact must not silently resurface (user > auto authority)** — competitor-grounding fire 30 (memory-integrity). `forget` was a pure key-drop with NO tombstone, so the auto-extractor (which only sees the CURRENT stored value) re-classified a forgotten fact as "add" (current=undefined) and SILENTLY re-persisted the value the user just deleted — an inference overriding an explicit user retraction ("forget that doesn't stick", against "Tell it everything. It can't tell anyone."). FIX: `BeliefProvenance.retraction?` marker (no value; deriveFactProvenance SKIPS it → fire 16/22 confirmCount/value/distinctValueCount invariants preserved); `keysWithActiveRetraction` (newest-event-is-retraction, a later re-`set` clears it); `recordRetraction` helper; auto-extract `applyOp` suppresses an add/update on a retracted key (fail-open); BOTH user-forget sites (CLI `memory forget` + in-chat `/forget`) wired via the shared helper (형제-감사). OUTCOME + mutation verified (dist: forgotten home_city NOT resurfaced, a different key still writes, a user re-statement reopens it — no over-suppression) + Opus ④b judge PASS 5/5. clear-all/dreaming-purge are bulk/internal (not targeted user retractions) — correctly out of scope.
- ✓ (R1) **Fan-in source-leak: an ungrounded sub-task's sources must not grade the answer** — competitor-grounding fire 29 (orchestration). In the `muse ask` decomposition path every sub-task's retrieved sources were merged BEFORE its output was judged, so a sub-task that retrieved `secret.md` then REFUSED (gated ungrounded, output withheld) still left `secret.md` in the evidence the synthesized answer was graded against + the Sources footer — a GROUNDED≠TRUE seam (the answer could be marked grounded on / cite a source no surviving sub-task used). FIX: `SubtaskExecution.sources?` STATUS-LINKED (runOne threads `produced.sources` into all returns — completed/ungrounded/failed); `ask-decompose` stops eager-merging, derives `mergedSources` from ONLY `status==="completed"` executions ∪ the synthesis run's own sources. OUTCOME + mutation verified (dist: refused subtask's secret.md DROPPED; completed actions.md + synth.md KEPT; single-completed/non-decomposed paths keep their real sources — no false-negative) + Opus ④b judge PASS 5/5 (mutation-proven — merge-all revert → RED). The last unguarded fan-in seam (output already withheld; now sources too).
- ✓ (Q1) **Agent-path `time-parse` weakness producer for the reminder loopback (fire 26 sibling) + JUDGE-DRILL** — competitor-grounding fire 28 (self-development). fire 26 wired the dead time-parse axis at the CLI `calendar add/edit`; the AGENT path (loopback reminder MCP tool) was deferred. FIX: `RemindersMcpServerOptions.weaknessesFile?` + `recordTimeParseWeakness` on BOTH the `add` AND `snooze` dueAt-parse-failure branches (in-file 형제-감사 — the snooze sibling was caught by the ④b judge mid-fire and patched same-fire); prod caller (`autoconfigure/loopback-tools.ts`) passes `resolveWeaknessesFile(env)` so it's LIVE. This fire was the JUDGE-DRILL: a planted bad slice (chat-nudge "DRY-unify" that discarded askTimeWeaknessNudge's verdict + passed `[]` + happy-only tests) was caught FAIL by the independent Opus judge (specific violation cited), rolled back; the real fix then went PASS 6/6 (mutation-proven). STALE-BACKLOG: chat-nudge DRY-unify was ALREADY built by a concurrent loop (`chatRepeatWeaknessNudge`, mastery-aware) — corrected. ◦ FOLLOW-UP (cross-file siblings, separate slices): `loopback-calendar.ts` startsAt parse sites + `loopback-followups.ts` scheduledFor have no weaknessesFile.
- ✓ (P1) **Wire the injection neutralizer onto the STORED/SYNCED grounding surfaces (close the gate-asymmetry)** — competitor-grounding fire 27 (grounding-floor). The deterministic injection defense `escapeSystemPromptMarkers(neutralizeInjectionSpans(...))` was wired on only 3 of 8 sibling grounding-block builders (note/episode/feed); calendar/contact/reminder/task/action/shell/git rendered third-party text (synced gcal/caldav invites, vCard-imported contacts) RAW into the `<<event>>`/`<<contact>>` wrappers — an imperative-override or forged `<<end>> [from system.md]` breakout reached the local model untouched (the exact threat prompt-escape.ts's MARKER_KEYWORDS enumerates). FIX: new `safeField` helper (present.ts) wired into EVERY raw free-text field of buildTask/Reminder/Shell/Git/Action/Calendar + buildContact (select.ts: name/about/relationship/connection) + the missed feedName header/citation (형제-감사). Content AND citation use the same escaped value (gate stays consistent). OUTCOME + mutation verified (dist: malicious title/about → "removed", breakout escaped to exactly 1 literal `<<end>>`, benign round-trips) + Opus ④b judge PASS 5/5 (sibling-audit complete, citation-consistent, mutation-proven — inert safeField → 5 RED). ◦ FOLLOW-UP: `connection.as` is first-party (user-typed), out of scope.
- ✓ (O1) **Wire the DEAD `time-parse` weakness axis to its deterministic producer** — competitor-grounding fire 26 (self-development). `time-parse` was declared in WeaknessAxis + DEV_FIXABLE_AXES + remediationHint + doctor-displayed but had ZERO producers (only test fixtures) — same dead-end-detector class fire 9 fixed for source-conflict. FIX: new pure `recordTimeParseWeakness(phrase, failed, deps)` (@muse/mcp); wired at BOTH calendar time-phrase parse sites (`calendar add` + sibling `calendar edit`, on the `!parseEventStart` failure branch, fail-soft). A code-detected (deterministic parser, not the model) time-misread now reaches `selectDevFixableWeaknesses`/doctor. OUTCOME + round-trip verified (dist: garbage `--at`→time-parse entry→dev-fixable surface; valid `--at`→none) + Opus ④b judge PASS 5/5 (mutation-proven). ◦ FOLLOW-UP: `wrong-tool` is the sibling dead axis (zero producers, but no clean deterministic oracle — harder); loopback-reminder `parseReminderDueAt` (agent path, lacks env/weaknessesFile).
- ✓ (N1) **Runtime weakness nudge on the ASK path (close the learn→apply loop at point-of-use)** — DONE (competitor-grounding fire 24, self-development). A confirmed recurring weakness was surfaced ONLY in the once-a-day recap, not at the moment the user hits the same wall again via `muse ask`. STALE-BACKLOG: the CHAT path ALREADY surfaces an inline KO/EN runtime nudge (chat-repl.ts:693, count≥2) — the scout over-stated "ask/chat"; the real gap was ASK-only. FIX: new pure `askTimeWeaknessNudge(entries, topic)` (@muse/mcp — a recurring USER-REMEDIABLE weakness on the asked topic, count≥2, not mastered, highest-count axis; reuses USER_REMEDIABLE_AXES + remediationHint + BKT); `commands-ask` reads the ledger after recording + surfaces a KO/EN axis-aware "💡 …" stderr cue (deterministic user-facing, NOT a prompt — respects security≠prompt; floor untouched). OUTCOME-verified (dist: recurring→nudge, single-ask/dev-fixable/mastered/different-topic→none) + Opus ④b judge PASS 5/5. ✓ FOLLOW-UP DONE (self-improvement fire 2): chat's hard-coded nudge unified onto the shared `askTimeWeaknessNudge` + extracted `renderAskTimeNudge` — chat now surfaces source-conflict reconcile wording + BKT mastery suppression at ask-parity, wording can't drift; ask output byte-identical. ◦ NEXT (judge nit): chat doesn't `recordWeaknessResolved` on a grounded success (ask does) so a closed gap keeps nudging until BKT mastery — wire grounded-success resolution into the chat path.
- ✓ (J2) **Cross-subtask conflict reconciliation on the fan-in** — DONE (competitor-grounding fire 23, orchestration). `verifySynthesisCoverage` checks each sub-task is REPRESENTED but nothing checked the sub-answers are mutually CONSISTENT — when worker A says "deadline Tuesday" and worker B "Wednesday", the synthesis concatenated an internally-inconsistent answer (both individually passed groundingGate → the fan-in passed a self-contradicting claim = GROUNDED≠TRUE fabrication). The contradiction primitive existed (`detectEvidenceContradictions`) but was applied only to source NOTES. FIX: EXTRACTED `detectPairwiseContradictions(texts, embed, opts)` shared core (@muse/agent-core, ONE detector for evidence + fan-in layers, no policy drift); new `detectSubtaskConflicts(executions, embed)` (@muse/multi-agent); `LeadWorkerDeps.detectConflicts?` + `LeadWorkerResult.subtaskConflicts?`; `ask-decompose` threads embed + wires it; `muse ask` surfaces "⚠️ sub-results disagree — verify before trusting". OUTCOME-verified (dist: contradicting flagged + named, consistent/elaboration/different-topic/failed→[], fail-soft) + Opus ④b judge PASS 5/5 (extraction byte-identical — all 17 pre-existing contradiction tests pass; reuse + real wiring). Scout confirmed chat is single-turn BY DESIGN (no orchestration-parity gap). ◦ FOLLOW-UP runner-up: remediationHint reaches only the recap, not the ask/chat runtime prompt (weakness learn→apply loop open at runtime — needs deterministic-not-prompt design).
- ✓ (M1) **Contested-fact (volatile-value) caution on the recall/ask hot path** — DONE (competitor-grounding fire 22, memory-integrity). `selectVolatileBeliefs` (a fact whose value FLIPPED across confirmations, distinctValueCount≥2) was consulted ONLY in the once-a-day recap — never on the ask hot path. So a fact confirmed 5× with an oscillating value got the WRONG provisional caution "(unconfirmed — learned once)" (factually wrong + understates the risk). FIX: `buildMemoryContextBlock` gains `contestedKeys?` rendering "(value has changed before — confirm it's current)" with PRECEDENCE over the once-seen mark; new pure `contestedFactKeys(matchedKeys, provenance, opts)` (@muse/memory, mirrors provisionalFactKeys, lifts the recap's top-3 cap so ALL matched volatile keys flag); `commands-ask` computes + passes it from the already-loaded provenance. OUTCOME-verified (dist: a 3×-flipped fact → "changed before", NOT "learned once") + Opus ④b judge PASS 5/5 (judge caught the top-3-cap edge → fixed in-fire). Scout confirmed memory consolidation/decay (Mem0 ADD/UPDATE/NOOP/DELETE + ACT-R) ALREADY BUILT — STALE-BACKLOG. ◦ FOLLOW-UP (L escalation): write-time refinement-vs-contradiction NLI reconciliation (Mem0 UPDATE semantics).
- ✓ (L1) **Faithfulness gate on the proactive Phase D notice (close the GROUNDED≠TRUE asymmetry on the PUSH surface)** — DONE (competitor-grounding fire 21, proactivity/grounding-floor). Same gate-asymmetry pattern as K1: the proactive daemon synthesized a heads-up by running the local 8B at T=0.4 over `item.factSheet`, and that free prose reached the user as an UNASKED push (higher-trust) through only length/JSON filters — a wrong time / invented location pushed verbatim. FIX: new shared `buildGroundingReverify(provider, model)` (@muse/agent-core — the canonical one-shot judge, works on a narrow no-structured-output provider via the free-text YES/NO fallback); `synthesizeNoticeText` gains `reverify?` and FAILS CLOSE to the verbatim store-grounded `item.text` on NO/throw/empty-evidence; BOTH live callers (`commands-proactive`, `proactive-tick`) wired; proactive surface added to the reflection-guard registry. VISION confirmed ALREADY gated (classifyVisionAction→fieldIsGrounded — STALE-BACKLOG-correct, no gap). OUTCOME-verified (dist: unfaithful→item.text, faithful→kept, throw→item.text, empty→no judge) + Opus ④b judge PASS 5/5 (both callers really gated; fail-close target safe). ◦ FOLLOW-UP: consolidate fire-20 `buildModelGroundingReverify` onto the shared `buildGroundingReverify` (minor pre-existing duplication; responseFormat tradeoff).
- ✓ (K1) **Faithfulness verifier on the live in-chat reflection (close the GROUNDED≠TRUE asymmetry)** — DONE (competitor-grounding fire 20, self-development/memory-integrity). The OFFLINE dreaming path (`synthesizeReflections`→`verifyReflectionsGrounding`) re-checks each cross-session insight against its cited episodes; the LIVE in-chat path (`synthesizeReflection`, used by `/reflect` + the morning brief) had NO verifier — a confabulated "I've noticed you keep …" observation reached the chat raw. FIX: `synthesizeReflection` gains `reverify?: GroundingReverify` (FAIL-CLOSE: judge NO / throw / empty-evidence → drop the insight); `buildModelGroundingReverify` reuses the SAME exported reverify primitives the offline path uses; `chat-ink.ts reflectInsight` (the choke point for BOTH user-facing surfaces) builds + passes it; the in-chat surface ADDED to `reflection-guard.test.mjs` REFLECTION_SURFACES (was absent — CLAUDE.md-pinned rule). OUTCOME-verified (dist: reject→drop, accept→keep, throw→drop, empty→no judge) + Opus ④b judge PASS 5/5 (live path REALLY gated, faithful reuse). ◦ FOLLOW-UP: a live `verify-reflection.mjs` negative-entailment case (deferred — box saturated; deterministic gate fully proven). STALE-BACKLOG note: H3b's semantic-PROSE conflict is ALREADY BUILT (`detectEvidenceContradictions`, Mem0 arXiv:2504.19413, wired ask+chat); cross-lingual EN↔KO is a DELIBERATE precision-first fail-open (same-script guard, fire-28/36/39 lesson) — not a clean slice.
- ✓ (J1) **Dependency-aware sequenced decomposition** — DONE (competitor-grounding fire 19, orchestration). MAST reasoning-action mismatch: `extractSequencedSteps` split an ordered request ("먼저 X … 그 다음 Y") into sub-tasks but EVERY step ran in ISOLATED context — a sequenced step 2 that should act on step 1's RESULT ran BLIND. FIX: `decomposeRequestWithKind → {subtasks, sequenced}` (sequenced only for ordered splits; numbered/bullet/planner = independent); `LeadWorkerDeps.execute(subtask, priorContext?)` threads the COMPLETED prior steps' outputs forward for sequenced splits (fail-close: failed/blank not threaded; independent stays isolated); `ask-decompose` prepends "이전 단계 결과:" to the worker message. OUTCOME-verified (dist probe: sequenced→step2 sees step1, independent/planner→isolated, blank-prior→not threaded) + Opus ④b judge PASS 5/5. ◦ FOLLOW-UP: a live `verify-decomposition.mjs` dependent-sequence case (deferred — box saturated; the deterministic threading mechanism is fully proven). Scout assessed memory/self-dev/grounding-floor as saturated this round.

### ✓ verified ALREADY-BUILT (do NOT re-scout — gap-scout fires 8+15): skill curator (curate/consolidate/held-out gate, @muse/skills) · playbook reward/decay RL (PEVI LCB ranking, agent-core/playbook.ts) · ask→sub-agent orchestration (runDecomposedAgentAsk fully wired) · per-subtask grounding gate + dedupeSubtasks + typed handoff validation (lead-worker) · cross-store memory↔note conflict cue (conflict.ts) · server-path verifyFinalAnswer (index.ts — but NOT the CLI path = H1) · injection neutralizer fully applied across all surfaces (grounding-floor saturated).

## ✓ Done / superseded — grounding sub-theme (fires 1-8, dedup ledger)

Source: code-level survey of cloned openclaw + hermes-agent (BOTH MIT) vs Muse — both LACK a deterministic grounding gate (Muse's moat confirmed). **ADOPT PATTERNS ONLY** (ideas/algorithms aren't copyrightable); re-implement fresh in Muse's own TS — NEVER copy their files. Identity-invariant: local-only (MUSE_LOCAL_ONLY) + fabrication=0. Full analysis in memory `project_competitor_deep_compare`.

Tier 1 — poisoned-source defense (closes Muse's #1 known gap GROUNDED≠TRUE; competitors have NO grounding gate):
- ✓ (T1-a) **Load-time threat-pattern scan of memory/note/episode/feed entries** — DONE across all 4 grounding surfaces (`competitor-grounding` fires 1-3, journal has detail): atomic facts whole-defang (`defangMemoryInjection`, fire 1) + episodes/feeds/notes SPAN-level (`neutralizeInjectionSpans`, fires 2-3 — replaces only the matched injection span, keeps surrounding prose so a benign trigger word no longer nukes a whole summary). Single shared pattern source `@muse/recall/injection.ts`; persona path consolidated. OUTCOME-verified on all surfaces + Opus ④b judge PASS (fire 3). Residual ◦ below.
- ✓ (T1-a-resid) `^system:` line-anchored mid-prose fake-system — core-hardening fire 1 (added the `m` flag → `/imu` so a `\nsystem:` role-hijack line injected after benign lead-in prose is now neutralized on ALL grounding/tool surfaces via `MEMORY_INJECTION_PATTERNS`; superset — no existing detection weakened, span-scoped replacement).
- ✓ (T1-a-ko) Korean injection on the stored/tool neutralizer — core-hardening fire 3: `MEMORY_INJECTION_PATTERNS` was English-only, so a Korean poisoned note/tool-output ("이전 지시를 무시하고…") sailed past `neutralizeInjectionSpans` untouched (a grounding-floor hole for the Korean user). Added ONE narrow Korean pattern = the analog of the canonical ignore-previous-instructions shape (verb-final noun→무시/잊); span-scoped collateral symmetric with the accepted English baseline. OUTCOME-verified (agent-core 2477 tests + Opus ④b PASS, 6 benign-Korean false-positives empirically span-bounded, no ReDoS).
- ⚠ (T1-a-ko-resid) Korean act-as/output-clamp analogs of English patterns 2-3 — **ATTEMPTED + ROLLED BACK (core-hardening fire 6, ④b adaptive judge FAIL)**. Naive anchoring (`(?:만|로만)\s*(?:답해|출력)` + `(?:이제|지금부터)\s*너는|(?:처럼|인 척)\s*(?:행동|말해|대답)`) catastrophically false-positives: **13/19 realistic benign Korean notes tripped (68%)** — "친구처럼 말해줬다", "결과만 출력하면 된다", "이제 너는 출근 안 해도 된다고 했다", "동생이 어른처럼 행동했다" all mangled mid-note. ROOT CAUSE: `만`/`처럼` are the most common Korean particles, colliding with everyday simile/limiting narration — categorically unlike the ignore-instructions pattern (command-noun + override-verb, which never occurs benignly). BLOCKER: needs MUCH tighter anchors (imperative terminal forms only, `처럼` paired ONLY with `인 척`/role-assertion, DROP bare `이제/지금부터 너는`) AND re-probe a LARGE benign set to STABLE 0 trips before landing. NOT a low-priority quick win — a real design problem. Lesson in core-hardening fire 6 journal.
- ★ (T1-b) **Durable claim-health layer** — DECOMPOSED (competitor-grounding fire 4, scope audit): the full claim-health (status+confidence+evidenceCount+freshness) needs a data-model foundation Muse lacks — `facts: Record<string,string>` has NO per-fact timestamp (only store-level `updatedAt` + `factHistory{key,previousValue,replacedAt}` for REPLACED facts; `packages/memory/src/memory-user-store-file.ts:56-63`), and facts carry no evidence model. So:
  - ★ (T1-b-i prereq — NOW THE TOP REMAINING THEME ITEM, competitor-grounding fire 8): per-fact provenance — add `firstSeen` / `lastConfirmed` timestamp + `recallCount` (+ optional source-count) to the user-memory fact model (parallel `factMeta` map keeps `facts: Record<string,string>` back-compat) + a one-time store migration (existing facts seed `firstSeen=updatedAt`, `recallCount=0`) + wire ONE consumer end-to-end so the OUTCOME is testable (recall increments `recallCount`; a stale/aging fact surfaces a freshness signal). This single foundation UNBLOCKS both T1-b-ii (freshness/confidence) AND T2-c (promotion gate). Substantial + a risky store migration — do it deliberately (back-compat read of old facts-only stores; never lose a fact).
  - ◦ (T1-b-ii) claim STATUS without the data model — CONTESTED ✓ (competitor-grounding fire 5): a `grounded` answer whose OWN sources disagree (`detectSourceConflict`) is downgraded to a `contested` trace outcome (`contestedOutcome`, parallel to `misgrounded`) → `source-conflict` weakness axis + run-log `contested` failure cluster (scout fuel). The standing status now shapes the TRACE, not just the answer-time cue. REMAINS: (i) `superseded` status via `factHistory` (a fact that was replaced); (ii) surface the `source-conflict` ledger axis in a SELECTOR — `selectRemediableWeaknesses`/`DEV_FIXABLE_AXES` ignore it (Opus judge fire-5 flag), so the ledger entry is run-log-fuel only; decide user-remediable recap nudge ("reconcile your conflicting notes about X") vs documented run-log-only. Pattern: openclaw `memory-wiki/claim-health.ts`.
- ✓ (T1-c) **Untrusted tool/MCP/sub-agent output neutralization** — CORE ✓ (competitor-grounding fire 6): the deterministic injection neutralizer (`neutralizeInjectionSpans`) is applied to EVERY tool-output→prompt chokepoint — `capToolOutput` (model-loop role:"tool" messages + ref-store stash), `renderPlanResultSummary` (plan-execute synthesis), `planExecuteIntermediateMessages` (plan-execute history). The neutralizer was MOVED to `@muse/agent-core` (lowest common layer; recall re-exports). Chose deterministic span-neutralization over the originally-specced `<untrusted-text>` TAG — a prompt tag does NOT stop the local 8B obeying an embedded instruction (Muse's recorded finding); the tag is intentionally NOT built. Opus ④b judge caught + I closed a plan-execute bypass IN-FIRE, then re-judged PASS. EVASION-HARDENED ✓ (fire 7): `stripInjectionEvasionChars` removes Unicode Cc/Cf/Zl/Zp (zero-width space/ZWNJ/ZWJ/BOM/soft-hyphen/bidi/NUL, keeping tab/newline/CR) BEFORE the patterns match — so a mid-word zero-width char (U+200B inside "ignore") can no longer bypass ALL 7 defended surfaces; applied once in `isMemoryInjection` + `neutralizeInjectionSpans` so facts/notes/episodes/feeds/tool-output all inherit it. T1-c COMPLETE (literal zero-width class).
- ✓ (T1-c-resid ii) STALE DUP of (G2) above — already closed by competitor-grounding fire 10: `isMemoryInjection` + `neutralizeInjectionSpans` both normalize via `@muse/policy`'s `normalizeForInjectionDetection` (entity-decode + NFKC + zero-width + homoglyph + diacritical) before matching, and all policy sites (prompt-leakage, tool-output-sanitizer, pii) route through it too. Re-verified stale competitor-grounding fire 39 (dist: `igno&#x200b;re` / fullwidth-`ｉ` / `&#8203;` all detected; benign clean) — this leftover ◦ was never struck.

Tier 2 — high-value, identity-aligned:
- ✓ (T2-a) **Cited-recall session search** — SUBSTANTIALLY BUILT (competitor-grounding fire 8 audit): past sessions ARE searchable both ways already — user-invoked `muse recall <query>` (commands-recall.ts, cross-store semantic) AND the model-callable `knowledge_search` tool (knowledge-recall.ts:1847 + autoconfigure/knowledge-corpus.ts) wired over the UNIFIED corpus: notes + EPISODES (past sessions, episodes-knowledge-source) + feeds + user-memory (SB-1). The cited-recall wedge grounds an answer in a quoted prior session via knowledge_search. RESIDUAL ◦: hermes's FTS5 KEYWORD (exact-substring/boolean) search as a COMPLEMENT to Muse's semantic-cosine recall (a different recall modality — exact quote / rare-term lookup the embedder misses); low priority, semantic recall already covers the wedge.
- ✓ (T2-b) **SSRF/egress guard (fetch direction)** — ALREADY BUILT & COMPREHENSIVE (competitor-grounding fire 4 audit corrected the survey's "Muse lacks SSRF guard" — it does NOT): `packages/mcp/src/web-url-guard.ts` blocks loopback/private(10·172.16-31·192.168)/link-local(169.254 = cloud-metadata)/CGNAT(100.64-127)/reserved + IPv6 (::1, IPv4-mapped/compatible/SIIT, NAT64 64:ff9b, fe80 link-local, fc/fd ULA), by RESOLVED IP (DNS-rebinding) with sync + async layers + redirect re-validation. Applied at EVERY web boundary: web-action / loopback-web-read / web-download / fetch-readable-url, and `muse notes ingest --url` (commands-notes.ts:433 → fetchReadableUrl). Residual ✓ (core-hardening fire 3, NON-ISSUE): `feeds-search-tool.ts` does NO outbound fetch — it searches the INTERNAL `personal-activity-feed` (locally-recorded events), so there is no external-feed SSRF boundary to route through the guard. No web-fetch site exists in the feeds path; nothing to fix.
- ◦ (T2-c) **Memory promotion gate** — a fact promotes to durable memory only after clearing recall-count(≥3) + unique-queries(≥3) + recency-half-life. Pattern: openclaw `dreaming.ts` deep-phase. **BLOCKED on the same prerequisite as T1-b**: needs per-fact recall-count tracking the user-memory model lacks (facts are `Record<string,string>`). Do T1-b-i (per-fact provenance + recall-count) FIRST — it unblocks BOTH this gate AND T1-b claim-health.
- ✓ (T2-d) **Skill curator + provenance trust boundary** — ALREADY BUILT (competitor-grounding fire 8 audit, Hermes pattern already adopted): `@muse/skills/authored-skill-store.ts` has `curate(maxIdleDays)` (archive idle authored skills, never-delete via `.archive/` rename), `consolidate(merge, {dryRun})` (cluster + umbrella-merge overlapping authored skills, archive originals, held-out-gate rollback), `recordUsage` (lastUsedAt telemetry + reward), `enforceCap`, `scanSkillBodyForRisks` + quarantine. Provenance = `SkillSource` (`authored` vs `bundled`/`user`); curate/consolidate operate ONLY on `listAuthored()` (bundled never touched by construction). WIRED: recordUsage (chat-ink), consolidate (chat-ink + commands-skills + apps/api `consolidate-tick`), curate (commands-skills). TESTED (authored-skill-store.test.ts: archive-never-delete, curate-stale, held-out rollback).

Tier 3 — smaller, identity-neutral:
- ◦ (T3-a) Commitments taxonomy — proactivity typed by kind + sensitivity (routine/personal/care) + source (agent_promise/inferred) + dueWindow + dedupeKey + snooze/dismiss/expire lifecycle. Pattern: openclaw `src/commitments`. Muse seam: standing-objective/proactivity store + outbound draft-first.
- ✓ (T3-b) Ollama/llama.cpp GBNF schema sanitizer — core-hardening fire 4: the native /api/chat tool projection sent `inputSchema` RAW (Gemini had `sanitizeGeminiSchema`, Ollama had none), so union `type` arrays + nullable anyOf/oneOf idioms silently broke llama.cpp's GBNF tool grammar. New `sanitizeOllamaToolSchema` (collapse union type→non-null, nullable anyOf→sole branch, drop null branches, strip $schema/$id, recurse w/ depth+cycle guards) wired at the projection. OUTCOME-verified (@muse/model 325 tests incl. end-to-end generate-body assertion + eval:tools green + Opus ④b PASS, adversarial cyclic/deep/triple-union probed). RESIDUAL ◦: `$ref`-with-siblings not resolved (Muse tools are flat; defer).
- ◦ (T3-c) Compaction file-op manifest — carry {readFiles, modifiedFiles} on each compaction/branch summary so the agent retains file-op provenance after history is summarized. Pattern: openclaw `compaction.ts`.
- ◦ (T3-d) Grounding-gated self-fork background review — after a turn, an off-critical-path forked review (tool-whitelisted to memory/skill writes) proposes memory/skill saves, but EVERY proposed write passes Muse's `verifyGrounding` gate (strictly safer than hermes, which writes on model judgement). Pattern: hermes `background_review.py`, hardened with Muse's gate.

DO NOT adopt (identity conflict): cloud channels/gateway, cloud realtime voice providers, Honcho cloud user-model, 87-tool breadth (violates ≤7/turn), tirith's fail-OPEN command gate (Muse is fail-close), datagen/training pipeline (Muse's model is fixed).

- ★ multi-hop recall wiring — DECOMPOSED (capability-boost fire 1): ask의 notes recall이 `rankKnowledgeChunks(WithHop)`을 안 쓰고 자체 인라인 cosine+hybrid(`apps/cli/src/commands-ask.ts:1001-1078`, seedMatches@1078)임을 확인. `rankKnowledgeChunksWithHop`(`packages/agent-core/src/knowledge-recall.ts:1144`, secondHop+associative, AUGMENT-never-displace)은 완전 빌드+테스트됐고 `knowledge-corpus.ts:485/582`가 `MUSE_RECALL_SECOND_HOP` env-gated로 호출하나 ask 경로 미적용. 측정 ROI 양성(`eval:multihop` single-hop two-hop hit@4 2/5=40%). >1 fire wedge-critical이라 loop-sized 슬라이스로 분해:
  - ✗ (1a) ask 인라인→`rankKnowledgeChunks` 전환 — **폐기(capability-boost fire 2 measure-first)**: Sonnet 독립 분석이 4 divergence를 찾음 — ① graph-link expansion(`commands-ask.ts:1077-1096` linkExpandRefs/HippoRAG)이 `rankKnowledgeChunks`에 없어 CRITICAL recall 손실, ② `rankKnowledgeChunks`는 chunk마다 re-embed(IndexChunk.embedding 캐시 미사용)→N배 느림, ③ preGapScored(confidence verdict용 untrimmed 분포) 손실→ambiguous→confident 오판, ④ per-clause RRF(diversifyAskChunks의 N+2 fusion)가 `rankKnowledgeChunks`엔 2-list만. ask 인라인이 더 풍부 → 순진한 전환은 4기능 회귀. 전환 접근 폐기.
  - ✓ (1b′ DONE — capability-boost fire 3) ask 인라인에 second-hop AUGMENT: `secondHopAugmentChunks`(@muse/recall chunks.ts, pure helper) — confident seed text로 인라인 cosine 재query → bridged chunk ≤2 append(query-relative cosine, AUGMENT-never-displace), graph-expansion과 공존, `MUSE_RECALL_SECOND_HOP` env-gated. `eval:multihop` AUGMENT arm 40%→80%(repo.md/clinic.md 구제), single-hop 회귀 0(hit@1 동일), Opus judge PASS(maker≠judge).
  - ✓ (1c DONE — capability-boost fire 4) confidence-gated default-ON promotion(`shouldSecondHop`: verdict가 confident면 hop skip) + `verify-multihop` 3-arm same-base A/B(inline-no-hop 60%→inline+hop 80%, engine ref) + `eval:agent` CI 번들 가드(fail-close: hop hit@4 < 4/5 OR < control이면 exit 1). measure-first가 ungated의 single-hop 노이즈(15/15 무관 append) 발견→gate 결정. Opus judge PASS(4 containment: 정답 top-1 보존/reorder 중간묻기/verdict weak-cap으로 거짓 grounded 불가/citation gate). latency 0.05ms.
  - ◦ multi-hop 잔여(낮은 우선): org.md(5케이스 中 1) 여전 miss=더 깊은 hop; default-on gate는 structural 안전(confidence cap)이나 약함(2/15만 protect)—미래에 hop 경로가 grounded verdict 도달 않게 유지(현재 구조적 차단).

- ⚠ pattern-offer entity-coverage gate BLOCKED (fire 41, rolled back): ECC (arXiv:2207.02263) entity-coverage as a HARD post-hoc drop on the proactive offer is mismatched — (1) an offer LEGITIMATELY adds action verbs ("draft now?"/"초안 잡을까요") absent from the facts, so coverage-of-all-tokens over-drops valid offers (broke 3 existing pattern-suggestion tests); (2) lexicalTokens does WHOLE-token matching → KO particle attachment ("월요일마다"≠"월요일") breaks coverage (the cumulative lexical-on-KO lesson). Needs entity-vs-verb separation (NER) or CJK-bigram + closed-cluster-entity-set matching, only flagging a NET-NEW entity in neither facts nor fallback — a >1-fire redesign. The number-guard already covers the numeric drift class. Decompose before retry.

- ✓ whetstone: recordWeaknessResolved masters ALL grounded-success-resolvable rows for a topic, not just the first — competitor-grounding fire 39 (self-development; gap-scout finding, no prior backlog item). A topic can carry BOTH a grounding-gap AND a misgrounding row (upsertWeakness keys by (axis,topic)); the old `find`/single-update mastered only the first-sorted, leaving misgrounding (the GROUNDED≠TRUE core axis) stuck below WEAKNESS_MASTERED_AT forever → doctor/nudge nag a re-learned topic (one-way ratchet, the un-finished half of the fire-that-made-misgrounding-resolvable). Now maps over all entries, bumping pKnown for every resolvable row on the topic (axis-filtered so a non-resolvable time-parse row on the same topic is untouched), returns the first updated (signature stable), no write on no-match. Opus ④b judge PASS 7/7 (mutation BOTH directions).
- ✓ playbook drop empty-text strategies (JUDGE-DRILL fire 40): a blank high-reward strategy ranked first and surfaced as the "applied strategy" beat (topAppliedStrategy reads ranked[0].text, bypassing renderPlaybookSection's empty filter); dropEmptyTextStrategies filters blanks before rankEligible — subtractive — agent-core-cognition fire 40

- ✓ tool-loop no-progress stall early-exit (arXiv:2505.17616): when the last 3 consecutive READ observations are near-identical (token-Jaccard ≥0.92), executeModelLoop/executeStreamingModelLoop withhold tools for the next turn → clean synthesis instead of burning maxToolCalls on spin; write/execute resets the window; literal-repetition (lexical) detection distinct from exact-dedup — agent-core-cognition fire 39

- ✓ in-conversation commitment-discharge filter (π-Bench arXiv:2605.14678): selectOpenCommitments drops a user open-loop the user already DISCHARGED later in the same session (completion marker + semantic cosine ≥0.55 to the commitment) before scheduling a check-in — stops nagging about a done thing; wired into both check-in seams (CLI session-end + daemon); subtractive, fail-soft, strict-ordering — agent-core-cognition fire 38

- ✓ plan-exemplar structural-validity gate (RAP arXiv:2402.03610 + LLMCompiler arXiv:2312.04511): exemplarIsSelfConsistent withholds a cached plan whose own steps fail validateStepDependencies (a dangling {{stepN}} ref that selectSuccessfulPlanSteps can leave after filtering a mid-step) before injecting it as a planning exemplar; withhold-only, reuses the conservative ref extractor — agent-core-cognition fire 37

- ✓ DINCO preference-confidence calibration (arXiv:2509.25532): inferred persona traits now distractor-normalize their verbalized confidence (cal=c_orig/(c_orig+Σc_distractors)) — a trait that doesn't dominate self-generated incompatible alternatives is dropped, survivors get the less-saturated value; opt-in (prod sets it), fail-soft, applied after the accept gates — agent-core-cognition fire 36

- ✓ outcome-quality episode write-admission (selective addition, arXiv:2505.16067): captureEndOfSessionEpisode now refuses to store an ERROR-PRONE session (corrections > approvals) so its botched outcome can't replay via experience-following; the lesson survives (corrections distilled to playbook separately); subtractive, default-admit on tie/no-signal — agent-core-cognition fire 35

- ✓ commissive-force self-followup gate (arXiv:2502.14321): the capture hook now queues a followup only when a first-person commitment ("I'll … tomorrow") governs the time phrase's sentence, not a bare description ("your meeting is tomorrow") — stops spurious reminders the assistant never promised; opt-in (hook sets requireCommissive), EN-only, subtractive — agent-core-cognition fire 34
- ✓ csv_parse ragged-long-row silent data-loss (data-integrity, @muse/tools): in header mode a data row with MORE cells than the header row silently DROPPED the surplus — the map loop only iterated `index < headers.length`, so "Alice,30,extra1,extra2" under headers "name,age" returned `{name,age}` and the extra cells vanished with no signal (an incomplete row presented as the complete row = fabrication-adjacent). Surplus cells are now preserved under an `_extra` array (overflow key suffixed `_` until collision-free, so a column literally named `_extra` keeps its value); well-formed CSVs byte-identical, short rows still "" -padded. Gap-scout found (signals clean → data-tool robustness). ④b PASS (mutation-sensitive: revert → both tests fail; collision-safe; type contract holds). — tool-hardening fire 148
- ✓ csv_parse duplicate-header collapse (DONE): `createCsvParseTool` now de-duplicates colliding header names before keying rows (`id`,`id`→`id`,`id_2`; two empty `""`→`""`,`_2`; suffix loops until unique, and the `_extra` overflow key avoids the de-duped set too), so a shared/empty header no longer silently overwrites the earlier cell. Returned `headers` reflect the de-duped keys (no-op for ordinary CSVs). @muse/tools 268 tests (incl. a new dup-header case) + full check + lint green.

- ✓ korean_age EXPANSION — Korean age (만/세는 나이) from a birthdate (user-specific grounding, @muse/tools): Korea has three age reckonings and the 12B conflates them + drops the "birthday not yet passed this year" subtraction. New korean_age tool: birthdate → 만 나이 (international, legal standard since June 2023) + 세는 나이 (counting age, year-diff+1); Date round-trip rejects impossible/future birthdates; leap-day birthdate handled. Wired (createMuseTools, 25 tools). eval STABLE 3/3 ×6 (KO 만/세는 + EN + korean_number/math_eval carve + IrrelAcc). ④b PASS 5/5 (algorithm + boundary + leap-day independently verified, 2023-law claim accurate). Balances the value-class (EXPANSION after a correctness streak). — tool-hardening fire 145
- ◦ value-class watch (judge-noted fire 145): @muse/tools is at 25 tools, several user-locale (Korean) utilities. korean_age earns its place (real model-failure class) but FUTURE EXPANSIONs should diversify away from more user-locale tools — prefer a different value-domain or a non-tools surface.
- ✓ memory cross-namespace data-loss on retraction (data-integrity, @muse/memory — the "Tell it everything" core): the auto-extractor's DELETE branch called `forget(userId, key)` without the `kind` it had in scope, and `forget` deleted the key from BOTH facts AND preferences — so an auto-extracted FACT retraction ("I don't have a pet anymore") silently wiped a same-key PREFERENCE ("I prefer dogs") the user never retracted (facts/prefs routinely collapse to one normalized key: pet/city/name…). Added optional `kind` to `forget` (namespace-scoped delete when given; dual-delete preserved when omitted for explicit /forget) in both InMemory + File stores + the interface; auto-extract DELETE now passes `kind`. ④b PASS 5/5 (truth table verified in both stores, mirror case, backward-compat). — tool-hardening fire 143
- ✓ classifyMemoryOperation spurious-delete on a never-stored key — core-hardening fire 8 (@muse/memory, integrity): a retraction token for a key with `existing===undefined` returned "delete", making auto-extract call `store.forget()` on a non-existent key (a real state-mutating call — File/Kysely backends touch persistence). Fix: `existing === undefined ? "noop" : "delete"` — a NOOP produces zero side effects (Mem0 discipline). Covers BOTH fact + preference namespaces (shared classifier). OUTCOME + mutation-first verified (unit + integration forget-spy asserting 0 calls; @muse/memory 456 tests + Opus ④b PASS, all branches walked, no legitimate deletion suppressed).
- ✓ memory key-normalization parity InMemory/Kysely vs File (cross-store consistency, @muse/memory): InMemory/Kysely `upsertFact`/`upsertPreference` stored the RAW key while the File store normalized — so a fact fragmented by backend AND auto-extract's normalized `current` lookup missed raw-stored values → mis-classified a re-confirmation/update as a spurious ADD (broken Mem0 dedup) on the API-server (Kysely) + in-memory backends. Normalized the key on write in both (parity with File); made InMemory.forget resolve raw-OR-normalized so the fire-143 namespace-scoping still finds canonicalized entries. ④b PASS 5/5 (mutation-tested, File parity, Korean-key idempotency intact, forget×kind interaction correct). Honest: CLI/File path 진안 uses was already correct — server/consistency hardening. — tool-hardening fire 144
- ✓ date-diff fast-path impossible-date grounded-lie (correctness, apps/cli): `detectDateDiffQuery` (the deterministic `muse ask` "days between X and Y" fast-path that BYPASSES the model + grounding gate because it's meant to be exact) accepted impossible dates — `parseLiteralDate` only guarded day 1–31 (month-name) and had NO check (ISO), so "February 30"/"April 31"/non-leap "Feb 29"/ISO "2026-02-30" rolled via `new Date(y,m,d)` into the next month → "29 days between Feb 1 and March 2" (a date never typed). Added a `realDate` round-trip validator to BOTH branches → impossible dates return null → falls through to recall (precision-first). ④b PASS 5/5 (node-verified, leap-day preserved). — tool-hardening fire 141
- ✓ date-diff cross-year-roll grounded-lie (correctness, apps/cli): `detectDateDiffQuery`'s cross-year roll (`new Date(b.year+1, …)`) bypassed realDate — a year-less "Mar 1 to Feb 29" in a leap now-year rolled Feb 29 into a non-leap year → silently Mar 1 → "365 days to March 1, 2029" (a date never typed). Hoisted realDate to module scope and validate the roll → an impossible roll returns null (declines → recall). Normal cross-year rolls (Dec→Jan, Jun→Mar) preserved; only a year-less Feb 29 into a non-leap target declines. ④b PASS 5/5 (no over-rejection, fire-141 fix intact). Completes the fire-141 grounded-lie across both date-diff paths. — tool-hardening fire 142
- ✓ leap_year EXPANSION + JUDGE-DRILL (grounding, @muse/tools): new deterministic leap_year tool (Gregorian: ÷4 except a century ÷100 is leap only if ÷400) — the 12B reliably gets ÷4 but trips on the century exception (1900/2100/2200 NOT leap; 2000/1600 ARE), exactly where a deterministic check grounds the answer. Wired (createMuseTools, 24 tools). eval STABLE 3/3 ×6 (EN/KO + Feb-29 + math_eval/number_base carve + IrrelAcc). ④b PASS 5/5 (century exception regression-locked, independently verified). Also the fire's JUDGE-DRILL: injected the naive %4 rule (grounded-lie: 1900→leap) → ④b FAILed it (ran node, caught wrong values + a test that encoded them) → fixed to full Gregorian. — tool-hardening fire 138
- ✓ grounding-verdict hedge-then-assert fail-open (fabrication-floor, @muse/recall): `groundingVerdictNotice` short-circuited the hard grounding verdict on `answerIsRefusal` — a SUBSTRING test — so "I don't have access to flights, but your flight is at 9am from Gate 22" matched the refusal substring and rode through labeled `grounded`, the fabricated claim unflagged. New `answerIsPureRefusal` (splits on sentence/adversative seams EN+KO, false if any non-refusal clause carries ≥2 tokens) gates only the hard verdict; the 14 advisory sites keep lenient `answerIsRefusal`. Hedge-then-assert now reaches the verdict (which flags the fabrication / passes a grounded hedge). Conservative bias (over-warn, never block). ④b PASS 5/5 (mutation-sensitive, no regression). — tool-hardening fire 137
- ✓ widen answerIsPureRefusal — em-dash/colon seams + NEGATION-aware skip (grounding floor, @muse/recall): resolved the fire-139 BLOCK the robust way. Added `:—–―` to CLAUSE_SPLIT_RE AND skip a clause if it's a refusal OR contains a negation (no/not/never/none/nothing/n't + KO 없/모르/안/못) — so a refusal's NEGATIVE continuation across the new seam ("I'm not sure — that isn't in your notes") stays pure (the fire-139 regression) while a POSITIVE assertion ("— your flight is at 9am") is caught. Also fixed an existing fire-137 KO false-positive ("없어요. 회의 자료는 못 찾았어요." was wrongly flagged). recall 40 files + cli consumers green. ④b PASS 5/5 (9/9 cases node-verified, net-positive). — tool-hardening fire 140
- ✓ negation-DOMINATED refinement — digit-aware negation skip (fabrication floor, @muse/recall): closed the fire-140 unsafe-direction residual where a hedge whose tacked-on claim CONTAINS a negation ("…your meeting is NOT at 3pm, it's at 4pm in room 5") slipped as pure. A negated clause is now skipped as a refusal restatement ONLY if it carries NO concrete data (no digit); a negation WITH a digit is a corrected ASSERTION → reaches the verdict. 18-case node pre-verified; all fire-139/140 invariants intact. ④b PASS 5/5 (over-warn only/safe-direction; non-digit named-entity negated fabrication stays open = the existing "named-entity drift" item, NOT a regression). Completes the answerIsPureRefusal arc (137→140→146). — tool-hardening fire 146
- ◐ non-digit named-entity fabrication — NEGATION→CORRECTION pivot DONE, positive-only drift + KO no-space remain: the "…your manager isn't Alice, it's Bob" pivot (a corrected named value smuggled past the negation with no digit) is now caught — `NEGATION_CORRECTION_RE` in `packages/recall/src/text.ts`, checked in `answerIsPureRefusal` BEFORE the refusal/negation skips so it fires even on a comma-only join, with a lookahead so "that's not…"/"it's in your notes" stay pure (no false-drop). 287 recall tests + 2 new blocks; full check + lint green. RESIDUAL (still needs an NER/NLI signal, not deterministic): a PURELY positive named-entity assertion inside a hedge with no negation pivot ("I'm not sure. Your manager is Bob.") — "Your manager is Bob" reaches the token test and IS caught when seam-split, but a hedge that's `answerIsRefusal`-true on the whole comma-joined clause can still skip it. Also `안\s`/`못\s` still miss no-space `안돼`/`못해` (a stricter-toward-verdict miss, not a fabrication leak). (judge-noted fires 140/146; pivot closed this fire)
- ✓ number_base EXPANSION — radix conversion binary/octal/decimal/hex (developer grounding, @muse/tools): the 12B mis-computes multi-digit radix conversions; no existing tool does numeric base (base64=byte encoding, math_eval=operators). New number_base tool: BigInt-exact (a 16-hex-digit value floats under parseInt — grounded-lie prevented), 0x/0b/0o prefix + negative sign, from/to as a 4-value enum. Wired (createMuseTools, 23 tools). eval STABLE 3/3 ×6 (3 directions + math_eval/unit_convert carve + IrrelAcc). ④b PASS 5/5 (BigInt-exactness independently confirmed vs parseInt float-loss). — tool-hardening fire 136
- ◦ all-day-event date convention audit (packages/calendar, DEFERRED — convention-ambiguous, NOT a clean 1-fire bug): `ics-export.ts dateStamp` (+ caldav `formatIcsDate`, google `toIsoDate`) use `toISOString().slice(0,10)` (UTC) for a VALUE=DATE all-day stamp. A LOCAL-midnight all-day Date in KST would export the previous day — BUT the existing test + caldav/google READS (`parseIcsTime`→T00:00:00Z) all assume UTC-midnight all-day storage, making the UTC-slice internally CONSISTENT (the local store round-trips through ICS text via parseIcsCalendar). Fixing dateStamp to local-components would break the consistent UTC convention + the existing UTC-midnight test on a non-KST CI. REQUIRES first auditing the actual all-day storage convention across loopback-calendar(parseIsoDate)/local-ics-provider(parseIcsCalendar)/caldav/google/macos and unifying it — then fix the serializers to match. Scouted+adversarially-verified fire 136 (scout over-indexed on the macOS local path).
- ✓ weather cross-timezone forecast-date bug (correctness/grounding, @muse/mcp): the tool resolved a relative `when` ('today'/'tomorrow') in the SERVER's tz (localDateIso → getFullYear/Month/Date) then matched it against forecast days dated in the LOCATION's tz — so a KST user asking 'weather in LA tomorrow' got the WRONG calendar day or a false 'no forecast' (grounded-lie). New isoInZone(instant, tz) (ICU, machine-independent) + resolveForecastLine now resolves a relative target in location.timezone; explicit ISO dates stay tz-independent. Removed resolveTargetDateIso/localDateIso. eval n/a (selection unchanged). 195 mcp files green. ④b PASS 5/5 (isoInZone incl. DST verified, fire-130 invalid-date preserved). — tool-hardening fire 135
- ✓ weather geocode ambiguity — region (admin1) disambiguation + JUDGE-DRILL (grounding, @muse/mcp): geocode surfaced only name+country, so 'Springfield' (every US hit → "Springfield, United States") gave no signal WHICH city — a wrong-place forecast read as a grounded fact. Captured the real `admin1` region field into GeocodedLocation + a shared `formatPlace` ("City, Region, Country") used by both formatWeather and resolveForecastLine; region shown ONLY when the API returns a distinct admin1 (absent ⇒ omitted, no fabrication; admin1==name ⇒ dropped so Seoul isn't "Seoul, Seoul"). Springfield IL vs MO now render different lines (real disambiguation). ④b PASS 5/5 (mutation-sensitive, no collateral). Also the fire-147 JUDGE-DRILL (axis: wrong-source grounded-lie — region read from country_code "US" not admin1 "Illinois", with a complicit test): gates passed → independent Opus judge FAILed it (caught the false region + a production Seoul regression) → rolled back → this real fix. — tool-hardening fire 147
- ✓ epoch_convert EXPANSION — Unix timestamp ↔ calendar date (developer grounding, @muse/tools): the 12B fabricates the date for a given epoch (large-number date arithmetic, a known LLM failure); none of the existing time tools convert a GIVEN epoch (time_now emits the current one; time_diff/add work on ISO). New epoch_convert tool: a number → its UTC date (auto-detecting sec vs ms by 1e12 magnitude); a date → its epochSeconds + epochMillis. Bidirectional, returns all forms. Wired (createMuseTools, 22 tools). eval STABLE 3/3 ×6 (both directions + time_now/time_diff carve + IrrelAcc). ④b PASS 5/5 (algorithm + boundary probes independently verified). — tool-hardening fire 134
- ◦ epoch_convert optional `unit` hint (sec/ms): the 1e12 auto-detect threshold misclassifies a MILLISECOND timestamp dated before 2001-09-09 (→ misread as seconds, wrong far-future date). Vanishingly rare in real logs, honestly docstring-scoped, but an optional `unit` enum (auto/seconds/milliseconds) would let a caller disambiguate the rare case explicitly. (noted fire 134, judge non-blocking)
- ✓ korean_number EXPANSION — Korean myriad-unit (만/억/조) number formatting (user-specific grounding, @muse/tools): the 12B groups by Western 3-digit commas and mis-places the 만/억 boundary, so a deterministic transform grounds it (평/lunar-class win for KO user 진안). New korean_number tool: Arabic integer → "1234만 5678" / "1억 2000만"; 4-digit chunking, zero-chunk omission (100000005→"1억 5", unambiguous vs "1억 5만"), negatives, beyond-경→error. Wired (createMuseTools, 21 tools). eval STABLE 3/3 ×6 (selection + value arg + unit_convert/math_eval carve + IrrelAcc). ④b PASS 5/5 (algorithm independently verified). — tool-hardening fire 131
- ✓ korean_number reverse — bidirectional (Korean WORDS → digits, '1억 2천만' → 120000000): extended the SAME korean_number tool (not a confusable sibling) to parse a Korean myriad expression back to an integer — digit chunks, 천/백/십 sub-units + compounds (천만=10⁷), trailing 원, grouping commas. Auto-detects direction (a string with [조억만천백십] → reverse), always returns {value, korean}. Schema widened to a Gemini-safe string `value`. eval STABLE 3/3 ×8 (3 forward + 2 reverse + unit_convert/math_eval carve + IrrelAcc). ④b PASS 5/5 (reverse parser independently verified + round-trip property). — tool-hardening fire 132
- ✓ weather tool invalid-calendar-date echo (correctness/grounding, packages/mcp): `resolveTargetDateIso` matched the `\d{4}-\d{2}-\d{2}` shape but never validated the date, so a 12B date-arithmetic slip ("2026-02-30"/"2026-13-45") was echoed to the model as `date: "2026-02-30", reason: "no forecast for that day (… out of range)"` — asserting an impossible day is a real day out of range (grounded-lie hook). Added `isValidCalendarDate` (Date.UTC round-trip) so invalid dates route to the existing honest "couldn't understand the day" path and never reach the provider; valid dates incl. leap-day + full-ISO prefix unaffected. ④b PASS 5/5 (mutation-checked). — tool-hardening fire 130 (also JUDGE-DRILL: injected declaration-only padding → ④b FAILed it → rolled back → this real fix)
- ✓ remember_fact Korean-key drop (correctness/data-integrity, packages/mcp): the durable-memory write actuator slugged its key with an ASCII-only `[^a-z0-9_]` filter, so a Korean key ("취미") → "" → error/no-write and "내 취미" → garbage "_" — silently breaking the memory promise for the KO-default model. Delegated to the store's canonical `normalizeMemoryKey` (keeps Unicode, matches the production file store, idempotent) guarded by a `/[\p{L}\p{N}]/u` letter/digit check (so "!!!"/"___" still refuse). ④b PASS 7/7. — tool-hardening fire 128
- ✓ `/remember key=value` Korean-key drop (apps/cli, the interactive slash command 진안 types): `parseRememberArg` had the SAME ASCII `[^a-z0-9_]` slug bug as remember_fact — `/remember 취미=등산` stripped the key to "" → returned undefined → "Tell me what to remember…", saved nothing. Delegated to `normalizeMemoryKey` + `/[\p{L}\p{N}]/u` guard (matches fire 128, round-trips with /forget + /memory which use the same normalizer). ④b PASS 7/7. — tool-hardening fire 129
- ✓ lunar_date EXPANSION — Korean 음력 calendar (model-impossible, user-specific): Korean users carry lunar birthdays + holidays (설날=음1/1, 추석=음8/15) and the 12B can't compute the lunar calendar. New lunar_date tool converts solar→Korean lunar via ICU 'dangi' (Node Intl, the authority — no grounded-lie risk), Asia/Seoul timezone, marks 윤달. Verified exact against 설날/추석 2025+2026, 단오, 윤6월 2025, KST boundary. Carve STABLE 3/3 ×6 (model selects lunar_date for '오늘 음력 며칠', routes SOLAR '오늘 며칠'→time_now, 설날 greeting→no tool). Wired (createMuseTools). ④b PASS 9/9. — tool-hardening fire 126
- ✓ lunar_to_solar EXPANSION — Korean 음력→양력 (the inverse, the #1 real query "음력 생일이 올해 양력으로 며칠?"): completes the bidirectional lunar pair. New lunar_to_solar tool searches forward from solar Jan 1, matching each day's ICU dangi value to the target lunar M/D + leap flag; returns the exact solar date or an honest error for a non-existent lunar date. ④b judge FAILed the first cut (400-day bound silently turned 음 12/29·12/30 of leap years into a false "no such date" — a grounded lie); fixed to a 460-day bound PROVEN by a 36,525-day round-trip (every real lunar date 2000–2100, 0 misses) + a RED test pinning 음2026 12/30→2027-02-06. Carve STABLE 3/3 ×6 (model picks lunar_to_solar for 음력→양력, routes the reverse 양력→음력→lunar_date, birthday-meal musing→no tool). Wired (createMuseTools, 20 tools). ④b re-judge PASS (independent 36,890-day round-trip). — tool-hardening fire 127
- ✓ unit_convert area + Korean 평/pyeong (user-specific grounding): Muse's user (진안) is Korean and asks area in 평 ('30평 아파트는 몇 ㎡?'); the 12B mis-recalls 1평 = 400/121 = 3.305785…㎡, so a deterministic tool grounds it. Added the AREA category (m2/km2/cm2/mm2/ha/ft2/in2/yd2/acre/평) with exact factors (평 = 400/121, NOT rounded — judge verified to full float). Carve STABLE 3/3 ×9 (model selects unit_convert for '30평은 몇 제곱미터', recognizes 평 as a unit). area↔length throws. ④b PASS 8/8. — tool-hardening fire 125
- ✓ unit_convert speed + time-duration categories (completeness extension): unit_convert (fire 123) errored on "100 km/h in mph" (driving abroad) and "90 minutes in hours" — added SPEED (m/s, km/h, mph, kn, ft/s) + TIME (s, min, h, day, week) with exact factors; the 12B rounds the 0.621 km/h↔mph factor, so a deterministic tool grounds it. Carve STABLE 3/3 ×8 (model selects unit_convert for speed/time, no time_diff confusion). Cross-category still throws. ④b PASS 8/8. Discovered: timezone is ALREADY covered (time_now takes a timezone arg + world_time tool) so NO timezone tool needed. — tool-hardening fire 124
- ✓ unit_convert EXPANSION (new capability, breaks the EXPANSION-0 drought since fire 107): after ~22 fires saturated the personal-store domain, expanded the zero-IO utility family with a genuinely missing non-confusable tool — deterministic physical-unit conversion (length/mass/volume/temperature, exact factors + temperature offset). Fits Muse's grounding edge: "5 mi = 8.04672 km" exactly, not the 12B's "≈8 km". Wired into createMuseTools (autoconfigure index.ts:542). Carve held STABLE 3/3 ×6 (3 positive + math_eval/web-search confusable not crossing + "I ran 5km today" IrrelAcc). ④b PASS 8/8 (judge independently re-derived every factor — no lying conversion). — tool-hardening fire 123
- ✓ messaging.send over-fire guard + JUDGE-DRILL (fire 120): muse.messaging.send (risk:write, an outbound chat DM via Telegram/Discord/Slack/LINE, wired in loopback-tools.ts) had ZERO eval coverage — the 3rd outbound channel after email_send (116) and mac_message_send (118). Added buildMessagingSendScenario (2 selection channel/handle + 1 confusability + 2 IrrelAcc incl. "Bob한테 메시지 보낼까 말까 고민 중이야" → NO tool). STABLE 3/3 ×5. This COMPLETES the over-fire coverage trilogy across all 3 outbound channels (email/iMessage/chat DM). No live bug (abstains like the other two). Also the fire-120 JUDGE-DRILL: a cosmetic email_send "reply"-keyword removal + a declaration-only test was injected → ④b judge correctly FAILed it (ran both eval arms to prove no behavioral delta) → rolled back. ④b PASS 8/8 (real fix). — tool-hardening fire 120
- ✓ mac_message_send over-fire guard (agent-testing.md hardening, outbound channel): the macos-actuators scenario covered mac_message_send positively but its over-fire IrrelAcc cases were all for mac_shortcut_run — the OUTBOUND iMessage channel (same risk class as email_send) had no over-fire guard. Added the deliberation tripwire "Bob한테 문자 보낼까 말까 고민 중이야" (debating whether to text Bob → NO tool, parallel to the email_send guard fire 116) + a media-comment negative. STABLE 3/3. No live bug (mac_message_send abstains like email_send). ④b PASS (qualified): closes the last unguarded outbound channel, but the high-value eval-coverage seam is NEAR-TAPPED. — tool-hardening fire 118
- ✓ outbound email tools eval coverage (agent-testing.md hardening, highest-risk class): email_send/reply/forward (risk:execute, a message to a THIRD PARTY) had ZERO eval coverage. Added buildEmailSendScenario exposing the full email suite (send/reply + recent/search/read + find_contact, representative per the fire-114 lesson) — 2 selection + 1 confusability + 3 IrrelAcc, incl. the make-or-break "Bob한테 이메일 보낼까 말까 고민 중이야" (debating whether to email Bob → NO tool, an outbound-safety over-fire tripwire). STABLE 3/3 ×6. No live bug: unlike remove_contact (fire 115), the outbound tools do NOT over-fire on casual email statements. CAUTION: 3rd consecutive eval-coverage slice (114/115/116) — diversify KIND next fire. ④b PASS 8/8. — tool-hardening fire 116
- ✓ remove_contact eager-invocation on a relationship statement (LIVE over-fire, destructive tool): the contacts WRITE CRUD (add/remove) had no eval coverage; building it (buildContactsCrudScenario) surfaced a real bug — remove_contact fired 0/3 on "이제 Bob이랑 안 친해" (I'm not friends with Bob anymore), proposing to DELETE the contact on an emotional statement (old desc "delete / forget a contact" steered "forget"→"안 친해"). Deletion is irreversible = costliest false-positive. Sharpened the description to fire ONLY on an explicit delete COMMAND + a "do NOT use for a relationship/feelings statement" line. Post-fix "안 친해"/"싸웠어"→NO tool while "delete Bob"→remove_contact, STABLE 3/3 ×8. METHODOLOGY WIN: the eval-coverage audit found a real live bug, not just coverage. ④b PASS 8/8. — tool-hardening fire 115
- ✓ remember_fact eval coverage (agent-testing.md hardening, write tool): remember_fact (risk:write, persists durable facts/prefs) had ZERO eval:tools coverage. Added buildRememberFactScenario with the full triad — 3 selection + 2 confusability (its own "do NOT use for" tasks.add/notes.save) + 3 IrrelAcc (fleeting statements like "방금 커피 마셨어" → NO tool, the memory-pollution tripwire). STABLE 3/3 ×8. No live bug (probe confirmed correct behavior). LESSON: an all-namespaced eval neighbour set manufactured a FALSE selection failure (12B invented "muse.facts.add"); a representative flat+namespaced mix is required. ④b PASS 8/8. — tool-hardening fire 114 (took blocker candidate b)
- ⚠ tool-hardening DIRECT-BUG vein source-level EXHAUSTED (fire 113, 2nd consecutive clean scout): per-tool correctness/security veins done (SSRF mapped/compatible/SIIT/NAT64; calendar add+read *Iso→neutral; relationship substring; Feb-29; tasks.add dueAt; find_items), AND a 174k-token source-level scout of the meta-tool areas found them all hardened — approval/outbound gates fail-close (executeToolCall try/catch, *WithApproval, messaging double-deny), MCP risk-restamp wired+correct (withOfficialMcpRisk, already tested ×3), relevance filter hardened (word-boundary/relevance-first/CJK), arg validation re-checks enums in handlers. No non-confusable EXPANSION gap. UPDATE fire 117: candidate (b) eval-coverage audit RAN (fires 114-116) — covered every write/execute tool (remember_fact / contacts CRUD / email outbound) and found a real over-fire bug (remove_contact 115); that HIGH-VALUE portion is now ALSO done. Remaining eval-coverage is READ tools only (low harm). email handler + on_this_day Feb-29 re-examined fire 117 = clean/defensible. Both the direct-bug AND high-value eval-coverage veins are tapped. UPDATE fire 121: WIRING value-class also dry (autoconfigure tools all assembled in index.ts; outbound send tools wired with gate+actionLog in actuator-tools.ts — no inert tool, gates correct). 21-fire personal-store domain SATURATED. Next: (a) low-value read-tool eval coverage (accept KIND-monotony), (b) a 진안-blocked lever, (c) 진안 broadens/pivots the theme. — tool-hardening (blocker, updated fire 117)
- ✓ calendar read tools fromIso/toIso → from/to (P45-20 live fix): the list/availability/conflicts tools named their range fields *Iso, steering the 12B to pre-compute a timestamp — and for "이번 주" (this week) it hallucinated a WRONG-YEAR ISO ("2025-01-24…", today 2026) → parseIsoDate ran availability over Jan-2025 (eval phrase-assertion 0/3). Calendar ADD was fixed (startsAt) but the READ tools were missed. Renamed model-facing fields to neutral from/to; handler reads `from ?? fromIso` (HTTP/CLI back-compat). Model now passes the phrase verbatim → STABLE 3/3 across all three tools. LESSON: when a scout flags a *Iso residual as "uncertain RED", PROBE it (eval REPEAT=3) — the probe found a real wrong-year bug the scout under-rated. ④b PASS 7/7. — tool-hardening fire 112
- ✓ overdue_contacts name-substring false match (correctness, harmful-direction): interactionsFromEvents matched a contact name with raw event.text.includes(name) — "Ann" hit "pl·ann·ing", "Sam" hit "Sam·sung" — injecting a spurious recent interaction that collapses the gap-since-last-contact and SILENTLY DROPS the genuinely-overdue person from "who have I lost touch with?". Now an ASCII name matches whole-word only (mirrors promptHasHint); a non-ASCII name (Korean) keeps substring because particles attach directly ("민지랑"). Metachar names escaped. Verified through the tool's terminal state; ④b PASS 7/7. — tool-hardening fire 111
- ✓ conformity-flip council caution (arXiv:2606.00820): detectConformityFlips flags a peer that reached agreement by ABANDONING its own prior stance (self-cosine reversal + moved toward panel); muse swarm council warns “conformity-driven agreement” when the panel agreed via a flip (57-77% correct→wrong); semantic, advisory-only (never alters answer), agreed-only gated — agent-core-cognition fire 33

- ✓ CBR case-density playbook gate (arXiv:2504.06943): the embed-rank playbook drops an isolated (no semantic neighbors) + unproven + SYNTHETIC (reflected) strategy as a sparse-region low-confidence guess; grounded/manual corrections NEVER dropped (wedge), semantic cosine density, never-empty guard; fixed the origin projection seam (PlaybookEntryLike/toPlaybookStrategy) that made it + the reflected penalty inert — agent-core-cognition fire 32

- ✓ dead-code @muse/cli + JUDGE-DRILL: de-exported 2 internal-only functions — MuseStatusTui (tui.ts, used only at tui.ts:122 via React.createElement) + defaultSpeakerShells (voice-playback.ts, used only as a default param at line 40); both knip-flagged, no external/test importer (visibility narrowing, internal use intact). Also the 8th JUDGE-DRILL (NEW axis: dropped-guard / false-no-op via ??): an in-place "simplify applyOptional" that removed `if (next === null) return undefined` claiming redundancy — but `null ?? existing → existing`, so null (the CLEAR-field sentinel) would silently KEEP the old value in the untested CalDAV update path; gates passed (156 calendar tests green, the clear-via-null path untested), the independent judge correctly FAILed it (reasoned the ?? semantics + found the applyOptionalString/Array sibling twins prove null=CLEAR) → rolled back. — codebase-quality fire 105
- ✓ decompose @muse/calendar: extracted the iCalendar (ICS) codec (~18 helpers: renderVEvent/parseVEvent + the CalDAV calendar-query REPORT XML + ICS line folding/escaping + the TZID/all-day timezone-wall-clock↔UTC math + XML decoding) out of the 492-LOC caldav-provider.ts → new caldav-ics.ts (provider class now 246 LOC). The cluster (246-492) is PURE + self-contained (only randomUUID + Calendar types — no class/`this` ref, diff-verified), so acyclic; the CalDAVCalendarProvider class imports back the 3 it uses (renderCalendarQueryReport/renderVEvent/parseCalendarQueryResponse), ics-parse.ts repointed its parseVEvent import, the rest stay file-private. applyOptional (a generic field-merge, NOT ICS) correctly left in the class. randomUUID/Buffer kept in the class (both still use them). +4-case OUTCOME test (render↔parse round-trip, all-day flag, undefined-on-garbage, query-report XML). Separates the ICS serialization from the CalDAV HTTP protocol. — codebase-quality fire 104
- ✓ decompose @muse/api: extracted the multi-agent WORKER-agent factories (createWorkerSummarizer / createAnswerVerifier / createWorkerSynthesizer + their dedicated system-prompt/token/timeout consts) out of the 764-LOC multi-agent-routes.ts → new multi-agent-workers.ts (routes now 636 LOC). The cluster (637-764, contiguous) is self-contained — its ONLY external dep is the ModelProvider type — so the extraction is acyclic (workers imports nothing from routes). routes imports the 3 factories back (used by the route handlers); the 2 test files (multi-agent-synthesizer.test, multi-agent-sse-stream.test) were REPOINTED to the new module (no re-export needed). ModelProvider stays imported in routes (still used by MultiAgentRouteOptions). Separates agent-construction from route wiring. 9 factory tests green at the new home. — codebase-quality fire 103
- ✓ decompose @muse/mcp: extracted the proactive-notice PERSISTENCE cluster (the session-lock file + the fired-notice dedup ledger — ProactiveFiredKind/ProactiveFiredEntry/SessionLockPayload + writeSessionLock/readSessionLock/readProactiveFired/writeProactiveFired/isProactiveFiredEntry/firedKey) out of the 863-LOC proactive-notice-loop.ts → new proactive-notice-store.ts (loop now 729 LOC). The block is self-contained (only node:fs/path) so acyclic; proactive-notice-loop imports the ones runDueProactiveNotices uses + RE-EXPORTS all 8 public symbols from the store, so the mcp index re-export chain + every external consumer (cli commands-session/status/proactive, loopback-status, tests) stay unchanged. Removed the now-unused node:fs/path imports from the loop. +5-case OUTCOME test (session-lock active/expired/missing, fired-ledger round-trip/missing, firedKey unambiguity). — codebase-quality fire 102
- ✓ decompose @muse/autoconfigure: extracted the turn-analysis cluster (scanCommitmentsFromTurns — commitment→check-in scan; inferPreferencesFromTurns — correction→preference inference; the server/daemon cores of the CLI's session-end learning) out of context-engineering-builders.ts → new context-engineering-turn-analysis.ts (609→527 LOC). Acyclic: the 2 fns are leaf exports (not called internally), so the new module imports their deps incl. createGateEmbedder from context-engineering-builders one-directionally; index.ts + the wiring test were REPOINTED to the new module (no re-export, so no cycle). 10 now-unused imports trimmed from context-engineering-builders. egressGuards stays 7 (createOllamaEmbedder's LocalOnlyViolationError guard untouched — the turn-analysis fns have no guard). 9-case wiring test now exercises the new home. — codebase-quality fire 101
- ✓ cohere @muse/mcp: consolidated the 2 byte-identical `medianGap(values)` copies (note-family-absence.ts + personal-episodes-store.ts — both find a family/episode-series' typical inter-event gap) into a new shared median-gap.ts; each cadence detector imports it. Verified identical (diff) + file-private + each called once. Kept medianGap's internal-sort (mcp doesn't depend on @muse/agent-core, so it can't reuse fire-99's median(sortedAscending), and median isn't barrelled). +4-case OUTCOME test (empty→0, sorts-unsorted-input, even-average, outlier-robust). [Earlier this fire: a recall COMPOSE of relevantExcerpt (commands-recall.ts) was rejected — it's coupled to a cli-LOCAL lexicalOverlap (recallContentTokens + fraction) that differs from @muse/agent-core's (lexicalTokens + raw count), so moving it to recall would change behavior.] — codebase-quality fire 100
- ✓ cohere @muse/agent-core: consolidated 3 byte-identical `median(sortedAscending)` copies (relationship-decay.ts cadence + activity-anomaly.ts & change-point.ts modified-z-score/MAD) into a new shared median.ts; each detector imports it instead of hand-rolling. The 3 copies were verified identical (diff) and file-private; each caller pre-sorts so the O(1)-pick contract is preserved. +4-case OUTCOME test (empty→0, odd-middle, even-average, the unsorted-input contract). NOTE: a related `medianGap` in mcp (note-family-absence/personal-episodes-store) is a DIFFERENT function (sorts internally) — left alone. — codebase-quality fire 99
- ✓ dead-code @muse/api: de-exported `currentAuthIdentity` in compat-user-memory-store.ts — knip-flagged unused export, used ONLY internally (line 103 of the same file, by the bearer-identity compat check); no external importer (the admin test only mentions it in a comment). Visibility narrowing, no behavior change; api build + 145 test files + knip clean. — codebase-quality fire 98
- ✓ embedder cohere (codebase-quality, was fire-98 BLOCKER → DONE with 진안's authorization to touch self-eval.mjs): `createOllamaEmbedder` + `createGateEmbedder` moved from `context-engineering-builders.ts` into their natural home `embedder-base.ts` (next to `resolveEmbedderBase`); context-engineering-builders re-exports them so every import site stays byte-identical, and 4 now-stale imports were dropped (`LocalOnlyViolationError`, `isLoopbackUrl`, `createCachingEmbedder`, `resolveEmbedderBase`). The egressGuards ratchet was the original blocker — resolved by adding `embedder-base.ts` to `scripts/self-eval.mjs` `egressSources` (the human-directed infra line) so the moved `LocalOnlyViolationError` throw-site stays counted: egressGuards held at **7** (no false regression). Verified: full `pnpm check` + `pnpm lint` + `pnpm self-eval` green.
- ✓ dead-code @muse/cli + JUDGE-DRILL: removed 2 dead re-exports through commands-doctor.ts — the `CalibrationReport` type re-export (line 17) and `readOllamaPerfEnv` from the checks re-export (line 26); both knip-flagged, verified no consumer imports them via the commands-doctor barrel (the test pulls buildCalibrationReport/formatCalibration; the underlying defs + readOllamaPerfEnv's internal import/use stay). Also the 7th JUDGE-DRILL (axis: load-bearing-WHY-deletion disguised as comment-hygiene — removed 2 security-WHY comments from memory-auto-extract-sanitize.ts framed as "self-documenting"; gates passed; the independent judge correctly FAILed it → rolled back). — codebase-quality fire 97
- ✓ comment-hygiene (recall/mcp/cli): removed the last forbidden goal/orphan-comment rot in safe packages per code-style.md — stripped the (P37-20)/(P37-21) goal-ref markers from recall/select.ts (kept the load-bearing field list), the "P43-1" marker from mcp/personal-playbook-store.ts (kept the encryption WHY), and the orphaned "Prepend the ACE [Learned Strategies] block" doc comment in commands-ask.ts (the fire-92 finding — documented a long-relocated function). The marker vein is now exhausted outside the hot agent-core. Comment-only, behavior-preserving. — codebase-quality fire 96
- ✓ decompose @muse/memory: extracted the LLM-extracted-memory input-sanitization cluster (sanitizeSlotArray/sanitizeEntries entry points + sanitizeValue/normalizeKey internals + the ExtractedSlot type — the anti-memory-poisoning boundary that caps count/key/value lengths, normalizes keys, strips terminal-control bytes) out of the 696-LOC memory-auto-extract.ts → new sibling memory-auto-extract-sanitize.ts (deps: only stripUntrustedTerminalChars from @muse/shared, no cycle). main 696→588 LOC; import keeps persist()'s call sites + the indirect hook test unchanged; +6-case direct OUTCOME test (count/key/value caps, array-footgun reject, dedupe-by-id, whitespace collapse). Fresh package (first codebase-quality memory fire). — codebase-quality fire 95
- ✓ dead-code @muse/cli: removed 4 dead re-exports through program.ts (defaultCredentialPath, writeRunLog, appendActivity, maybeCompactLastChatHistory) + their stale back-compat comments. Each symbol's real consumers import it from the SOURCE module directly (credential-store.js / program-helpers.js / chat-history.js); nobody imports it through program.js (the comment claiming a test imports defaultCredentialPath from program.js was stale — program.test.ts imports createProgram/defaultConfigPath/uniqueCommandPrefix, and maybeCompactLastChatHistory via chat-history.js). Kept readPipedStdin (knip-consumed) + writeRunLog's internal import (used at program.ts:434). knip-clean, 236 program tests green. — codebase-quality fire 94
- ✓ decompose @muse/mcp: split the 914-LOC loopback-relative-time.ts god-file by language — extracted the Korean relative-time cluster (2 lookup consts KOREAN_DAY_OFFSET/KOREAN_WEEKDAY_ISO + 4 fns resolveKorean{Relative,Weekday,Duration}Phrase/parseKoreanTimeOfDay, 245 lines) → loopback-relative-time-korean.ts, plus a cycle-breaking base module (loopback-relative-time-base.ts: addCalendarMonths/startOfDay/DEFAULT_HOUR/DEFAULT_MINUTE — the date primitives shared by both English and Korean resolvers). main 914→650 LOC; acyclic graph (main→base, main→korean→base); resolveRelativeTimePhrase delegates to the imported Korean entry unchanged; +9-case OUTCOME test (base clamp/startOfDay + Korean entry). 47+431 existing relative-time tests still green. — codebase-quality fire 93
- ✓ decompose @muse/cli: extracted `parseBoundedInt` (the strict bounded-int CLI-flag parser — rejects unit-slips loudly, truncates+clamps) out of the 2691-LOC commands-ask.ts god-file into a focused sibling parse-bounded-int.ts. It was a general validation util MISPLACED in the ask command yet imported by 8 other commands (listen/orchestrate/routine/debug/runs/maintenance/inbox); now it has a single tested home. import+re-export keeps all 8 consumers + tests unchanged; commands-ask 2691→2676 LOC; +4-case OUTCOME test. (Follow-up ◦: repoint the 8 consumers to import from the new module directly to break the via-commands-ask coupling.) — codebase-quality fire 92
- ✓ compose @muse/recall (Phase-3-aligned): moved `sufficiencyAdvisory` (the set-level grounding-sufficiency advisory — arXiv:2411.06037) out of the 2716-LOC commands-ask.ts god-file into @muse/recall/verdict.ts where it belongs (next to drawBestGroundedRedraft/groundingVerdictNotice + answerIsRefusal). No new dep (recall already → agent-core for assessContextSufficiency; no cycle, lockfile unchanged); commands-ask drops its now-unused assessContextSufficiency import + re-exports sufficiencyAdvisory so the existing cli test (9 cases) passes unchanged; +4-case OUTCOME test at the recall home. Consolidates grounding-presentation into the recall seam (continues Phase 3 recall extraction). — codebase-quality fire 91
- ✓ cohere @muse/mcp: consolidated the duplicated Notion HTTP/parse primitives — 4 shared consts (NOTION_DEFAULT_ENDPOINT/_VERSION/_TITLE_PROPERTY/_LIST_MAX_PAGES) + 4 byte-identical helpers (isTransientNotionStatus/mapNotionStatus/isRecordArray/extractTitleString) hand-duplicated in BOTH tasks-providers-notion.ts and notes-providers-notion.ts → new sibling notion-shared.ts (single source of truth, both import it); no new cross-package dep (lockfile unchanged); +5-describe OUTCOME test. (Note: the older "8 isRecord dups" item is stale — only voice [needs a new @muse/shared dep → lockfile churn, deferred] and agent-core [hot/concurrent loop] still hand-roll isRecord.) — codebase-quality fire 90
- ✓ decompose @muse/cli + JUDGE-DRILL: extracted the stale-task + episode-revisit pure-helper cluster (selectStaleTasks/selectEpisodeToRevisit/formatStaleTasksSection/formatEpisodeRevisitLine + StaleTask/DueEpisode) out of commands-today.ts (1326→1240 LOC) → today-stale-revisit.ts (revisitDueInterval dep re-imported; import+re-export keeps callers/test unchanged; +4-case OUTCOME test); also the 6th JUDGE-DRILL (axis: behavior-change-disguised-as-tidy — a false "No behavior change" SLO p95→p90 edit; gates-pass-only-judge-caught → rolled back) — codebase-quality fire 89
- ✓ decompose @muse/cli: extracted the daemon-config cluster (DaemonConfig + resolveDaemonConfigFile/readDaemonConfig/writeDaemonConfig — daemon.json resolve/read/write) out of commands-daemon.ts (1276→1242 LOC) → commands-daemon-config.ts (deps only node builtins, no cycle; joins the existing commands-daemon-launchagent sibling); import keeps callers unchanged; +5-case OUTCOME test — codebase-quality fire 88
- ✓ dead-code @muse/cli: removed 4 dead exports — de-exported internal-only friendlyFetchError + isNodeError (program-helpers.ts; isNodeError's export unused since chat-history/credential-store each carry their own copy) + removed the dead DEFAULT_TODAY_HEADLINES_CAP re-export (commands-today.ts) which cascaded to also de-export its now-unused def (commands-today-feeds.ts); knip-clean — codebase-quality fire 87
- ✓ decompose @muse/macos: extracted the mac_system_set family (SYSTEM_SETTINGS/SystemSetting/createMacSystemSetTool — volume/mute/sleep/wifi) out of macos-tools.ts (429→328 LOC) → macos-system-set-tool.ts — the LAST non-outbound family; COMPLETES the macos family decomposition (macos-tools 1141→328 LOC, only message_send + the re-export barrel left); trimmed 4 now-unused base imports; re-export keeps callers/test unchanged; +3-case OUTCOME test — codebase-quality fire 86
- ✓ dead-code @muse/model: fixed a dead/phantom-module import in sse-trailing-event.test.ts — ModelEvent was imported from a NON-EXISTENT ../src/types.js (gate-invisible: type-only import erased by vitest + tsc skips test files; only knip's unresolved-import scan caught it); repointed to the canonical ../src/index.js (matching all other model tests); knip unresolved-import cleared — codebase-quality fire 85
- ◦ remaining clean ◦ for next fires: cli dead-code batch in stable files (program-helpers.ts friendlyFetchError/isNodeError, commands-today DEFAULT_TODAY_HEADLINES_CAP re-export — triage each); commands-doctor/commands-today/commands-daemon cli god-files (decompose); the @muse/recall Phase 3 (compose, design-sensitive). macos roadmap DONE bar message_send (deferred, outbound-safety)
- ✓ decompose @muse/macos: extracted the mac_app_read family (~470 LOC: MAC_*_READ_APPS/MacReadApp/buildReadScript/parseReadOutput + 5 parse helpers/createMacAppReadTool + the app_read-only DF_PATH/IPCONFIG_PATH) out of macos-tools.ts (898→429 LOC) → macos-app-read-tool.ts — the BIGGEST macos family, cleanly extractable after the f74/f76/f83 base prep (all shared deps in macos-exec); re-export keeps callers/test unchanged; +4-case OUTCOME test — codebase-quality fire 84
- ✓ cohere @muse/macos: moved PMSET_PATH (the LAST shared symbol between app_read battery + system_set sleep) out of macos-tools.ts into the macos-exec.ts base — the final prep that unblocks app_read + system_set family extraction without a cycle (DF/IPCONFIG stay — app_read-only); usage sites unchanged; macos 140 tests green — codebase-quality fire 83
- ✓ decompose @muse/macos: extracted the mac_shortcut_run family (SHORTCUTS_PATH/SHORTCUTS_TIMEOUT_MS/ShortcutsRunner/defaultShortcutsRunner/createMacShortcutRunTool) out of macos-tools.ts (968→900 LOC) → macos-shortcut-tool.ts (single-family, deps only runChild from base, no cycle; PMSET/DF/IPCONFIG left for app_read/system_set); re-export keeps callers/test unchanged; +4-case OUTCOME test — codebase-quality fire 82
- ✓ dead-code @muse/api: removed 3 knip-flagged dead exports — de-exported internal-only invalid() (mcp-routes-parsers, 12 internal uses, no barrel importer) + removed the superseded registerLineWebhookRoute wrapper (LINE webhook is wired via lineWebhookPlugin directly; trimmed now-unused FastifyInstance import) + removed the def-only-dead MultiAgentOrchestrateResponseBody type; knip-clean; +JUDGE-DRILL (10th — verifier FAILed a byte-identical-extraction claim that silently changed a regex \S+→.+, passing ALL gates) — codebase-quality fire 81
- ✓ decompose @muse/observability: extracted PromptDriftDetector (+ its mean/stdDev helpers) out of observability-detectors.ts → observability-prompt-drift.ts — COMPLETES the one-detector-per-module split (observability-detectors is now a pure 42-LOC barrel re-exporting budget/drift/slo; 480→42 LOC across fires 66/79/80); re-export keeps the barrel/index unchanged; +3-case OUTCOME test — codebase-quality fire 80
- ✓ decompose @muse/observability: extracted SloAlertEvaluator (+ its private percentileMs p95 helper) out of the 371-LOC observability-detectors.ts → observability-slo-alert.ts (371→187 LOC; one detector per module, continuing fire 66's MonthlyBudgetTracker split; re-export keeps the barrel/index unchanged); the stats turned out NOT shared (drift uses mean/stdDev, slo uses percentile) so no prep needed; +3-case OUTCOME test — codebase-quality fire 79
- ✓ dead-code @muse/cli: removed 6 knip-flagged dead exports across 6 non-chat command files — de-exported 5 internal-only consts (MIN_BENFORD_SAMPLE/MEMORY_KIND_FORMS/MUSE_EXPORT_MAGIC/MUSE_EXPORT_VERSION/DEMO_CORPUS_SIZE, no external/test importer) + removed the truly-dead appendJobEvent (worker inlines its own scrubbed append; stale comment + now-unused appendFile import trimmed); knip-clean — codebase-quality fire 78
- ✓ decompose @muse/macos: extracted the mac_app_open family (OPEN_PATH/OPEN_TIMEOUT_MS/looksLikeUrlOrPath/createMacAppOpenTool) out of macos-tools.ts (1036→968 LOC) → macos-app-open-tool.ts (single-family consts, deps only runChild from base, no cycle); re-export keeps callers/test unchanged; +6-case OUTCOME test incl. the URL/path/app routing (looksLikeUrlOrPath, the fire-73 drill target, now has a tested home) — codebase-quality fire 77
- ✓ cohere @muse/macos: moved the shared wifi infra (parseWifiDevice parser + NETWORKSETUP_PATH) out of macos-tools.ts into the macos-exec.ts base (both shared by app_read + system_set) — the 2nd macos prereq, unblocking app_read/system_set extraction without a cycle; IPCONFIG_PATH stays (app_read-only); usage sites unchanged; +3-case OUTCOME test for parseWifiDevice — codebase-quality fire 76
- ✓ decompose @muse/macos: extracted the mac_media_control family (MEDIA_ACTIONS/MEDIA_VERB/buildMediaScript/createMacMediaControlTool) out of macos-tools.ts (1134→1048 LOC) → macos-media-tool.ts — first per-family extraction enabled by the fire-74 runner→base move (deps now all in macos-exec, no cycle); re-export keeps callers/test unchanged; +4-case OUTCOME test — codebase-quality fire 75
- ✓ cohere @muse/macos: moved the shared osascript-runner infra (MacOsascriptRunner type + defaultOsascriptRunner + OSASCRIPT_PATH/OSASCRIPT_TIMEOUT_MS) out of macos-tools.ts into the macos-exec.ts shared base (where runChild lives) — the fire-72 PREREQ that unblocks per-family extraction without a cycle (runner shared by 4 families); usage sites unchanged, re-export keeps MacOsascriptRunner importable; macos 109 tests green — codebase-quality fire 74
- ✓ comment-hygiene @muse/memory + @muse/cli: stripped 2 rot iteration markers ("iter 16", "fire 8") from source comments while keeping the load-bearing WHY (tool-filter min-length cross-ref; muse-ask parity rationale); ReConcile "round 1" domain term in commands-swarm kept; +JUDGE-DRILL (9th — verifier correctly FAILed a false-redundancy "dead-code" regression: dropping the [~/.] filesystem-path regex from macos looksLikeUrlOrPath) — codebase-quality fire 73
- ✓ decompose @muse/cli: extracted the run-outcomes doctor sub-command (formatRunOutcomes/readRunOutcomeEntries/runRunOutcomesDoctor) out of commands-doctor.ts (738→673 LOC) → commands-doctor-outcomes.ts; re-export keeps callers/test unchanged; trimmed 3 cluster-only mcp imports; +3-case OUTCOME test — codebase-quality fire 72
- ✓ decompose @muse/cli: extracted the pure ask tier-model routing cluster (AskTierModels/resolveAskTierModels/routeAskTierModel) out of the 2742-LOC commands-ask.ts god-file → leaf ask-tier-models.ts (deps only @muse/multi-agent classifyTier); re-export keeps callers/test unchanged; removed the now-unused multi-agent import; +4-case OUTCOME test — codebase-quality fire 71
- ✓ cohere @muse/recall: moved the 3 grounding-notice presentation builders (untrustedOnlyGroundingNotice/citationPrecisionNotice/citationRecallNotice) out of the 2800-LOC commands-ask.ts into @muse/recall/grounding-notices.ts (joins the other grounding presentation already consolidated there); re-export keeps the verdict test unchanged; trimmed 5 now-unused agent-core imports; +6-case OUTCOME test — codebase-quality fire 70
- ✓ dead-code @muse/api: removed 10 dead exports from the server-helpers.ts barrel — 8 dead re-exports of server-input-utils/http-plumbing/agent-error symbols (isJsonObject/isJsonValue/optionalBoolean/optionalNullableString/optionalString/optionalStringArray/parseRuntimeSettingType/currentCompatApiVersion/sendAgentError) that nobody imports THROUGH the barrel (canonical homes consumed directly) + dropped the now-unused isJsonValue import + de-exported the internal-only invalid(); knip-clean, api 850 tests green — codebase-quality fire 69
- ✓ decompose @muse/cli: extracted the pure chunkText+hardWrap chunker (notes-index embedding chunker, deps only @muse/agent-core applyOverlap) out of the 1102-LOC commands-notes-rag.ts god-file → leaf notes-chunk.ts; re-export keeps callers/test unchanged; +6-case OUTCOME test — codebase-quality fire 68
- ✓ cohere @muse/shared: DRY'd toDate (7 hand-rolled copies, DB-row Date coercion) → canonical @muse/shared toDate + deduped 6 non-hot copies (agent-specs/auth/runtime-settings/runtime-state×2/scheduler); mcp×1 left (hot); +OUTCOME test; dups 7→1 — codebase-quality fire 67
- ✓ decompose @muse/observability: split MonthlyBudgetTracker (class + types + formatYearMonth) out of the 3-detector god-file observability-detectors.ts -> budget-tracker.ts (480->372 LOC; re-export keeps 3 importers green) — codebase-quality fire 66
- ✓ decompose @muse/prompts: extracted 3 pure text helpers (cleanBlock/compactSections/compactLines) index -> prompt-text.ts (601->590 LOC; no cycle; +4 tests) + JUDGE-DRILL (8th, judge FAILed removing the [from …] citation-forgery escape on the security-invariant axis) — codebase-quality fire 65
- ✓ dead-code @muse/autoconfigure: de-exported 2 internal-only interfaces (ContactLike/UserMemoryFactLike) in knowledge-corpus.ts — knip-clean, zero external/test refs — codebase-quality fire 64
- ✓ cohere @muse/shared: DRY'd finiteOr (7 hand-rolled copies) → canonical @muse/shared finiteOr + deduped 4 non-hot copies (resilience/autoconfigure/api/mcp); agent-core×3 left (hot); +OUTCOME test; dups 7→4 — codebase-quality fire 63
- ✓ non-progress debate early-stop (MAST step-repetition, arXiv:2503.13657): the muse swarm council debate loop now stops refining when a round gains no consensus (min member-support score flat/declining) instead of burning the round cap; semantic score (reuses councilMemberSupportsSemantic), additive (consensus gate unchanged), floor-safe (synthesis+RGV still run) — agent-core-cognition fire 31

- ✓ find_items agent tool (EXPANSION, non-temporal): the cross-store keyword sweep (tasks+reminders+contacts+events) shipped as `muse find` but was never an agent tool — the 12B had to chain 4 list calls + intersect by keyword (unreliable). New find_items projects it; the pure findAcrossDomains moved CLI→@muse/autoconfigure (no dup), CLI re-imports. Carve held by eval:tools STABLE 3/3 on all 7 cases (3 positive + 3 confusable neighbours not crossing: find_contact=person, muse.search=web, knowledge_search=note bodies + 1 IrrelAcc). Closes the non-temporal EXPANSION gap fire 101 named; temporal-digest family stays exhausted. — tool-hardening fire 107
- ✓ Feb-29 birthday phantom-surface (correctness): resolveUpcomingBirthdays built the next occurrence with new Date(year, 1, 29), which in a common year silently rolls to Mar 1 — so a leap-day birthday surfaced in the daily brief / upcoming_birthdays tool as imminent ("in 2 days") with the impossible date "02-29", when the real next Feb-29 is years away. Now a 02-29 birthday clamps to 02-28 in a common year (keeps 02-29 in a leap year); the reported date derives from the resolved day so date+daysUntil stay consistent. — tool-hardening fire 106
- ✓ SSRF bypass in web-url-guard (security): isPrivateIPv6 matched only the dotted IPv4-mapped form (::ffff:127.0.0.1) but WHATWG new URL() normalizes the host to hex (::ffff:7f00:1), so loopback / cloud-metadata (169.254.169.254) / RFC-1918 mapped hosts passed the guard as "public" — a reachable SSRF/metadata-exfil hole in the wired web_download / web_action / web_read tools. Now isPrivateIPv6 also decodes the hex groups → octets and runs isPrivateIPv4; public mapped hosts stay allowed. Verified blocked on the compiled guard. — tool-hardening fire 105
- ✓ tasks.add dueAt time-phrase coverage guard (agent-testing.md hardening): tasks.add was the lone add-tool whose dueAt had NO argFieldMatches time-phrase guard (reminders.add/calendar.add both assert their time field carries the user's PHRASE, not a precomputed ISO — the P45-20 regression class). Added the eval:tools case (STABLE 3/3) + aligned the per-property dueAt schema (alone said "ISO-8601 due timestamp", contradicting its own prose + sibling tasks.update) to mention the relative phrase. HONEST: gemma4:12b already passes (prose dominates) — preventive guard + consistency, not a live bugfix. ④b PASS 8/8. — tool-hardening fire 109
- ✓ web-url-guard deprecated/SIIT IPv6 SSRF forms (security): a probe DISPROVED the fire-105 "low-risk" note — `new URL()` normalizes `[::127.0.0.1]`→`::7f00:1`, `[::169.254.169.254]`→`::a9fe:a9fe` (cloud metadata REACHABLE), `[::ffff:0:127.0.0.1]`→`::ffff:0:7f00:1` (SIIT), all classified public. Replaced the single mapped-form regex with a general IPv6 parse: upper-96-bits all 0x0000/0xffff → decode low 32 bits → isPrivateIPv4. 13 private embeddings blocked, public GUA not over-blocked. ④b PASS 7/7. — tool-hardening fire 108
- ✓ web-url-guard NAT64 SSRF (security, fire-110 JUDGE-DRILL real fix): `[64:ff9b::169.254.169.254]` (host → `64:ff9b::a9fe:a9fe`) reached cloud metadata through a NAT64 gateway (RFC 6052) — the prefix 0064:ff9b is neither 0 nor 0xffff so the fire-108 upper-bits check skipped it. Now isPrivateIPv6 recognizes the NAT64 /96 prefix (exact hextets[2..5]==0) and decodes its low 32 bits; NAT64-of-public (8.8.8.8) and coincidental GUAs (64:ff9b:1::) stay allowed. Completes the embedded-IPv4 guard. ④b PASS 7/7. — tool-hardening fire 110
- ✓ week_agenda all-day event (parity with today_brief): groupWeekAgenda rendered every event with an unconditional HH:MM clock time and the wiring dropped CalendarEvent.allDay — a date-only holiday/trip showed as a fabricated "00:00 <title>"; over the 14-day span this surfaces more all-day items than today_brief's single day. Now an allDay event renders "📅 <title> (all day)" (sorted to the top of its day); wiring maps allDay through. The all-day/event-render vein is now EXHAUSTED across both digest tools (today_brief 103, week_agenda 104) — next fire must pick a different vein. — tool-hardening fire 104
- ✓ today_brief all-day event: the fire-102 in-progress branch mis-routed an all-day event (allDay, start=midnight<now<end) into "00:00 <title> (now)" — birthdays/holidays render as a bogus timed item; now an allDay event renders "📅 <title> (all day)" (sorted by its midnight start), wiring maps CalendarEvent.allDay. — tool-hardening fire 103
- ✓ today_brief in-progress event: composeTodayBrief showed only upcoming events (start>=now), dropping a meeting currently in progress — the most-relevant "what's on my plate right now" item; now an event with start<now<end surfaces marked "(now)" (endsAtIso optional, wiring maps it). Also the fire-102 JUDGE-DRILL (confusable morning_brief FAILed→rolled back). — tool-hardening fire 102
- ✓ salience-gate background skill-review (write-time gating, arXiv:2603.15994): skill-review channel now needs the accrued window to be SALIENT (a tool failed) not just iter-count — suppresses the costly LLM pass on all-successful windows, cadence re-trips on next failure; structural (tool status) not lexical; floor-safe (suppresses post-hoc learning only) + JUDGE-DRILL (10th, Opus FAILed an inert demoteAvoidedStrategiesLast — rolled back) — agent-core-cognition fire 30
- ✓ decompose @muse/model: extracted OpenAI response-field parsers (readOpenAIContent/parseOpenAIToolCalls/parseToolArguments/parseOpenAIUsage) provider-openai -> provider-openai-parse.ts (608->544 LOC; no cycle — deps all imported; +10-case test) — codebase-quality fire 62
- ⚠ tool-hardening EXPANSION digest-vein EXHAUSTED (fire 101 honest-close): 2 wins shipped (today_brief fire 97, day_recap fire 99) completing the temporal-digest family (week/today-forward/today-retrospective); week_agenda was fire 79. Remaining candidates all rejected: morning_brief (`muse brief`) confusable with today_brief; muse status already an agent tool (muse.status.snapshot); person-dossier confusable with find_contact. Bug-hunt veins also exhausted (per-handler fire 94, delivery fire 96). Next: a non-temporal EXPANSION scout (only if a genuine non-confusable capability gap exists), 진안-blocked levers (MCP-risk-annotation posture, undo/veto, email/handle grounding=agent-core HOT), or a new .muse/runs failure cluster.

- ✓ day_recap IrrelAcc: 2 negatives (casual "오늘 하루"/"today" remarks → NO tool) complete day_recap's agent-testing.md triad (selection+confusability fire 99, irrelevance here) — guards the literal keyword "오늘 하루" (a high-frequency casual phrase) from over-firing the tool — tool-hardening fire 100

- ✓ dead-code apps/api: removed 2 dead barrel re-exports (toCompatChatResponse/toExtendedChatResponse) from server-helpers.ts + de-exported internal-only ChannelPollingProvider interface — knip-clean, consumers use the canonical home — codebase-quality fire 61
- ✓ day_recap agent tool (EXPANSION): the retrospective day digest (accomplished + slipping) existed for muse recap / the evening daemon but was never an agent tool — the RETROSPECTIVE twin of today_brief; the hard carve (day_recap vs recent_actions=Muse's-actions vs today_brief=forward, all touching "did/done") held 6/6 STABLE 3/3. person-dossier candidate REJECTED (confusable with find_contact). — tool-hardening fire 99

- ✓ episodic conflict annotation (A-MAC factual-confidence, arXiv:2603.04549): a recalled episode that states the same topic but a different value than a higher-relevance recalled one is flagged conflictsWith + rendered "⚠ verify" — read-time annotation only (never drops), semantic topic gate [0.86,0.92) under consolidation, same-script guarded — agent-core-cognition fire 29

- ✓ cohere @muse/shared: DRY'd clamp (4 hand-rolled copies) → canonical @muse/shared clamp + deduped the 3 identical-impl copies (cache/multi-agent/cli); mcp left (Math.min(Math.max) order differs for min>max); +OUTCOME test; dups 4→2 — codebase-quality fire 60
- ✓ today_brief IrrelAcc: 2 negatives (casual "오늘"/"today" mentions → NO tool) complete today_brief's agent-testing.md triad (selection+confusability shipped fire 97, irrelevance here) — guards the high-frequency casual collision word "today" from over-firing the tool — tool-hardening fire 98

- ✓ today_brief agent tool (EXPANSION): the today/triage merge (overdue-led + today's events/reminders/tasks) existed for muse today / /today / web-API but was never an agent tool, unlike week_agenda — closed the asymmetry; eval:tools 8/8 STABLE 3/3 proves the 12B holds the today-vs-week carve (no confusability) — tool-hardening fire 97

- ✓ cohere @muse/shared: DRY'd escapeRegex (4 hand-rolled copies) → canonical @muse/shared escapeRegex + deduped cache/model/policy (agent-core left, hot); +OUTCOME test; dups 4→2 — codebase-quality fire 59
- ✓ dead-code @muse/cli: de-exported 5 internal-only helpers (defangMemoryValue/looksLikeImage/shortMessageId/logPendingApproval/readActivity) — knip-clean, grep-verified no external/test importer; skipped friendlyFetchError(test)/isNodeError(ext) false-positives — codebase-quality fire 58
- ⚠ tool-hardening delivery-layer vein EXHAUSTED (fire 96 honest-close): fire 95 fixed the one bug (mutation-intent substring false-positive); fire 96 verified the rest of the tool-delivery/security layer clean — @muse/tools exposure (select/relevance filter/comparator/maxTools), MCP projection (createLoopbackMcpMuseTools risk mapping), MCP allowlist (McpManager register+connect). Both veins now examined (per-handler fire 94, delivery fire 95/96). Next candidates: 진안-blocked levers (MCP-risk-annotation default posture, undo/veto tool, email/handle arg-grounding=agent-core HOT); external-MCP tool projection schema (deeper); or a new .muse/runs failure cluster.

- ✓ mutation-intent substring false-positive: isWorkspaceMutationPrompt matched workspace/target hints with normalized.includes(hint), so "pr"/"spec"/"repo"/"event" substring-matched approve/special/report/prevent and over-exposed workspace write tools (more distractors) — now whole-token via (?<![a-z])hint s?(?![a-z]) keeping plural + KO-particle (PR에); the relevance filter already used word boundaries — tool-hardening fire 95
- ✓ decompose @muse/tools: extracted tool-argument-validation cluster (coerceToolArguments/coerceScalar/validateRequiredToolArguments) tools/index -> tools-argument-validation.ts (909->854 LOC; re-export keeps agent-core+tests green) + JUDGE-DRILL (7th, judge FAILed a 0.3→0.5 threshold change disguised as behavior-preserving) — codebase-quality fire 57
- ✓ decompose @muse/memory: extracted JSON-extraction cluster (extractJsonObject + tryParseObject + findBalancedBraceBlocks) memory-auto-extract -> memory-extract-json.ts (770->697 LOC; re-export keeps barrel+cli+tests green) — codebase-quality fire 56
- ⚠ tool-hardening fresh-handler bug vein EXHAUSTED (fire 94 honest-close): fires 87-93 fixed 6 real bugs (contacts update data-loss, calendar/time rollover, on_this_day boundary, home_action fail-close bypass). fire 94 verified web_action/remember_fact/mac_spotlight/scheduler(none)/skills/feeds/objectives/helpers/relative-time all clean (4 scouts + direct grep). Next candidates by value-class: (a) 진안-blocked levers — email/handle arg-grounding (agent-core HOT), MCP-risk-annotation posture, undo/veto tool; (b) DRY-extract the 3-copy rollover guard (codebase-quality territory, touches security date parsers); (c) re-scout a different surface or wait for a .muse/runs failure cluster.

- ✓ home_action empty-target fail-close bypass: the whole-domain guard only checked target KEY PRESENCE, so an empty target (data:{target:{}} / {entity_id:[]} / {entity_id:''}) bypassed it and a confirmed service call blasted every device in the domain (light.turn_off → all lights) — now requires a CONCRETE non-empty target; createHomeActionTool had zero tests, added the fail-close battery (fetch-spy + approving gate) — tool-hardening fire 93

- ✓ on_this_day Jan-1 boundary: selectOnThisDay projected a prior-year note's month-day into now's year only, so a Dec-31 note never surfaced within a ±window of a Jan-1 now (the true 1-day anniversary read as ~364 days) — now min-gap across year before/of/after; fixes a silent grounded-recall miss on the on_this_day tool + CLI + morning-brief — tool-hardening fire 92 (JUDGE-DRILL fire)
- ✓ dead-code apps/api: removed 8 dead barrel re-exports from compat-routes.ts (currentAuthIdentity/chunkText/epochMillisOrNull/stringMapField/badRequest/notFound/prefixValidationDetails/validationErrorResponse) — knip-clean, no consumer routed through compat-routes; symbols stay in canonical siblings — codebase-quality fire 54
- ✓ decompose @muse/cli: extracted the macOS LaunchAgent cluster (LAUNCH_AGENT_LABEL/xmlEscape/buildLaunchAgentPlist/resolveLaunchAgentFile) commands-daemon -> commands-daemon-launchagent.ts (1330->1277 LOC; re-export keeps test+doctor green) — codebase-quality fire 53
- ✓ IrrelAcc personal-crud: 3 past-tense-report negatives (어제 우유 샀어 / 방금 약 먹었어 / EN social report) assert the write tools (tasks/reminders/calendar add) fire NO tool on a statement — agent-testing.md's eager-invocation trap; teeth proven by a borderline probe ('finished the report') that DID over-fire tasks.list — tool-hardening fire 91

- ✓ compose @muse/recall (Phase 3): extracted the "(grounded on …)" citation-banner builder into recall `groundedSourceSummary` (10 count-labels + order; notesPart stays caller-built; byte-identical; +4 OUTCOME tests) — codebase-quality fire 52
- ✓ cohere @muse/mcp: DRY'd the YYYY-MM-DD Date.UTC rollover guard from 3 inline date parsers into shared `isoDateHeadRoundTrips` (loopback-relative-time.ts); each caller keeps its own fall-through; mcp 1874 incl. all 3 rollover tests green +new helper test — codebase-quality fire 55
- ✓ time diff_ms rollover: an impossible date ("2026-02-30") was silently rolled to Mar 2 and a wrong duration returned, contradicting the tool's "valid ISO-8601" error-message contract — now rejected (same Date.UTC guard as calendar/tasks); completes the rollover guard across all 3 user-facing date parsers — tool-hardening fire 90

- ✓ calendar parseIsoDate rollover: an impossible date ("2026-02-30") was silently rolled to Mar 2 and scheduled ~2 days off with no error (the sibling parseTaskDueAt had the Date.UTC round-trip guard; calendar's parser never got it) — now rejected → the add/update handler errors, createEvent never called — tool-hardening fire 89
- ✓ compose @muse/recall (Phase 3): extracted the 11 optional-grounding-section labels+order into recall `optionalGroundingSections` (commands-ask passes just {body,present}; byte-identical labels; +4 OUTCOME tests; groundedSurfaces 27 held) — codebase-quality fire 51
- ✓ dead-code @muse/autoconfigure: removed 2 dead re-exports (resolveUserSkillsDir/resolveWorkspaceSkillsDir) from personal-providers.ts — consumers import from provider-paths.js directly; stays imported for internal use; knip-clean — codebase-quality fire 50
- ✓ add_contact update data-loss: an update-in-place ("save Bob's new email") silently dropped about/aliases/connections (only 5 of 8 persisted fields were carried into the wholesale id-replace) — now preserved from the existing contact; about is cited grounding evidence so this was grounding-floor-adjacent silent loss — tool-hardening fire 87
- ✓ dead-code @muse/cli: de-exported 3 internal-only commands-export helpers (defaultNotesDir/defaultExportOutput/resolveExportPassphrase) — knip-clean, grep-verified no external importer; + JUDGE-DRILL (6th, judge FAILed a load-bearing security-WHY comment removal) — codebase-quality fire 49
- ✓ calendar read-verb selection coverage: golden eval scenario for list/availability/conflicts (7 KO+EN cases, all PASS 3/3) — confirmed the local model selects them robustly (no mis-route); structural-regression guard + documented negative result — tool-hardening fire 86

- ✓ decompose @muse/cli: extracted weather+headlines external-data cluster (resolveTodayWeatherLine/formatWeatherLine/resolveTodayFeedHeadlines/formatHeadlines + cap) commands-today -> commands-today-feeds.ts (1397->1327 LOC; re-export keeps 2626 tests green) — codebase-quality fire 48
- ✓ cohere @muse/autoconfigure: deduped local isRecord type-guard onto canonical @muse/shared isRecord (byte-identical; dups 4->3; voice/agent-core remain hard) — codebase-quality fire 47
- ✓ reminders.fire no-collateral-damage: a failed fire (ambiguous word OR unknown ref) now asserted to flip NO reminder's status (all stay pending, deep-equal) — mutation-verified (guess-fire makes only this test RED, clear/snooze tests stay green); COMPLETES the reminders destructive-verb no-collateral parity (clear ✓83, snooze ✓84, fire ✓85) — tool-hardening fire 85

- ✓ decompose @muse/macos: moved capture tools (createMacScreenshotTool/createMacScreenReadTool + 4 type interfaces + consts) macos-tools -> macos-screen-tools.ts (1297->1143 LOC; re-export keeps 109 tests green; COMPLETES the capture-cluster decompose fires 43/45/46, 1519->1143 across the thread) — codebase-quality fire 46
- ✓ decompose @muse/macos: extracted screenshot output-path security sandbox (resolveScreenshotPath + 3 helpers) macos-tools -> macos-screen-path.ts (1352->1297 LOC; +4 traversal-guard tests; Step 1 of fire-44 capture untangle) — codebase-quality fire 45
- ✓ dead-code @muse/messaging: removed dead MessagingValidationError re-export from telegram-provider (index already re-exports it; knip-clean) — codebase-quality fire 44
- ✓ notes.append no-partial-side-effect: an over-cap append now CHECKS the resulting size BEFORE writing → a failed append mutates NOTHING (was: wrote the oversized bytes THEN errored, leaving the note past its cap = next read fails as oversized) — tool-hardening fire 80
- ✓ KO notes.append selection coverage: 2 positive cases (덧붙여 / collide-verb 추가 + a .md path → notes.append, NOT tasks.add) — probed the fire-76 KO-verb confusable, no mis-route, fills the untested KO-append gap (notes eval 12→14/14 STABLE 3/3) — tool-hardening fire 81
- ✓ dueAt rollover guard datetime coverage: an impossible date on a FULL ISO datetime ("2026-02-30T09:00:00Z") is now asserted-rejected — mutation-verified the date-only cases miss the "full datetimes skip the day-check" shortcut; this fire also ran the JUDGE-DRILL (softball FAILed→rolled back) — tool-hardening fire 82
- ✓ reminders.clear no-collateral-damage: a failed clear (ambiguous word OR unknown ref) now asserted to delete NOTHING from a populated store — mutation-verified (guess-and-delete-first-candidate makes only this test RED); covers agent-testing.md's #1 invariant where only happy-path + empty-store existed — tool-hardening fire 83
- ✓ reminders.snooze no-collateral-damage: a failed snooze (ambiguous word OR unknown ref) now asserted to bump NO reminder's dueAt (deep-equal under a fixed now) — mutation-verified (guess-snooze makes only this test RED, clear's test stays green); closes the snooze gap fire 83 discovered — tool-hardening fire 84
- ✓ decompose @muse/macos: extracted 3 utility tools (clipboard/spotlight/say) + consts -> macos-utility-tools.ts (1519->1352 LOC; resumes fire-19 DECOMPOSE-ON-DEFER) — codebase-quality fire 43
- ✓ Phase 3 cont.: extracted inline contactBlock -> buildContactContextBlock in @muse/recall/select.ts (10/12 ask blocks; +test) — codebase-quality fire 42
- ✓ week_agenda now merges DUE REMINDERS too (EXPANSION) — the holistic "what's my week" view was missing time-anchored reminders; now events+reminders+tasks+birthdays in one call (8B avoids the unreliable 4-chain), reminders-only still routes to reminders.list (eval 5/5 STABLE) — tool-hardening fire 79
- ✓ JUDGE-DRILL (5th, dual-direction: judge PASSed a redundant-comment removal + FAILed a sole-carrier invariant gutting) + extracted calendarBlock -> buildCalendarContextBlock in @muse/recall (9/12 ask blocks) — codebase-quality fire 41
- ⏳ FINDING (fire 78) — full eval:tools REPEAT=3 scan found NO actionable real-tool selection bug (theme maturity confirmed): only (a) `[synthetic] EN weather` 0/3 — the model hallucinates a tool name "weather_in_city" instead of the provided synthetic `get_weather` (a made-up-tool artifact, NOT a Muse real-tool bug, not fixable without renaming the synthetic tool = gaming); (b) `[real-time-tools] two-timestamp diff` ("How many hours between 9am and 5:30pm today?") 1/3 flaky → sometimes picks time_now over time_diff. The time_now description ALREADY explicitly excludes this exact case ("Do NOT use to compute the duration BETWEEN two given times ('how many hours between 9am and 5:30pm') — that is time_diff", muse-tools-time.ts:26) — so it is load-amplified stochastic noise on already-optimal descriptions (8B coherence under 6+ concurrent loops), NOT a description gap. Monitor; re-verify when the machine is quiet. (Scan killed mid-suite for budget after the real-tool scenarios passed; macos 42/42 + followup 20/20 verified recent fires.)
- ✓ dead-code @muse/calendar: de-exported 2 internal-only retry-options interfaces (CalDAVRetryOptions/GoogleCalendarRetryOptions) — knip-clean, grep-verified no external importer; FRESH package — codebase-quality fire 40
- ✓ decompose @muse/cli: moved last doctor classifier embedModelCheck + formatBytes -> commands-doctor-checks.ts + relocated fire-37 orphaned JSDoc (785->739 LOC; FINISHES doctor decompose) — codebase-quality fire 39
- ✓ destructive-intent selection probe + coverage: KO/EN delete/clear/cancel intents → tasks.delete/reminders.clear/calendar.delete one-shot (all STABLE 3/3) — PROBED the fire-76 KO-verb mis-route across all 4 destructive surfaces and CONFIRMED it was followup.cancel-specific (not systemic); calendar.delete uses the same "취소" verb yet selects correctly — tool-hardening fire 77
- ✓ Phase 3 cont.: extracted inline feedBlock -> buildFeedContextBlock in @muse/recall (escapes title+summary; +test); escapeSystemPromptMarkers now used EXCLUSIVELY in @muse/recall — codebase-quality fire 38
- ✓ decompose @muse/cli: moved notes-index embed-model pair (parseNotesIndexEmbedModel/readNotesIndexEmbedModel) commands-doctor -> commands-doctor-checks.ts (810->785 LOC) — codebase-quality fire 37
- ✓ KO followup.cancel selection FIXED 0/3→3/3 STABLE (was a persistent 3x weakness, fires 71/75) — "그 체크인 팔로업 취소해줘" mis-routed to followup.list; fixed by description disambiguation (list "NOT when" excludes cancel/delay intent + cancel leads with "취소해줘 means THIS tool not list") — tool-hardening fire 76 (resolves the fire-75 KO-cancel FINDING)

- ✓ Phase 3 cont.: extracted inline episodeBlock -> buildEpisodeContextBlock in @muse/recall (escapes untrusted summary; +injection-defense test) — codebase-quality fire 36
- ✓ IrrelAcc destructive over-firing parity: a status QUESTION mentioning a task/reminder by a resolvable word → tasks.list/reminders.list NOT the destructive delete/clear (extends fire 71's followup guard to the sibling destructive tools) — tool-hardening fire 75
- ✓ dead-code @muse/cli: de-exported 4 internal-only program-helpers (parseSseEvent/readSseField/readResponseRunId/promptPassword) — knip-clean, grep-verified no external importer — codebase-quality fire 35
- ✓ literal-match injection guards on the 3 remaining destructive-gating word-ref resolvers (resolveReminderRef/TaskRef/EventByRef) — ".*"/"." refs → not-found not match-all; completes the safety parity fire 72 started (followup), so a future regex-refactor on ANY of the 4 resolvers is caught — tool-hardening fire 74
- ✓ Phase 3 cont.: extracted inline actionBlock -> buildActionContextBlock in @muse/recall (the fire-33 drill target, done correctly w/ slice(0,10) + a full-date regression test) — codebase-quality fire 34
- ⏳ **★진안 — TOOL theme MATURE; remaining HIGH-value work is BLOCKED on you (vein status, fire 73).** After fires 55-72 the selection/correctness/outbound-safety veins are worked: eval:tools 99% (macos 42/42 STABLE 3/3); every mutating personal tool (reminders/tasks/calendar/followups) has word-ref one-shot resolution + ambiguous-clarify; mac_app_read covers 14 read-states incl. clipboard (so no clipboard_read tool needed); recipient resolution at email parity; browser_key Enter gated; time-arg + literal-match regression guards armed. The remaining high-value levers all need a 진안 decision or the hot agent-core package: **(1)** `email`/`handle` arg-grounding — needs per-field (domain-aware) matching INSIDE `groundToolArguments` (@muse/agent-core, owned by the concurrent agent-core-enhance loop). **(2)** `riskFromMcpAnnotations` (transport.ts:254) — un-annotated external MCP tool defaults to `read` (fail-open vs MCP spec); AND `{readOnlyHint:false}` w/o destructiveHint maps to `write` though spec defaults destructiveHint=true → arguably `execute`. Both fixes are real hardening BUT over-gate genuinely-read/non-destructive-write un-annotated tools — a security-POSTURE tradeoff that is your call. **(3)** agent-facing undo/veto — `undoLoggedAction` exists but its veto is keyed on standing-objective {objectiveId, scope}, NOT conversational action-log entries; a conversational "undo my last action" tool needs a design decision on how it maps (poor mechanism fit, needs you). Until one unblocks, fires pick lower-value parity/coverage. (fire 73 honest-close: 2nd consecutive clean scout, no forced marginal slice.)
- ✓ JUDGE-DRILL (4th, verifier caught a subtle slice(0,7) non-byte-identical extraction) + decompose commands-doctor ollama-tag trio -> commands-doctor-ollama.ts (847->810 LOC) — codebase-quality fire 33
- ✓ resolveFollowupRef literal-match regression guard (4 mutation-verified tests: ".*"/"." refs → not-found, not match-all) — guards a regex-injection vector on a resolver that gates destructive cancel/snooze + JUDGE-DRILL (vacuous tautology version → verifier FAILed it 5/5, rolled back, teeth-bearing replacement shipped) — tool-hardening fire 72

- ✓ Phase 3 cont.: batched shellBlock+gitBlock -> buildShellContextBlock/buildGitContextBlock in @muse/recall (structural git input type, +test) — codebase-quality fire 32
- ✓ IrrelAcc guard: a followup STATUS QUESTION with a resolvable word → followup.list NOT the destructive cancel (protects against over-firing now that word-ref made cancel one-shot-selectable, fires 67-70) — tool-hardening fire 71
- ⏳ FINDING (fire 71) — KO followup.cancel "그 체크인 팔로업 취소해줘" flaky 0/3 (was 3/3 fire 70): the 8B leans followup.list (the referent "그 체크인 팔로업" reads as a lookup) under concurrent-loop load; INDEPENDENT of the fire-71 slice (eval cases are zero-shot). Borderline KO-cancel selection — candidate: sharpen followup.cancel KO disambiguation, but verify it is not just machine-load (re-run when loops quiet).

- ✓ decompose @muse/cli: ollama-perf cluster (OllamaPerfEnv/ollamaPerfPostureCheck/readOllamaPerfEnv) commands-doctor -> commands-doctor-checks.ts (899->847 LOC, continues fires 25/29) — codebase-quality fire 31
- ✓ Phase 3 cont.: extracted inline memoryBlock -> buildMemoryContextBlock in @muse/recall/select.ts (+test, zero new imports) — codebase-quality fire 30
- ✓ decompose @muse/cli: moved selfLearningCheck + weaknessFuelCheck LocalCheck classifiers commands-doctor -> commands-doctor-checks.ts (939->899 LOC, continues fire 25) — codebase-quality fire 29
- ✓ followup.cancel/snooze one-shot selection 60%→100% — root cause was a bare `id` (forced a prior list); added resolveFollowupRef (word/id ref, ambiguous→candidates) + example-bearing id descriptions, so cancel/snooze act one-shot (parity with reminders) — tool-hardening fire 70 (resolves the fire-69 followup FINDING)
- ✓ Phase 3 cont.: extracted inline reminderBlock -> buildReminderContextBlock in @muse/recall (+test); formatDueLocal orphan removed from commands-ask — codebase-quality fire 28
- ✓ decompose @muse/multi-agent: worker-result cluster (parseWorkerResult/validateWorkerHandoff/createWorkerResult + types) index.ts -> worker-result.ts (825->767 LOC) — codebase-quality fire 27
- ✓ eval:tools field-targeted time-arg correctness — new argFieldMatches scorer + 5 calendar/reminder add cases now assert dueAt/startsAt carries the PHRASE (re-arms the *Iso precompute regression that whole-args argMatches couldnt catch) — tool-hardening fire 69
- ✓ Phase 3 cont.: extracted inline taskBlock -> buildTaskContextBlock in @muse/recall (+5-case test); ask god-file shrinks, presentation lives in recall — codebase-quality fire 26
- ✓ JUDGE-DRILL (3rd, verifier FAILed a gutted injection-guard JSDoc) + decompose commands-doctor env-posture trio (LocalCheck/modelEnvCheck/localOnlyCheck) -> commands-doctor-checks.ts (980->939 LOC) — codebase-quality fire 25
- ✓ mac_message_send ambiguous clarify names the candidate contacts (email parity) — the model asks "Jane Park or Jane Doe?" instead of a vague "which one?" on an irreversible send — tool-hardening fire 68

- ✓ dead-code apps/api: removed dead compatRecord fn + de-exported internal-only sanitizeConfigValue (knip-verified, barrel re-export false-positives left alone) — codebase-quality fire 24
- ✓ mac_message_send resolves a NAME → number from the contacts graph (Rule 3 parity with email; "text Jane" now completes, ambiguous/unknown fail closed, resolved-not-guessed) — tool-hardening fire 67
- ✓ Phase 3 sub-slice 3b: moved buildNoteContextBlock (<<note N>> grounding block) commands-ask -> @muse/recall/present.ts (+test moved); 3a+3b relocate the whole note-block concern out of CLI — codebase-quality fire 23
- ✓ Phase 3 sub-slice 3a: relocated escapeSystemPromptMarkers (injection defense) apps/cli -> @muse/recall (+test moved, commands-ask rewired); unblocks 3b — codebase-quality fire 22
- ✓ browser_key Enter gated — the one state-changing key (confirm/submit a focused control) now carries the SAME draft-first approval gate as browser_click/type; navigation keys (Escape/Tab/arrows) stay free, Enter fails closed with no gate (closed an ungated submit primitive bypassing outbound-safety) — tool-hardening fire 66
- ✓ isRecord dedup @muse/model + @muse/api -> @muse/shared re-export (dups 5->3) — codebase-quality fire 21
- ◦ **Phase 3 (runGroundedRecall) — DECOMPOSED (escalated after 4x defer, fire 21)**: it is genuinely multi-fire + has a hard prerequisite. Loop-sized sub-slices: (3a DONE fire 22) relocate `escapeSystemPromptMarkers` (apps/cli/prompt-escape.ts, injection-defense — SECURITY-sensitive, byte-identical move + test) to a shared home (@muse/recall or agent-core) so recall can import it; (3b DONE fire 23) moved `buildNoteContextBlock` (commands-ask.ts:210, the <<note N>> grounding prompt block) to @muse/recall now that relativizeNoteSource already lives there + 3a unblocks escape; (3c NEXT) define `GroundedRecallInput`/`ResolvedSources`/`RecallOptions`/`RecallRuntime` seam types + extract the FIRST pure pipeline stage; (3d+) thread the API ask route through the seam. Each step behavior-preserving + tested; 3a/3b touch the grounding prompt so 4b judge must confirm byte-identical prompt text (floor neutral).
- ✓ add_contact `phone` arg-grounding — a model-fabricated phone the user never stated is dropped before the contact-store write (the highest-harm contact fabrication: a wrong number reaches a stranger); grounded via the real runtime `groundToolArguments` proved in apps/cli — tool-hardening fire 65
- ✓ comment-hygiene: stripped 5 forbidden goal/task-id markers (adapter-ollama/weather-tool/loopback-calendar/history-routes/commands-pattern), WHY preserved — codebase-quality fire 20
- ✓ recent_actions `result` outcome filter (filter-BEFORE-limit so an old refusal/failure surfaces for "did you refuse anything?") + JUDGE-DRILL (inert/declaration-only/stub slice → verifier FAILed 4/4) — tool-hardening fire 64
- ✓ Decompose @muse/macos macos-tools.ts step 1: shared exec primitives (runChild/escapeAppleScript/isPermissionError/MacCommandResult) -> macos-exec.ts (1522->1464 LOC) — codebase-quality fire 19
- ◦ **Decompose macos-tools.ts (steps 2+, DECOMPOSE-ON-DEFER from fire 19)** — over macos-exec.ts base, move tool families to siblings, re-export from macos-tools: (2) outbound `mac_message_send`+`sendImessageWithApproval` cluster; (3) AppleScript app tools (shortcut_run/app_read/app_open/media_control/system_set); (4 PARTIAL fire 43: clipboard/spotlight/say -> macos-utility-tools.ts) capture remains. Each: move factory+its local consts, import shared base, keep re-export so callers/tests unchanged. **PREREQ (fire 72 finding): NOT cleanly separable as-is — the app-read/system-set tool families share file-level infra (`MacOsascriptRunner`/`defaultOsascriptRunner`, `parseWifiDevice`, path consts `NETWORKSETUP_PATH`/`PMSET_PATH`/`OSASCRIPT_TIMEOUT_MS`) with each other; importing them back from macos-tools.ts would cycle. The clean FIRST sub-slice is moving that shared osascript infra (path/timeout consts + the runner + parseWifiDevice) into macos-exec.ts so every family imports from the base; only then do individual families extract without a cycle.** **PARTIAL (fire 74): the osascript RUNNER is now in macos-exec.ts. fire 75: media_control extracted → macos-media-tool.ts (1134→1048 LOC). REMAINING families: shortcut_run (uses defaultShortcutsRunner — shortcuts-only, extractable now), app_open (uses OPEN_PATH/looksLikeUrlOrPath — extractable now), message_send (outbound — sensitive, defer per outbound-safety), and app_read/system_set which shared parseWifiDevice + NETWORKSETUP_PATH (now MOVED to macos-exec, fire 76 — IPCONFIG_PATH is app_read-only so it moves WITH app_read). REMAINING macos extractions: system_set (last non-outbound family, ~95 LOC — cycle-free now); message_send deferred (outbound-safety). DONE: media_control (f75), app_open (f77), shortcut_run (f82), PMSET prep (f83), app_read (f84). macos-tools now 429 LOC (was 1141 at f73) — mostly the message_send + utility re-exports left.**
- ✓ Decompose commands-doctor calibration sub-command -> commands-doctor-calibration.ts (1073->955 LOC) — codebase-quality fire 18
- ✓ isRecord dedup @muse/auth + JUDGE-DRILL (verifier caught gutted fabrication-WHY) — codebase-quality fire 17
- ✓ browser_fill_form — fill multiple form fields in ONE draft-first approval (axis C, NEW CAPABILITY) — multi-field forms (login/signup/checkout) forced one browser_type per field = an approval round each (slow on a low-spec model). New browser_fill_form takes fields:[{target,value}] (minItems 2, optional submit), resolves ALL targets first (reusing the fire-1/4 matcher fail-close), shows EVERY field->value pair in ONE approval draft, fills in order only on confirm; ANY none/ambiguous/non-typeable target fail-closes BEFORE the gate (zero fills, no partial mutation), submit presses Enter only on the last field. outbound-safety: deny/timeout/ambiguous => ZERO controller.type calls (RED-able two ways); all values in the one draft. risk:execute. eval:tools 93% — fill_form 3/3 multi-field + browser_type 3/3 single (NO confusable regression) — tool-mcp-browser fire 18
- ✓ external-MCP connect retry classification (axis B, hardening) — McpManager.connect + healthCheck catches UNCONDITIONALLY scheduleReconnect'd for EVERY error, and the connector dropped the SDK's HTTP status, so a dead server with a revoked/expired credential (401/403) was retried maxAttempts times — hammering the external server with a credential that will never work (violated architecture.md '4xx MUST fail fast; 5xx/unknown MAY retry'). Fix: isRetryableMcpConnectStatus (4xx→fail-fast terminal disabled+no reconnect loop; 429/5xx→retryable bounded backoff; undefined/network→fail-OPEN retryable), McpConnectionError carries status/retryable, mcpConnectErrorStatus extracts the SDK .code (range-clamped 100-599). Mirrors the repo's isRetryableNotesStatus family. RED-able vs the REAL manager (contract-faithful McpConnectionError(401)→disabled, connector called once, no loop); 503 still bounded-retries. 1860 mcp tests — tool-mcp-browser fire 19
- ✓ external-MCP call-time error surfacing + token redaction (axis B, hardening) — createMcpMuseTool's projected execute returned connection.callTool() with NO try/catch (SdkMcpConnection.callTool also unwrapped, unlike fire-19's listTools), so a mid-session callTool rejection (401 auth-expired/500/timeout/SDK throw) escaped raw — both a grounding hole (a swallowed/escaped failure the model could read as empty results) AND a SECRET-LEAK (the injected Authorization: Bearer <token> could be echoed by an SDK HTTP error into model/logs). Now caught → clear `Error: MCP tool '<name>' failed: <msg>` with redactMcpSecrets stripping Bearer <token>→Bearer [redacted]; successful content + isError:true passthrough unchanged. Call-time complement to fire-19's connect-time fail-fast. RED-able: removing redaction leaks the raw token, removing the catch escapes the rejection. 1859 mcp tests — tool-mcp-browser fire 20
- ✓ browser_upload — attach a local file to a page form (axis C, NEW CAPABILITY) — @muse/browser had NO file-upload path; browser_upload {target,path} resolves a <input type=file> by label (fail-close on ambiguous/non-file-input), validates the local path through an INJECTED allowlist guard, ONE draft-first approval (file→field), then setInputFiles only on confirm. TWO security surfaces handled: (1) local-file read — new @muse/mcp createAllowlistPathValidator reuses file_read's lexical-roots + symlink-realpath-escape guard (fail-closed; @muse/browser adds NO fs dep, validator is DI, absent⇒refuse — no allow-all read); (2) outbound act — risk:execute, deny⇒zero setInputFiles. RED-able: weakening the guard → 6 RED (incl symlink-escape); a rejected ~/.ssh path ⇒ file never read, gate never reached. browser 120 + mcp 1868 tests, live smoke #24 (real Chrome+input[type=file]+temp file→files.length 1), eval:tools 94% upload 3/3 no confusable regression — tool-mcp-browser fire 22

- ⚠ **differentiation loop commits raw zero-width/homoglyph bytes** → recurring @muse/shared byte-hygiene gate failures (fire 16 fixed 2: eval-policy-symmetry.mjs + differentiation.md). Their injection-test fixtures/journal should use \uNNNN escapes. Cross-loop — their process to fix.
- ✓ isRecord dedup @muse/tools (2 defs) + byte-hygiene regression fix (2 files) — codebase-quality fire 16


- ✓ Decompose commands-doctor health-check trio (messagingConfigCheck/notesIndexHealth/episodeIndexHealth) → commands-doctor-checks.ts — codebase-quality fire 15

- ◦ **Decompose commands-doctor check-cluster → sibling** — fire 14 extracted config-classifiers; the LocalCheck-returning health checks (modelEnvCheck/localOnlyCheck/ollamaPerfPostureCheck/selfLearningCheck/notesIndexHealth/episodeIndexHealth/embedModelCheck…) are a further cohesive cluster to extract (commands-doctor still ~1121 LOC).
- ✓ Decompose commands-doctor config-classifiers → commands-doctor-config.ts — codebase-quality fire 14


- ◦ **Consolidate remaining 8 isRecord dups → @muse/shared** — tools(×2)/auth/voice/model/agent-core/autoconfigure/api each hand-roll isRecord; migrate per-package (re-export the exported ones). fire 13 did @muse/shared canonical + apps/cli (3). 
- ✓ isRecord canonical → @muse/shared + apps/cli 3 dups consolidated — codebase-quality fire 13


## ◦ Open — @muse/recall extraction (codebase-quality loop)

- ✓ Relocate RecallHit into @muse/recall + move buildAskConnections — codebase-quality fire 9
- ◦ **Move `selectGraphConnections` + `NoteLinkGraph`** — needs NoteLinkGraph + resolveNoteId/noteLinkView/linkExpandRefs relocated from apps/cli/src/notes-links.ts (own multi-step). Defer until the notes-link graph types have a package home.
- ◦ **Split notes-links.ts (graph-query vs link-editing) → graph subset to @muse/recall** — notes-links.ts is pure (only dep levenshteinDistance, now @muse/shared) but TIGHTLY COUPLED: graph-query (NoteLinkGraph/noteLinkView/resolveNoteId/linkExpandRefs/linkedFromResults — what selectGraphConnections needs) shares internals (extractWikiLinks/noteLinkKey/buildNoteLinkGraph) with link-EDITING (planLinkFixes/rewriteWikiLinkReferences/auditNoteGraph, used by commands-notes). Clean split is a dedicated decompose; LOWER priority than Phase 3 (selectGraphConnections is a CLI --connect footer, not the recall pipeline). — codebase-quality fire 11 defer

- ◦ **Phase 3: `runGroundedRecall` pipeline + API route** — the contract closer (extract registerAskCommand pipeline behind a seam, wire apps/api ask route, CLI↔API parity test). Design-sensitive; small verified steps only.


> ⚠ BLOCKER (codebase-quality fire 5, 2026-06-13): `apps/cli/src/commands-daemon.test.ts` 28/71 FAILED on main (proactive: fired N/N, message length, dest dedup). PRE-EXISTING + EXTERNAL — present with my fire-5 changes stashed; my slice is comment-only in packages/*. Belongs to the concurrent **tool-hardening** loop (daemon/proactive domain, auto-pushes main). NOT fixed here (cross-loop collision risk). main has a real daemon regression to resolve.


> The ONE compounding artifact the dev loop reads FIRST. Resurrected after the
> docs reset deleted it (which forced every session to re-discover "what to build"
> with expensive scout subagents and throw the answer away). The `improve-muse`
> skill picks the top OPEN item here when `self-eval` is green; every fire appends
> the chosen slice + the candidates it rejected + the source, so a direction is
> researched ONCE, not re-paid each session. Keep it pruned: move shipped items to
> DONE, drop dead ones. This file is the antidote to the treadmill.
>
> Priority: ★ = do next · ◦ = ready · ⏳ = blocked (reason noted).
> Each item: **what** — why (source) — the smallest verifiable slice.
>
> **Logging convention (loop-creator v1.14.0+):** this file is a **lean shared QUEUE** — open
> `◦`/`★`/`⏳` items + a one-line `✓ Fixed` dedup ledger (below). **Per-fire Done DETAIL lives in the
> per-loop journal** `docs/goals/loops/<slug>.md`, NOT here. Going-forward Done write-back = move the
> picked `◦` to a `✓ Fixed` one-liner; the full story is the journal entry. (The verbose `✓→Done`
> blocks below are pre-v1.14.0 history — kept for dedup, condensable when loops are paused. Convention:
> [`loops/README.md`](loops/README.md).)

- ⏳ **★진안/loops — repo byte-hygiene gate RED from concurrent-loop JOURNAL pollution (a MOVING target, fire 62).** Per-loop journal commits keep adding RAW U+200B zero-width bytes (ironically while documenting zero-width handling) → `/shared` repo-byte-hygiene test fails repo-wide (blocks `pnpm check` for ALL loops). Each run reports different files (differentiation.md → codebase-quality.md → …); a one-off cleanup cant keep up. ROOT FIX: the per-loop journal/write-back commit path must run the SAME byte-hygiene re-check the slice commits do (the tool-hardening loop already byte-scans its staged diff before every commit — other loops dont). Until then `pnpm check` stays red on a file no single loop owns. (fire 62 cleaned eval-policy-symmetry.mjs + differentiation.md but codebase-quality.md re-polluted.)
## TOOL theme — open (CLI-only capabilities lacking an agent tool)

- ⏳ **FINDING (fire 65) — `email`/`handle`/`birthday` are NOT cleanly groundable under the ANY-token mechanism (so add_contact grounds ONLY `phone`).** `email`/`handle` local-part (`bob@…`, `@bob`) = the contact NAME which is in the utterance → a fabricated domain false-grounds via the name token (false protection). `birthday` reformats (MM-DD) → brittle false-drop. A real fix needs per-field matching (e.g. domain-aware email grounding) in `groundToolArguments` — that lives in @muse/agent-core (concurrent agent-core-enhance loop's hot package); defer until it quiets or 진안 prioritizes. Phone is done (fire 65).


- ⏳ **VEIN THINNING (fire 61) — the cold MCP/tool surfaces are verified correct/covered; remaining candidates are description-only or need 진안.** An adversarial Opus scout swept the cold surfaces (MCP external-tool projection + ToolOutputSanitizer 50k cap/injection-defang, messaging send-gate, official-MCP preset registry, history/context/followups/reminders/notes loopback servers) — all sound. Structural tool-hardening targets (DefaultToolFilter, capToolOutput) live in @muse/agent-core (hot — concurrent loop). Remaining: (a) description-only nits (notes-multi/tasks-multi missing `domain` tag; followup snooze `id` example) — avoid-list; (b) **★진안-decision: `riskFromMcpAnnotations` (transport.ts:254) defaults an annotation-less / non-readOnly EXTERNAL MCP tool to `"read"` → it bypasses the approval gate. This is fail-OPEN vs the MCP spec ("clients MUST NOT make security decisions based solely on annotations from untrusted servers"; readOnlyHint default = false). The spec-safe fix (default un-annotated external tools to a GATED risk) is a real hardening BUT over-gates genuinely-read un-annotated tools — a security-posture tradeoff that's 진안's call, not an autonomous behavior change. Scoped to opt-in external MCP servers (allowlist); official presets re-stamp known servers. Also untested.** Next fires: pivot toward the productivity/calendar surface once those loops quiet, or 진안 decides the MCP-risk posture.

- ✓ **RESOLVED (fire 56) — Korean faithfulness 0/4 was a BATTERY bug, not a grounding regression.** `verify-faithfulness-rate.mjs` hardcoded the LEGACY embedder `nomic-embed-text` (EN-centric v1, ~50% KO hit@1) instead of the PRODUCTION default `DEFAULT_EMBED_MODEL = nomic-embed-text-v2-moe` (100% KO). So the battery measured a Korean "coverage gap" the product never ships — with v2-moe the same battery scores hangul faithfulness 4/4, false-refusal 0/12, PASS. Fixed by using DEFAULT_EMBED_MODEL. `precheck:grounding` now exits 0 → pushes unblocked. (fire-55's ca7b1863 suspect was correctly disproved.)
- ⏳ `math_eval` robustness — VERIFIED NOT A BUG (fire 52): both evaluateArithmetic copies (tools + mcp) reject malformed input by throwing→error (no crash); commas are intentionally stripped. No slice. (closes the fire-51 LANE-A candidate)
- ⏳ **PRE-EXISTING daemon test regression on `main` (cli/daemon owners — NOT differentiation)** — `apps/cli/src/commands-daemon.test.ts:119` "`--once` delivers an imminent task" fails: expected output to match `/proactive: fired 1\/1 imminent/` but got `muse daemon — provider=telegram, dest…`. Reproduces on a CLEAN `origin/main` checkout WITHOUT any local change AND after a full `pnpm build` (not stale dist) — so it landed via a merged commit (P43-5 double-booking / P37-23 email ingestion area). Flagged by differentiation fire 4 (whose own slice is isolated to @muse/autoconfigure + passes). The daemon/cli loop or 진안 should fix; `pnpm self-eval` does not catch it (it doesn't run the cli vitest suite).

- ✓ RESOLVED (fire 10 re-check): the fire-9 core-edge regression — add_contact dropping a user-stated phone, bisected to `5ec47842` — is FIXED on main (both `actuator-tools.test.ts` phone cases pass again). test-hygiene fire 9's blocker surfaced it; the owning loop repaired it.
- ✓ **`packages/tools` src+test double-run — ALL 4 overlapping pairs DONE** (helpers fire 11, time fire 12, text fire 13, data fire 15). Each was two INDEPENDENT suites; kept the fuller side, migrated the lesser's unique cases first (the ④b judge caught real losses on time/text/data — humans miss the bidirectional uniques). Remaining src-only test files (`muse-tools-regex`) have no test/ twin, so they don't double-run — no action needed.

## test-hygiene theme — open (low-quality/flaky tests to fix, coverage gaps to fill)

- ✓ DONE (fire 14) **FIX flaky-boundary: `@muse/messaging pending-approval-store "caps to 200"`** — 205 sequential disk records (~3s, flaked at 5028ms under load) → rewritten as one `fs.writeFile` seed of e0..e203 + one record of e204 (3040ms→73ms), same assertions, mutation-pinned (cap slice + cap removal both caught).

- ◦ **machine-load timeouts under concurrent loops** — with ~6 loop worktrees running vitest at once, *trivial* tests (`@muse/agent-core sanitizeFollowupSummary` — a one-line `.replace`; `@muse/mcp` plan-cache `caps at MAX_PLAN_CACHE_ENTRIES`) hit the 5000ms vitest default and time out under CPU starvation, reddening full `pnpm check`. NOT a test-quality issue (functions are linear) — an environment/oversubscription artifact (plan-cache passes in 1.3s isolated). Candidate slice: raise the global vitest `testTimeout` (e.g. 5000→15000ms) in the shared vitest config so concurrent-loop load can't manufacture false failures — weigh against masking a *real* future slowdown. (observed test-hygiene fire 2)

### Full-suite AUDIT findings (4-agent review, 2026-06-13 — ranked PRUNE + ADD fuel)

**PRUNE — duplicate / double-running tests (highest value: real redundancy):**
- ◦ **`packages/a2a` double-run — partially closed (fire 4)** — deleted the 5 truly-subsumed `src/` dup tests (peer-config·receive-quarantine·signing·council-wire·handler), migrating 2 unique SECURITY cases (council-wire same-length-non-hex catch; peer-config blank-secretEnv guard) into the twins first. REMAINING: `src/agent-card.test.ts` (unique DataPart-envelope coverage) + `src/transport.test.ts` still co-run with their `test/` siblings — close structurally with a `vitest.config.ts` OR migrate agent-card/transport's unique cases into `test/` then delete. (audit a2a — partial)
- ◦ **`packages/tools` src/test twins** — `src/muse-tools-{data,helpers,text,time}.test.ts` duplicate richer `test/` counterparts (vitest.config excludes `dist/**` but not `src/**`). KEEP `src/muse-tools-regex.test.ts` (no `test/` twin — migrate, don't delete). (audit tools)
- ◦ **`packages/model` src dupes** — `src/index.test.ts` (type-only asserts, compile-time-guaranteed) + `src/provider-base.test.ts` (`isRetryableHttpStatus` re-covered by `test/is-retryable-http-status.test.ts`). MIGRATE `src/provider-wire.test.ts` to `test/` (high-value, no twin — don't delete). (audit model)
- ◦ **`packages/autoconfigure`** — `src/response-filters.test.ts` (⊂ `test/response-filters.test.ts`), `src/provider-utils.test.ts` (mostly ⊂ test/ — but verify `stringField` has a `test/` home first). (audit autoconfigure)
- ◦ **`@muse/agent-core` constant tautologies** — `followup-detector.test.ts:20`, `followup-llm-detector.test.ts:148`, `sentence-groundedness.test.ts:101` assert `CONST === <math literal>` (no behavior, no cross-module parity); behavior already pinned by sibling tests. PRUNE. (audit agent-core)
- ◦ **`@muse/agent-core` duplicate describe blocks** — `agent-runtime.test.ts` `validatePlan` (299–382) ⊂ `plan-execute-validation.test.ts`; `StepBudgetTracker` (149–195) ⊂ `step-budget.test.ts`. PRUNE the agent-runtime copies. (audit agent-core)
- ◦ **`@muse/mcp`** — `test/loopback-helpers.test.ts` ⊂ the fuller `src/loopback-helpers.test.ts` (delete the weaker `test/` one); `mcp.test.ts` has a few `toBeDefined()`-only lines redundant with the assertion right after. (audit mcp)

**ADD — genuinely uncovered high-value (security / grounding first):**
- ✗ FALSE POSITIVE (fire 6): `createCitationStreamFilter` is NOT in agent-core and is NOT untested — it lives in `apps/cli/src/citation-stream.ts` and HAS `apps/cli/src/citation-stream.test.ts`. The audit agent grepped only `packages/agent-core/test/`. (lesson: verify audit claims before trusting the package/path)
- ✓ DONE (fire 5) **`assertPublicHttpUrlSync` SSRF sync gate** — covered: file://·malformed·localhost·metadata.internal·127.0.0.1·[::1]·169.254 all blocked, public https passes; each guard clause mutation-pinned.
- ✓ **`groundToolArguments` nested-object branch** — core-hardening fire 7 (agent-core, anti-fabrication floor): the fabrication gate handled only string + string[]; a nested OBJECT value passed through UNTOUCHED, so a fabricated `meta.note` rode past the gate and would persist. Added a nested-object branch (clean each fabricated STRING leaf via the same isGrounded test, keep grounded + non-string leaves, same partial-vs-empty `dropped` contract as the array branch; `!Array.isArray` guard so a mixed array isn't corrupted into an index-keyed object — sibling-audit catch). Gate now total over value shapes. Mutation-first + Opus ④b PASS (probed mixed-array/null/Date/aliasing, no corruption). HONEST CAVEAT: no tool marks an object-valued grounded arg today (every real groundedArgs is a string or `tags` string[]) — pre-closes the shape-hole before a tool ships one. RESIDUAL ◦: one level deep (array-of-objects + object-in-object not recursed; deferred until a real nesting caller).
- ◦ **tool-failure-streak: LIMIT tuning** (agent-core) — TOOL_FAILURE_STREAK_LIMIT=3 is a fixed default not yet tuned on a real failing-tool corpus (needs a live battery; smoke:live stalls). Streaming-seam coverage now DONE (fire 56). (agent-core-cognition fire 42 caveat)
- ◦ **reflection-dedup: REFLECTION_DEDUP_COSINE tuning on a real paraphrase corpus** (agent-core) — fire 43 set the collapse floor to 0.86 by reasoning, not measurement; tune against real `muse reflections` paraphrase pairs (too low → distinct insights over-merge; too high → paraphrases survive). Also consider applying the same semantic collapse at episode/note recall presentation, not just the offline dream. (agent-core-cognition fire 43 caveat)
- ◦ **playbook credit: DEFAULT_PLAYBOOK_CREDIT_COSINE tuning + asymmetric decay floor** (agent-core) — fire 45 set the semantic credit floor to 0.55 by reasoning; tune on a real cue/strategy corpus. Memory-R2 alternate B (deferred): require a correction (decay) to clear a HIGHER cosine floor than an approval (reinforce) — a wrong decay of a grounded strategy is costlier than a missed reinforce (asymmetric precision). Also alternate A: have applyPlaybook record the actually-injected strategy ids in run metadata so moveReward credits the real culprit set rather than re-deriving by similarity (bigger cross-package wiring). (agent-core-cognition fire 45 caveat)
- ◦ **HIGH-VALUE (blocked): cross-lingual recall for action-log + memory-fact grounding selectors** — selectGroundingActions/selectMemoryFacts (packages/recall/src/select.ts) rank PURELY by lexical token overlap, so a Korean query "내가 Bob한테 이메일 보냈었나?" against an English action-log entry scores 0 → the true entry never grounds → false "I'm not sure" on Muse's actual KO user. Add a hybrid max(lexical, cosine(queryVec, entryVec)) arm (queryVec + embed already in scope at the registerAskCommand caller; mirrors rankEpisodeHits) — strictly additive, fail-soft. BLOCKED: select.ts is in @muse/recall, actively rewritten by the codebase-quality extraction loop (race) — do when that loop pauses or coordinate. Grounds CLIR (arXiv:2511.19324). (scouted agent-core-cognition fire 47)
- ◦ **DRY the two preference-upsert loops** — inferPreferencesFromTurns (autoconfigure) and inferSessionPreferences (cli) now BOTH carry the belief-revision supersession logic (fires 47+49) duplicated; a future refactor could have the CLI delegate to the package-level core. Lower priority (both work + tested). DEFAULT_PREFERENCE_SUPERSEDE_MAX=6 untuned. (agent-core-cognition fire 49)
- ✓ `createLlmClassificationInputGuard` owns its fail-close (security/agent-core): the LLM input guard called provider.generate + parse with no try/catch, so a classifier outage or unparseable verdict THREW — failing closed only incidentally via the pipeline's generic catch, which leaked the raw provider error (internal host/IP) into the GuardBlockedError reason + metrics + monitor and used a generic GUARD_ERROR code. Now the guard owns its fail-close: catches → returns a clean `{allowed:false, code:"LLM_CLASSIFICATION_UNAVAILABLE", reason:"input classifier unavailable; failing closed"}` (no leak, distinct code, not reliant on pipeline catch). ④b PASS 5/5 (info-leak traced real, behavioral delta confirmed). — tool-hardening fire 133
- ✓ DONE (fire 8) **`createToolResultQualityAuditFilter` empty-remainder branch** — `rest.length===0` (apology IS the whole output) pinned; filter no longer turns an apology-only answer into an empty result header. Filter branch coverage complete.
- ⓘ AUDIT FALSE-POSITIVES verified (don't re-scout): `createCitationStreamFilter` (in apps/cli, already tested — fire 6); `SchedulerExecutionError` throw-conditions (scheduler dispatcher timeout/retry/clamp all covered in scheduler.test.ts — fire 8); `groundToolArguments` nested-object branch (function only handles string + string-array, no nested-object traversal exists; 20 cases already cover string/array — fire 8).
- ◦ **`formatDueLocal`/`relativeDueHint` (mcp/local-due-format.ts)** — today/tomorrow/in-N-days/NaN branches untested (drives task `dueAtLocal` shown to the model). (audit mcp)
- ◦ **`muse config show` (cli/commands-config.ts)** — user-facing read path, zero tests (only set/unset tested); `loadImageAttachment` + `muse auth rotate-jwt` command-wiring also uncovered. (audit cli)
- ◦ **`SchedulerExecutionError` (scheduler) + `withFileLock` stale-lock-steal (mcp/encrypted-file.ts) + `KyselyMcpServerStore` CRUD** — exported, no direct test (Kysely needs Testcontainers or an honest "integration-only" note). (audit mcp/scheduler)

> AUDIT VERDICT: suite is broadly HEALTHY (policy/recall/memory cleanest; security paths well-covered). Rot concentrates in (1) `src/`+`test/` double-running in a2a/tools/model, (2) a few constant tautologies + promoted-then-not-pruned duplicate blocks in agent-core. Biggest real gap: the streaming citation gate. ~15 PRUNE + ~10 ADD items → the loop now has genuine PRUNE fuel (fires 1-3 were add/fix/add because no prune candidate had been scouted yet).

## GROUNDING INTEGRITY theme — open

- ⏳ VEIN MOSTLY EXHAUSTED (fire 19; note fire 20 found a real paper-grounded hole via the new-arXiv escape-hatch, so occasional value remains), 2nd consecutive clean scout): the deterministic grounding/self-improvement hardening vein is mined out — axis A (provenance, empty-evidence fail-close ×3 gates, conflict, citation precision+recall, date-drift), axis B reliability (reward/decay/probation/graduation/BKT/polarity/persistence), axis C (judge gates + 2 judge-drills) all shipped + densely tested. NEXT high-value requires a value-class PIVOT (retrieval/recall quality; learned-state UX surfacing) or a fresh open-arXiv mechanism — recommend 진안 repoint the theme or wind down (CronDelete 8ed88aa8). The loop will otherwise honestly produce small/no-op fires.

- ◦ VEIN STATUS (fire 16): the deterministic grounded≠true fail-open vein is effectively exhausted (precision/recall/groundedness triad complete; all 3 judge gates empty-evidence-closed; provenance+conflict+date guards shipped). Next high-value moves are NOT more fail-open hunting but: (a) track citation precision/recall + faithfulness as a `muse doctor --grounding` / self-eval metric over a fixture corpus; (b) pivot value-class to retrieval QUALITY (recall@k / rerank) or chat-surface parity of the ask cues; (c) honest wind-down. Pick one next fire.


- ✓ untrusted-only provenance firing now CITATION-INDEPENDENT (ask AND chat) — competitor-grounding fire 40 (grounding-floor). The untrusted-source cue fired only when the model emitted `[from <src>]` (`groundedOnUntrustedOnly`/`untrustedOnlySentences` both require citations; `groundedOnUntrustedOnly` returns false on `cited.length===0`), yet `verifyGrounding` accepts zero-citation answers — so a grounded-but-non-citing answer resting entirely on poisonable tool data got NO warning. Added the deterministic `evidenceIsUntrustedOnly(matches)` (@muse/agent-core: pool non-empty + every match `trusted===false`) ORed into BOTH notices, so the cue fires on structurally tool-only grounding even when the 8B skips the marker. Conservative-safe: a single trusted note → silent (mixed is the per-claim guard's job); a notes answer can NEVER trip it (trusted-absent ≠ false). Non-answer guards on both surfaces (ask: empty + `answerIsRefusal`; chat: empty + abstention). Opus ④b judge PASS 7/7 (3 mutations; no false-positive on the notes safety cue). ◦ RESIDUAL (deferred, live-measurement): the production firing-RATE via `eval:grounding-delta` on a `--with-tools` poisoned-source case — now bounded below by the deterministic structural fire, so the citation-dependence risk is closed; measuring the remaining citing-path rate is a separate live-eval slice.
- ◦ broaden source-conflict value extraction — DECOMPOSE-ON-DEFER (core-hardening fire 9 analysis): the `label: value` regex truncates at the first comma (`Address: 12 Baker St, London` → "12 Baker St"), so "…, London" vs "…, Paris" both truncate to "12 Baker St" = a real conflict MISSED (false-negative). BUT naively allowing commas ADDS a NEW false-positive class: a comma-LIST sharing a first element (`items: a, b` vs `items: a, c` → currently both "a" = no conflict; broadened → "a, b" vs "a, c" = spurious conflict). So broadening trades a false-negative for a false-positive — NOT a clean 1-fire regex tweak. Needs a list-vs-single-value heuristic (an address is one coherent comma-value; a list is N short comma-tokens) + the fire-6 rigor (LARGE benign Korean+English corpus, STABLE 0 false-positives) before landing. >1 fire; decompose: (a) design the list-vs-value discriminator + benign corpus, (b) apply + verify. (analysis fires 7-9)

## ✓ Fixed (dedup ledger — one line each; detail in the per-loop journal)
- ✓ Decompose scheduler-helpers validation cluster (6 validate* + requireText + consts) → scheduler-validation.ts; SchedulerValidationError test repoint restores type assertion — codebase-quality fire 106

- ✓ A2A outbound label length bound (MAST arXiv:2503.13657) — prepareOutbound bounded content but not the label, yet the label is a real outbound field (commands-swarm sends label: skillName) and inbound already bounds it (fire 60); added a symmetric A2A_MAX_LABEL_CHARS throw, completing the inbound/outbound symmetry; revert-proof reds exactly the new test — agent-core-cognition fire 63
- ✓ proactive finding-suppressor working-set bound (AMV-L arXiv:2603.04443) — FindingResurfaceSuppressor's lastSurfacedMs Map was time-cooldown-bounded but UNBOUNDED in distinct keys; the daemon builds ONE suppressor for its lifetime (before the tick loop) so distinct findings accumulated forever (slow leak). Added maxEntries=256 + oldest-first eviction + finite-guard, mirroring ToolCallDeduplicator; evicted finding re-shows ≤once; revert-proof reds exactly the bound test — agent-core-cognition fire 62
- ✓ ACT-R ranking on the daemon consolidation tick (arXiv:2604.02280 / ACT-R) — the manual `muse memory consolidate` ranked promote/fade by ACT-R activation (frequency×spacing) but the background daemon tick fell back to last-hit recency; since the lists are capped (fade 10 / promote 3) the weaker signal chose a different SET, and the fade set is persisted to the recall down-ranking sidecar. Threaded useActrRanking through runMemoryConsolidationTick + set true at the daemon call; records carry real recentAccessMs so ACT-R is non-degenerate; revert-proof reds exactly the capped-set test — agent-core-cognition fire 61
- ✓ A2A inbound label trust-boundary bound (MAST arXiv:2503.13657) — classifyInbound bounded content but the symmetric label field was neither length-bounded nor type-checked in isEnvelope, yet flows into the same quarantine store; an allowlisted-but-compromised peer could flood via an unbounded/non-string label. Added A2A_MAX_LABEL_CHARS=512 reject + isEnvelope string|undefined label guard; inbound-only, strengthens the inert guarantee; revert-proof reds exactly the 2 new tests — agent-core-cognition fire 60
- ◦ **A2A outbound label length bound (follow-on, fire-60 judge note)** — prepareOutbound redacts the label but doesn't length-bound it (the inbound bound landed fire 60); a symmetric outbound A2A_MAX_LABEL_CHARS check is a minor follow-on (local-origin, lower risk).
- ✓ council cross-lingual outlier-screen fix locked + JUDGE-DRILL (Cleanse arXiv:2507.14649) — discriminating 5-peer EN/KO test proves screenCouncilOutliers' semantic precomputedSupports keep a legit Korean peer that lexical Jaccard wrongly excludes while still quarantining a deceptive peer (non-vacuous; revert-proof reds exactly it); same fire ran the JUDGE-DRILL (inert deprioritizeUntaggedReflected → independent Opus judge FAILED it → rolled back) — agent-core-cognition fire 59
- ✓ playbook recency-floor scale-mix (MemRL arXiv:2601.03192) — rankEligible's recency-floor top-up scored fillers on the RAW unbounded composite while Phase B used z-normalised scores; the final sort mixed both scales so a high-utility low-relevance recency filler outranked a genuine value-aware Phase-B pick (injecting weak guidance above the strongest). Now scores fillers strictly below every Phase-B pick (minSelectedScore−rank), recency order preserved; ordering-only, set unchanged; revert-proof reds exactly the new test — agent-core-cognition fire 58
- ✓ MemoryBank daemon fade auto-refresh (FadeMem arXiv:2305.10250) — the daemon consolidate tick computed the Ebbinghaus fade plan every run but only logged it (sidecar refreshed only on the manual `muse memory consolidate`); added a fail-soft ranking-only persistFade seam to runMemoryConsolidationTick + wired the daemon to writeFadedMemoryKeys with the manual path's exact write behind MUSE_SELFLEARN_ENABLED, so recall down-ranking stays fresh on the background tick; revert-proof reds exactly the 2 call-dependent tests — agent-core-cognition fire 57
- ✓ tool-failure-streak streaming-seam coverage — closed the fire-42 caveat: the circuit breaker is wired into executeStreamingModelLoop (async-generator path, line-identical to the tested non-streaming twin) but was untested at the seam; added an outcome-graded streaming test (12 flaky turns, distinct errors defeat the stall detector + unique args defeat the dedup → executes exactly LIMIT=3 then withheld, not maxToolCalls=10); revert-proof on model-loop.ts:294 reds ONLY this test — agent-core-cognition fire 56
- ✓ council dissent-surfacing advisory (Hear Both Sides arXiv:2603.20640) — selectDissentingExclusions surfaces a consensus-outlier the majority outvoted whose reasoning semantically diverges from the answer (cosine <0.35) as one "⚠ dissent set aside" caution; renderCouncilResult was dropping excludedPeers → silently-buried minority now visible; advisory-only (never re-admits/alters answer), semantic, fail-soft — agent-core-cognition fire 54
- ✓ episode-write salience admission gate (SSGM arXiv:2603.11768) — isEpisodeWorthRetaining drops an episode only when BOTH content-thin (<5 distinct tokens) AND model-self-rated trivial (importance≤1), activating the previously-inert self-rated importance signal at admission so idle greetings don't dilute recall; fail-open, subtractive (fabrication=0 strengthened), distinct from fire-35; wired into captureEndOfSessionEpisode — agent-core-cognition fire 53
- ✓ fire-52 NUL-byte hygiene fix in tool-batch-conflict.ts (grep -P missed a U+0000 template separator; repo-byte-hygiene test caught it once tracked) — agent-core-cognition fire 53 (4a1caf3b)
- ✓ intra-batch conflicting-write guard (AgentSpec arXiv:2503.18666) — detectConflictingWritesInBatch withholds the 2nd+ write to the same (tool, identity) with conflicting args in one batch (a double-act on a write actuator the deduplicator/stall/failure-streak all miss); precise (same identity value + different args; different-target writes both run; fail-open without an identity arg); wired into both model loops, zero side-effect on the blocked call — agent-core-cognition fire 52
- ✓ playbook asymmetric decay credit floor (Memory-R2 arXiv:2605.21768) — a DECAY (correction) now needs a HIGHER cue↔strategy cosine (0.62) than a reinforce (0.55), since a wrong decay of a grounded strategy sinks it below the avoidance floor (WEDGE) while a missed reinforce is harmless; moveReward passes delta-conditioned floor; only suppresses spurious decays, reinforce unchanged; cross-distribution path (semantic; lexical fallback stays symmetric) — agent-core-cognition fire 51
- ✓ proactive-recall finding anti-nag suppressor (arXiv:2410.12361) — FindingResurfaceSuppressor withholds an IDENTICAL "📎 Related in your notes" finding re-shown within 6h (a recurring item re-fires its notice each occurrence + re-appends the same nudge); in-memory, reversible (cooldown re-shows), fail-open, withholds guidance only (fabrication=0 untouched); wired into createIndexedProactiveInvestigator (daemon tick) — agent-core-cognition fire 50
- ✓ preference supersession wired into the CLI session-end path (arXiv:2606.09483) — inferSessionPreferences (`muse chat` session-end + `muse user model infer`) now drops a stored DIFFERENT-category preference the new one contradicts (fire 47 only wired the daemon arm); reuses findSupersededPreferenceId, feature-detected store read/remove, fail-soft. Shipped as fire-49 JUDGE-DRILL's real fix (inert dropBlankCouncilAnswer injected → judge correctly FAILed → rolled back) — agent-core-cognition fire 49
- ✓ plan enum/const arg pre-validation (arXiv:2602.03439) — validateEnumArguments: validatePlan rejects a plan step whose scalar arg is outside the tool schema's enum/const set BEFORE execution (was caught only at runtime after earlier steps wrote = τ-bench partial-side-effect); exact set membership (not similarity), fail-soft, wired into the existing toolSchemas block (26+ built-in tools have enum props), no grounding touch — agent-core-cognition fire 48
- ✓ preference belief-revision supersession (arXiv:2606.09483) — findSupersededPreferenceId: a newly-inferred preference that CONTRADICTS a stored DIFFERENT-category one supersedes it (the pref-<category> upsert only supersedes within a category, so cross-category contradictions accumulate → contradictory persona injection); model-polarity (classifyCorrectionContradiction) NOT cosine, fail-open, removes the stale slot; wired into inferPreferencesFromTurns (daemon/server arm) — agent-core-cognition fire 47
- ✓ council contributor-attribution faithfulness screen (arXiv:2412.18004) — screenUnfaithfulContributors drops a council peer listed as a source ("drawn from:") whose reasoning's cosine to the answer < 0.35 (post-rationalized/false provenance the 12B emits, which verifyCouncilGrounding's answer-vs-union can't catch per-peer); semantic, subtractive on the provenance field, never-empty + fail-soft, STRENGTHENS fabrication=0; wired into synthesizeCouncilAnswer (live swarm path passes embed) — agent-core-cognition fire 46
- ✓ playbook semantic credit assignment (Memory-R2 arXiv:2605.21768) — selectCreditTargetSemantic picks which strategy a correction/approval implicates by embedding cosine (≥0.55) instead of cross-distribution lexical Jaccard (strategy imperative vs user prose), so reward stops landing on the wrong strategy/none (mis-credit replays via experience-following 2505.16067); moveReward semantic-first + lexical fallback, WEDGE-safe (only nudges ±1, never drops), revert-proven — agent-core-cognition fire 45
- ✓ reflection cross-tick NOOP dedup (Mem0 arXiv:2504.19413) — filterReflectionsAgainstStore drops a fresh "dream" insight whose cosine ≥0.86 to one ALREADY in the persisted store (the lexical addReflections dedup misses paraphrases → store accreted near-dups every 6h tick); wired into runReflectionPass after RGV, subtractive on the write-list only, fail-soft; distinct from fire 43 (intra-batch) — agent-core-cognition fire 44
- ✓ reflection semantic near-duplicate collapse (SemDeDup arXiv:2303.09540) — collapseNearDuplicateReflections merges a paraphrased grounded "dream" insight (cosine ≥0.86) into the higher-support one, UNIONing sources; runs AFTER citation+RGV gates, subtractive, fabrication=0 preserved; lexical store dedup missed paraphrases (semantic>lexical lesson); wired into both prod reflection callers via createGateEmbedder — agent-core-cognition fire 43
- ✓ tool-failure-streak circuit breaker — a tool failing (status≠"completed") 3× in a row is withheld from activeTools for the next turn (model keeps other tools → clean synthesis, not burned maxToolCalls); deterministic status-count, complementary to the stall detector + dedup; wired into both model loops (AgentErrorTaxonomy arXiv:2509.25370) — agent-core-cognition fire 42
- ✓ hedge-overclaim (certainty escalation) grounding guard — token coverage ignored modal certainty so a categorical claim grounded in hedged evidence (may→does); added detectHedgeOverclaim + fail-close (FActScore arXiv:2305.14251). Completes the sentence-vs-evidence semantic guard trio (negation/numeric/hedge) — grounding-integrity fire 22

- ✓ numeric/unit mismatch grounding guard — token coverage missed unit swaps (5 g vs 5 mg) and ≥3-digit magnitude errors; added detectNumericMismatch + fail-close in reportSentenceGroundedness (FactCC arXiv:1910.12840; guard-removal verified) — grounding-integrity fire 21

- ✓ polarity-mismatch (negation) grounding guard — token coverage stripped no/not so a negated contradiction scored supported; added detectPolarityMismatch + fail-close in reportSentenceGroundedness (arXiv:2305.16819; guard-removal verified) — grounding-integrity fire 20

- ✓ untrusted-only provenance marker on grounded ask answers — wired the dead `groundedOnUntrustedOnly` grounded≠true mitigation into the `muse ask` verdict path (re-export + `untrustedOnlyGroundingNotice` + verdict wiring); faithful answers resting only on untrusted MCP/web sources now surface a scrutiny cue, label stays "grounded", floor untouched — grounding-integrity fire 1
- ✓ distill-queue drain-idempotency + grounding-fence invariants pinned — the unattended distill-consumer's "dud/fail-soft event is drained not jammed, writes zero fabricated strategies" safety guarantees were untested; added 2 mutation-verified OUTCOME tests over the real file-backed stores — grounding-integrity fire 2
- ✓ untrusted-only provenance parity on the chat surface — extended fire 1's defense to `finalizeGatedChatAnswer` (every conversational surface's shared pipeline): toolEvidence now tagged `trusted:false` + `untrustedOnlyChatNotice` cue when a faithful chat answer rests only on untrusted tool sources; purely additive, fabrication floor untouched — grounding-integrity fire 3
- ✓ fail-close empty-evidence on council + reflection judge gates — verifyCouncilGrounding/verifyReflectionsGrounding called the judge with empty evidence and KEPT the claim on YES (fail-OPEN floor leak, no deterministic pre-gate); now fail-close without consulting the judge when evidence is empty (red-without-fix verified) — grounding-integrity fire 4
- ✓ learn-queue lost-update fix — markLearnEventsDone (read-modify-write) and enqueueLearnEvent (appendFile) ran without a mutex, so a correction enqueued during a drain was clobbered (silently never learned, unattended path); wrapped BOTH in the shared per-file withFileMutationQueue (red-without-fix verified; wrapping only the drain is insufficient) — grounding-integrity fire 5
- ✓ council/reflection judge k-sample self-consistency — both gated on a SINGLE judge call (flaky YES promotes a baseless synthesis/reflection), unlike recall's k-sample unanimity; added opt-in reverifySamples [1,5] mirroring recall (first-NO short-circuit + judgeConsensus), threaded from synthesize* options, floor strictly stronger (red-without-fix verified) — grounding-integrity fire 6
- ✓ deterministic source-conflict detector (evidence vs evidence) — nothing screened EVIDENCE against EVIDENCE, so two notes giving different values for the same field (old vs new wifi password) were cited as one clean receipt; added pure no-model detectSourceConflict + formatSourceConflictWarning in @muse/recall, hardened against prose-prefix/clock-time false positives (mutation-verified) — grounding-integrity fire 7
- ✓ source-conflict cue wired to the live ask path — added groundingConflictCue (@muse/recall, composes the answer's grounding) + emit in commands-ask (stderr, ungated by --connect, fires only on real conflict); the fire-7 detector now reaches the user — grounding-integrity fire 8
- ✓ source-conflict cue on the chat surface (every-surface parity) — added conflictCueFromMatches (@muse/recall) + appended to finalizeGatedChatAnswer on the user's own grounding; ask+chat now both surface contradictory sources. ALSO: JUDGE-DRILL passed (neutered detector + inert test → verifier correctly FAILed) — grounding-integrity fire 9
- ✓ reflections cap trims by recency not insertion order — the unattended dreaming store capped to 500 by insertion order while surfacing newest-first by createdAtMs, so a backfill/out-of-order write could evict a newer insight; now trims by createdAtMs (any-writer hardening, isolated-mutation verified) — grounding-integrity fire 10
- ✓ empty-evidence fail-close on the PRIMARY reverify gate — verifyGroundingWithReverify escalated to the judge with evidence="" (high-cosine empty-text match → confidence>0), and a YES upgraded a fabrication to grounded — the floor leak f4 closed for council/reflection, still open on the main recall/ask/chat gate; now fail-closes without consulting the judge (strictly tightens, isolated-removal verified) — grounding-integrity fire 11
- ✓ enricher CRAG gate fail-open fixed — the ambient "Related:" brief enricher classified confidence on `[top]` only, zeroing the runner-up and disabling the near-tie margin guard, so an ambiguous recall rode into the daily brief as confident; now classifies the full post-exclusion candidate list via pure selectEnricherLine (isolated-mutation verified) — grounding-integrity fire 12
- ✓ date-drift guard on the sync chat gate — the chat gate guarded IP/number/email/identifier but not DATES; valueNumbers drops month/day so a same-year drifted ISO date (2026-09-13 vs -14) passed; added answerAssertsUnsupportedDate (ISO-only, evidence-must-have-a-date so false-refusal≈0) before the number guard — grounding-integrity fire 13
- ✓ ALCE per-citation support precision (arXiv:2305.14627) — added reportCitationPrecision: scores each cited sentence against ONLY its cited source's text (right-source/wrong-claim), distinct from existence (enforceAnswerCitations) and union-groundedness; diagnostic primitive, existence-only mutation verified — grounding-integrity fire 14
- ✓ ALCE citation-precision wired to the live ask path — citationPrecisionNotice surfaces a 'right source, wrong claim' cue (a [from src] citation resolving to a note that doesn't support its sentence) on grounded ask answers, alongside the untrusted/conflict cues — grounding-integrity fire 15
- ✓ ALCE citation RECALL (arXiv:2305.14627) — reportCitationRecall flags groundable-but-uncited claims (a claim in evidence with no [from] marker), complement to precision; wired to ask as citationRecallNotice; completes the precision/recall/groundedness triad — grounding-integrity fire 16
- ✓ citation-precision aggregates all chunks of a cited source — fire-14 reportCitationPrecision used a last-wins source→text map, so a file retrieved as multiple chunks would false-flag a faithful sentence supported by a different chunk (live ask cue false-positive); now concatenates all chunks per source (last-wins mutation verified) — grounding-integrity fire 17
- ✓ citation precision+recall cues on the chat surface (parity) — chatCitationPrecisionNotice/chatCitationRecallNotice added to finalizeGatedChatAnswer; ask+chat now both surface mis-citation/missing-attribution. ALSO: JUDGE-DRILL passed (④ test caught floor-weakening; ④b judge caught an inert no-op slice) — grounding-integrity fire 18

<!-- Going-forward: `- ✓ <item title> — <slug> fire N` so the scout dedups without the verbose block. -->
- ✓ Adaptive-k score-gap recall cutoff (trim grounding-window decoys, floor-neutral; arXiv:2506.08479) — agent-core-cognition fire 1

- ✓ web Markdown link-scheme allowlist widened to `mailto:`/`tel:` (model-reply contact links now clickable; `javascript:`/`data:`/`vbscript:` still blocked, adversarial test added) — surfaces fire 1
- ✓ desktop companion stale default model: `OllamaHealth.requiredModel` qwen3:8b→gemma4:12b + `.notRunning` guidance interpolates requiredModel (was health-checking/onboarding the wrong model vs CLI's gemma4:12b default) — surfaces fire 2
- ✓ `muse find` empty-state named only tasks/reminders/contacts though it also searches calendar; extracted drift-proof `formatNoMatches` (derives from DOMAIN_LABELS) so the no-match message matches the command's real scope — surfaces fire 3
- ✓ web Tasks view rendered task dates in the runtime-default locale (lone view not threading `useI18n().locale`); extracted `formatTaskDate(iso, locale)` + wired locale so KO users see KO-formatted dates like every other view — surfaces fire 4
- ✓ desktop `MuseBridge.parseAnswer` leaked raw JSON to the bubble (and spoke it aloud) when `chat --json` returned valid JSON with an empty `response`; now returns "" on decode-success so the silent "nothing in your notes" UX fires, cleanAnswer fallback reserved for genuinely non-JSON output — surfaces fire 5
- ✓ `muse contacts birthdays --within` swallowed bad input (`abc`→silent default 30, `-5`→"next -5 days") unlike its MCP tool twin (1..365 clamp) and sibling CLI flags; now rejects non-finite/<1 with exit 1 + clamps to 1..365 — surfaces fire 6
- ✓ web Memory subtitle dangled a bare "Updated"/"업데이트" label (baked into `memory.subtitle`) when the memory had no `updatedAt`, in both locales; split the label into a `memory.updated {when}` key + `memorySubtitle` helper so the subtitle is a clean sentence when absent — surfaces fire 7
- ✓ desktop `stripCitationsForSpeech` spoke leaked source file paths aloud — the receipt-strip regex `\s*📎[^\n]*` only removed the multi-line receipt's HEADER line; widened to `\s*📎[\s\S]*` (trailing receipts) so the whole block is dropped from speech (+JUDGE-DRILL: verifier proved it FAILs an inert test, PASSes the real RED→GREEN one) — surfaces fire 8
- ✓ `muse remind list --search <text>` free-text filter (sibling parity with `tasks list`; reminders-list had only --status/--local/--json despite reminders carrying a searchable `text`); pure `filterRemindersBySearch` + total recompute across local/API/fallback paths — surfaces fire 9
- ✓ web Today `timeUntil` showed "in 0m"/"0분 후" for events 0–29s away (`Math.round` to 0 minutes); now-guard widened to `ms<0 || min===0` so the rounds-to-zero window reads "now"/"지금" — surfaces fire 10
- ✓ desktop `MusePresenter.present` returned `speechText: ""` (not nil) for a receipt/citation-only answer that strips to empty — the consumer's `if let speech` then animated the orb "speaking" + spoke an empty utterance; collapse empty stripped speech to nil (honors the documented nil⇒silent contract) — surfaces fire 11
- ✓ `muse checkins list --status` swallowed typos (`fierd`→"No fierd check-ins.", exit 0, indistinguishable from a real empty result) unlike the strict `tasks list --status`; added enum {scheduled,fired,all} validation → stderr error + exit 1 + did-you-mean — surfaces fire 12
- ✓ web decorative `Icon` SVGs (shared `base` factory in ui.tsx) lacked `aria-hidden`/`focusable`, so screen readers announced stray/doubled graphics on title-named icon buttons; added `aria-hidden="true" focusable={false}` → every Icon inherits it (a11y) — surfaces fire 13
- ✓ `muse followup list --status` swallowed typos via lenient readFollowupStatusFilter (any unknown → silent "scheduled", wrong set shown) — the last unhardened --status sibling; added enum {scheduled,fired,cancelled,all} validation → stderr error + exit 1 + did-you-mean — surfaces fire 14
- ✓ desktop `OllamaHealth.parse` ignored Ollama's implicit `:latest` tag, so a bare-pulled model read as missing (diverging from the CLI's findOllamaModelTag identity rule) → companion onboards a model already present; normalize bare↔:latest both sides — surfaces fire 15
- ◦ NOTE (surfaces fire 15 scout): desktop MuseDesktopCore pure-module vein is thinning — VoiceGate/CompanionPrefs/Sprite*/Localization/AnswerPresentation all verified correct. Next `desktop` turn should rotate to web/cli unless a fresh defect surfaces.
- ✓ web Calendar `dayLabel` derived "tomorrow" as now+86.4M ms, mislabeling events on DST-transition days (23h/25h) + corrupting byDay grouping; derive from the calendar date `new Date(y,m,d+1)` (DST-safe) — surfaces fire 16
- ◦ NOTE (surfaces fire 16 scout): web `@muse/web` genuine-defect vein also thinning — formatters/guards/a11y/empty-states largely correct after fires 1/4/7/10/13/16. Lean to `cli` next; revisit web for clear-value UX/capability adds.
- ✓ `muse tasks list` --help said "newest-first" but the list sorts by due date (compareTasksByDueDate, intentional) — corrected the description to "by due date (soonest first; undated last)"; +JUDGE-DRILL (verifier FAILed an order-only inert test, PASSed the real description RED→GREEN lock) — surfaces fire 17
- ✓ `muse today` resurface line emitted "💭 1 days ago" at the 1-day bucket (no singular guard, unlike sibling formatters); added `day${days===1?"":"s"}` — surfaces fire 18
- ✓ `muse contacts list --json` — sibling-parity scripting flag (overdue/dupes/related/import all had --json; the full-roster list, the most pipe-into-jq command, lacked it); composes with --search, empty→[] — surfaces fire 19
- ✓ web sidebar nav marked the active view only with a CSS class — added a `<nav>` landmark + `aria-current="page"` (extracted i18n-free `SidebarNav` for renderToStaticMarkup testing); a11y on the every-screen control — surfaces fire 20
- ✓ web LangToggle (EN/한) conveyed the active language only via CSS class — added `aria-pressed` (canonical toggle-button pattern; container role=group+aria-label already present) — surfaces fire 21
- ◦ NOTE (surfaces fire 21 scout): cheap pure-props-injected a11y vein ~exhausted (SidebarNav, LangToggle done). Remaining a11y (CommandPalette combobox/listbox, Tasks filter aria-pressed) needs a presentational extraction or threading aria props through the shared Button — still real, but "extraction/wiring" slices, not one-attribute micro-fixes.
- ✓ desktop `MUSE_DESKTOP_SPEAK` silence toggle only honored exact "0" → `false`/`no`/`off` still spoke; extracted pure `selectSpeakerKind(env)` (MuseDesktopCore) accepting common falsy values + delegated SpeakerFactory to it — surfaces fire 22
- ◦ NOTE (surfaces fire 18 scout): cli `@muse/cli` format-string/validation vein thinning (most counts already `===1`-guarded, validation families hardened). ~1-2 high-conf format slices left; future fires likely more productive on behavioral gaps (missing flags, cross-command consistency) than format bugs.
- ✓ `upcoming_birthdays` agent tool — conversational "whose birthday is coming up?" (resolveUpcomingBirthdays was CLI/brief-only, no agent tool) — tool-hardening fire 47
- ✓ `on_this_day_notes` agent tool — conversational date-cued note recall (muse on-this-day was CLI-only; pure recall logic moved to @muse/mcp, CLI re-exports) — tool-hardening fire 48
- ✓ `feeds_search` agent tool — conversational watched-feed archive search (CLI-only + only knowledge_search covered it, off by default → default-posture gap) — tool-hardening fire 49
- ✓ `find_contact` hardening — surfaces `about`/`connections` (recall material the handler dropped, e.g. "allergic to nuts") so "what do I know about Bob?" answers from the tool; reverse-lookup by phone/email/@handle locked + advertised — tool-hardening fire 50
- ✓ `muse.tasks.list` tag filter — "show my tasks tagged work" (list filtered only by status/dueWithinDays; tags first-class but unfilterable) — tool-hardening fire 51
- ✓ `overdue_contacts` agent tool — "who haven't I talked to in a while?" relationship-decay nudge (overdueContacts was CLI-only; tool placed in @muse/autoconfigure to avoid a new dep edge, interactionsFromEvents moved there, CLI re-exports) — tool-hardening fire 52
- ✓ ADD coverage: `interactionsFromEvents` invalid-`startsAt` drop branch (`Number.isFinite(event.ms)`) — was uncovered by both autoconfigure + CLI tests; mutation-proven (RED on filter removal) — test-hygiene fire 1
- ✓ FIX flaky timeout: `@muse/mcp playbook-store "weighted eviction"` was intrinsically ~5.1s (121 sequential recordPlaybookStrategy disk writes) → rewrote setup to 1 writePlaybook pre-seed + 1 record overflow (285ms), same assertions, mutation-proven (FIFO mutant → RED) — test-hygiene fire 2
- ✓ ADD coverage: `formatCoarseAge` ≥2-year branch (`.toFixed(0)` whole years) in @muse/recall — only the <2y 1-decimal path was tested; mutation-proven (toFixed(1) mutant → '2.2y'≠'2y' RED) — test-hygiene fire 3
- ✓ PRUNE a2a double-run: deleted 5 subsumed `src/*.test.ts` (peer-config·receive-quarantine·signing·council-wire·handler), migrated 2 unique security cases to the `test/` twins; testFiles 924→919; mutation-proven, 3 judge rounds (2 caught real loss) — test-hygiene fire 4
- ✓ ADD SSRF coverage: `assertPublicHttpUrlSync` sync gate (mcp/web-url-guard.ts) had zero direct tests — 5 cases (protocol/blocked-host/private-addr/ok), each guard clause mutation-pinned — test-hygiene fire 5
- ✓ ADD `createToolResultQualityAuditFilter` gating: direct unit test pins the verified-source + tool-ran gates (an honest apology survives when no source backs a rewrite); each clause isolated + mutation-pinned — test-hygiene fire 6
- ✓ PRUNE `model/src/index.test.ts` (3 type-conformance tautologies — assert what was just written; tsc + test/model.test.ts + provider-wire cover the real shape/behavior) — test-hygiene fire 7
- ✓ FIX byte-hygiene baseline regression (raw U+200B in `scripts/eval-policy-symmetry.mjs:36` + `docs/goals/loops/differentiation.md:262`, both differentiation-loop files) → `\u200b` escape, value-preserving; unblocked repo-wide `pnpm check` — test-hygiene fire 7
- ✓ ADD `createToolResultQualityAuditFilter` empty-remainder (`rest.length===0`) branch — apology-only answer preserved, not mangled into an empty result header; mutation-pinned; + self-fixed raw U+200B pasted into the fire-7 journal/backlog while documenting the fire-7 byte fix — test-hygiene fire 8
- ✓ JUDGE-DRILL (fire 9): injected an inert `typeof===string` test → ④b judge correctly returned FAIL (mutation-immune) → rolled back; proves the judge isn't rubber-stamping. + ADD `formatDueLocal` tomorrow/in-N-days branch-precise coverage (was only loose-OR-matched); redundant unparseable case removed per judge — test-hygiene fire 9
- ✓ PRUNE model double-run: `isRetryableHttpStatus` tested by both `src/provider-base.test.ts` (8 cases, fuller) + `test/is-retryable-http-status.test.ts` (4); migrated test/'s unique `499→false` lower-boundary into src/ then deleted test/; mutation-pinned (≥500→≥499 reds 499); testFiles 943→942 — test-hygiene fire 10
- ✓ PRUNE tools double-run (`muse-tools-helpers` pair): `src/`(11 cases) is a strict behavioral superset of `test/`(7) for the arg-parser helpers; deleted the lesser `test/muse-tools-helpers.test.ts`; readOptionalDate 3-state mutation-pinned (both invalid sub-branches); testFiles 944→943 — test-hygiene fire 11
- ✓ PRUNE tools double-run (`muse-tools-time` pair): kept the fuller `test/`(18→19), deleted `src/muse-tools-time.test.ts`(13); migrated 2 src-unique cases first (uppercase weekday + Asia/Seoul non-UTC zone — the latter caught by ④b judge's 1st FAIL), both mutation-pinned; testFiles 945→944 — test-hygiene fire 12
- ✓ PRUNE tools double-run (`muse-tools-text` pair): kept the fuller `src/`(18→20, has the 3 caps), deleted `test/muse-tools-text.test.ts`(14); migrated 2 test-unique cases first (ZWJ-family grapheme + MarkdownTable column-union/empty-fill — the latter caught by ④b judge's 1st FAIL), both mutation-pinned; testFiles 946→945 — test-hygiene fire 13
- ✓ FIX flaky de-flake: `@muse/messaging pending-approval-store "caps to 200"` 205 sequential records (~3s, 5028ms timeout under load) → 1 fs.writeFile seed + 1 record (3040ms→73ms), same assertions, mutation-pinned — test-hygiene fire 14
- ✓ PRUNE tools double-run (`muse-tools-data` pair, LAST one): kept the fuller `src/`(20→23), deleted `test/muse-tools-data.test.ts`(17); migrated 3 test-unique security cases (CsvParse 200k + Base64 500k DoS bounds + padBase64 %4===3); DoS guards mutation-pinned; single-pass judge PASS (exhaustive upfront compare); testFiles 952→951 — test-hygiene fire 15
- ✓ ADD `contactMatchScore` accumulation + alias DIRECT cases in @muse/recall (tighter toBe(3)/toBe(1) vs the indirect CLI `>0`); mutation-pinned. NOTE: both branches were already INDIRECTLY covered by apps/cli — marginal value; signals recall direct-test gaps are mostly filled (easy ADD vein thinning) — test-hygiene fire 16
- ✓ PRUNE redundant colocated `agent-core/src/citation-sanitiser.test.ts` (7 cases) — surviving `test/citation-sanitiser.test.ts` is a strict superset (proven: mutation REDs it 2/5; independent Opus judge git-show-restored + enumerated all 7 covered); testFiles 958→957. NEW VEIN: ~30 same-named src+test pairs across agent-core/mcp/messaging/model/autoconfigure (NOT dist double-run — config excludes dist; two source files testing one module) — each needs per-pair superset check before pruning — test-hygiene fire 17
- ✓ CONSOLIDATE model same-named pair `web-search-policy` (src/ 213L fuzz-rich + test/ 87L tested decideWebSearchPolicy twice, ~11 overlapping cases) — src/ covered all but ONE test/ behavior (disabled policy still carries resolved maxUses); migrated that unique case into src/, deleted test/. Mutation: override===false→DEFAULT_MAX_USES REDs ONLY the migrated case (unique guard). NOTE: unlike fire-17's clean subset, these pairs are often COMPLEMENTARY (each holds unique cases) → consolidate (migrate-then-delete), not blind prune; judge maps all behaviors. testFiles 958→957 — test-hygiene fire 18
- ◦ ENV (not a test-quality bug): apps/api `test/messaging-webhooks.test.ts` buildServer cases hit the 20000ms vitest timeout under concurrent 6+ loop CPU load (isolated re-run 4/4 in 9.4s). Same class as the earlier playbook-store/pending-approval 5000ms load-timeouts — candidate: raise testTimeout for buildServer-starting suites, or fewer concurrent loops. Do NOT "fix" the test.
- ✓ ADD @muse/policy pii-patterns finding-COUNT coverage (maskPii (get??0)+1 + findPii +matches.length) — all 13 existing tests asserted .name only, count was unpinned; 3 emails→3, 2 SSNs→2, each accumulation path mutation-RED in isolation. Includes the fire-19 JUDGE-DRILL: injected an inert value-blind ADD into model/web-search-policy → independent ④b judge FAILed it (mutation stayed green) → rolled back, counter reset — test-hygiene fire 19
- ✓ CONSOLIDATE mcp same-named pair `atomic-file-store` (src/ 68L + test/ 91L both ran atomicWriteFile/withFileMutationQueue) — queue cases fully duplicated; test/ already had 3 unique atomicWriteFile cases (0600 mode/fsync/tmp-orphan-on-fail), src/ had 1 unique (40 concurrent writes no-ENOENT randomUUID guard) → migrated it, deleted src/. Mutation: drop randomUUID → exact ENOENT REDs only the migrated case. First mcp pair done; 13 mcp pairs remain (per-pair subset/complementary check). testFiles 960→959 — test-hygiene fire 20
- ✓ ADD @muse/resilience computeRetryDelay floor-clamp coverage (multiplier Math.max(1,…) + maxDelay Math.max(initial,…)) — all existing tests used multiplier≥2 & maxDelayMs>initial, both misconfig-knob clamps unpinned; mult 0.5→25 / maxDelay 50→50 each mutation-RED its own assertion. Same defense family as the NaN guard (a multiplier<1 silently shrinks backoff → hammers a failing provider) — test-hygiene fire 21
- ✓ CONSOLIDATE mcp same-named pair `run-actuator-by-name` (colocated src/ 12 cases incl. outbound-safety acceptance + action-log vs thinner test/ 5 cases) — src/ covered all but 1 test/ behavior (failure detail contains "HTTP 500"); migrated that assertion into src/'s 500 case, deleted test/. Mutation: drop "(HTTP <status>)" from web-action.ts:173 → only the migrated assert REDs. No fail-close/approval/action-log coverage lost (judge-verified). 2nd mcp pair; 12 remain. testFiles 966→965 — test-hygiene fire 22
- ✓ ADD @muse/agent-core enforceSystemPromptBudget unknown-section DEFAULT_SECTION_PRIORITY(55) coverage — existing enforce tests used only known section ids, the `?? DEFAULT_SECTION_PRIORITY` fallback was unpinned; skills(50)<unknown(55)<episodic(60) drop-2 sheds skills then unknown, keeps episodic; mutation 55→0/→100 each REDs (brackets the value both sides). Pins the "new transform never silently most-evictable" invariant — test-hygiene fire 23
- ✓ PRUNE mcp same-named pair `undo-action` (colocated src/ 4 cases is a strict superset of thinner test/ 3 cases — src/ case 1 is a full act→undo→re-tick e2e; covers reversible-reverse+detail, irreversible+veto, veto-overrides-consent fail-close; case 4 hasVeto scope-exactness is src-unique). Clean superset, no migration. Mutations (skip recordVeto / drop reverse / corrupt scope) RED surviving cases; judge confirmed no veto/consent/fail-close coverage lost. 3rd mcp pair; 11 remain. testFiles 972→971 — test-hygiene fire 24
- ✓ CONSOLIDATE agent-core same-named pair `model-invocation` (small colocated src/ 6 cases vs far-richer test/ — invokeModel/failure-injection/token-usage 323L) — test/ covered src/'s applyCitationSanitisation + metadata-preserve but its buildModelRequestWithWebSearch coverage only checked "defined"; migrated src/'s 2 unique wiring cases (settings→policy VALUE, override=false suppression) into test/, deleted src/. case4 (no-slash) skipped: decideWebSearchPolicy ignores model (dead input, judge-confirmed). Mutations on settings/override wiring each RED their case. testFiles 973→972 — test-hygiene fire 25
- ✓ ADD @muse/memory trimConversationMessages hardBudget≤0 no-user sub-branch — existing tests covered "has-user→keep-last" + "single→unchanged" but not "no user + multi-message → keep all" (the lastUserIndex>=0 guard). Mutation dropping the guard makes the no-user case anchor on messages[-1]=undefined → crash; only the new test REDs. Context-trim provider-safety edge — test-hygiene fire 26
- ✓ PRUNE messaging same-named pair `is-approval-reply` (thin colocated src/ 4 cases vs richer test/ — full APPROVALS + normalisation + fail-close battery + non-string guard) — test/ strict superset of the consent gate (isApprovalReply); deleted src/, no migration. Mutation has→substring REDs 7 fail-close cases. Includes the fire-27 JUDGE-DRILL: a coverage-loss prune (deleting the FULLER test/) was injected → judge correctly FAILed it (enumerated lost fail-close behaviors) → rolled back, counter reset. messaging 1st pair; 3 remain. testFiles 977→976 — test-hygiene fire 27
- ✓ ADD @muse/memory extractJsonObject escape-handling branch in findBalancedBraceBlocks — existing brace-in-string tests used only unescaped braces; the slow-path scanner's escape branch (an escaped \" must not toggle string-state) was unpinned. Prose wrapper forces slow path; mutation escape=true→false makes the \" end the string early → block mis-closes → undefined; only the new test REDs (unique sentinel, sibling suite green). New merged module's trickiest branch — test-hygiene fire 28
- ✓ PRUNE mcp same-named pair `loopback-helpers` (thinner test/ 65L vs fuller src/ 95L; 6 shared shape readers) — src/ superset covers every test/ behavior equal-or-stronger across all 6 helpers + unique cases (empty-string, all-non-string→[], errorMessage(undefined), fresh-required-array defensive copy). Deleted test/, no migration. Mutation readBoolean→accept-any REDs surviving src/. 4th mcp pair; 10 remain. testFiles 980→979 — test-hygiene fire 29
- ✓ PRUNE mcp same-named pair `reflections-store` (4-case colocated src/ vs 9-case test/) — test/ strict superset (add+round-trip, normalised-insight dedupe, newest-first, tolerant/tamper-filter reads incl. corrupt-row/non-object) + unique (in-batch dedupe, empty-list, MAX_REFLECTIONS recency-cap); deleted src/, no migration. 3 mutations (normalize/sort/read-filter) RED surviving cases. 5th mcp pair; 9 remain. NOTE: shared crypto/redactSecretsInText fully covered (connection-uri ADD attempt was redundant via goal-309). testFiles 984→983 — test-hygiene fire 30
- ✓ ADD @muse/model parseOpenAIToolCalls mixed-array robustness + original-index id — existing tests used a single valid entry (id→tool_call_0) + non-array/empty guard; per-entry drop of a malformed entry in a mixed array and the original-index defaulted id (tool_call_2) were uncovered. Mutations (remove name-string filter / tool_call_${index}→0) each RED only the new test. Grounding/tool path in a newly-merged module. NOTE remaining gap: parseOpenAIUsage nested cached_tokens/reasoning_tokens extraction still untested (future ADD) — test-hygiene fire 31
- ✓ ADD @muse/model parseOpenAIUsage nested cached/reasoning token extraction (cachedInputTokens from prompt_tokens_details, reasoningTokens from completion_tokens_details) — existing test passed flat fields only; nested sub-object reads uncovered. Mutations (read flat instead of nested) each RED only the new test. provider-openai-parse module now fully covered (4 fns) — test-hygiene fire 32
- ✓ CONSOLIDATE mcp same-named pair `briefing-imminent` (4-case colocated src/ vs 8-case test/; deriveBriefingImminent tasks + deriveCalendarBriefingImminent calendar) — test/ covered calendar+most-task equal-or-stronger; migrated src/'s 3 unique TASK cases (past-due lower-bound, unparseable-dueAt NaN guard, finite custom leadMinutes window-shrink) into test/, deleted src/. 3 mutations RED the migrated cases. NOTE: judge waved the leadMinutes case as 'equivalent' but maker caught the gap (test/'s only lead test NaN→120 coincides with a lead-hardcoded-120 mutation) → added+proved it. 6th mcp pair; 8 remain. testFiles 993→992 — test-hygiene fire 33
- ✓ PRUNE messaging same-named pair `pending-approval-store` (6-case colocated src/ vs 17-case test/) — test/ superset (record+list, expired-filter+strict-> boundary, channel-scope+newest-sort, clearById x3, tolerant read+quarantine, filterUnexpired pure+immutability+200-cap); deleted src/. src/ case1 re-run-args round-trip (verbatim filter, non-mutatable) migrated as a toMatchObject strengthening into test/'s worklist case. Mutations (isPendingApproval/expired-filter/sort) RED 4 surviving cases. 2nd messaging pair; 2 remain. testFiles 994→993 — test-hygiene fire 34
- ✓ ADD @muse/observability MonthlyBudgetTracker reset-before-validity ordering — recordCost rolls month over before the non-finite/negative validity check, so a NaN cost first in a new month reports fresh-$0 'ok' not last month's 'exceeded'; existing tests covered same-month non-finite + currentCost-triggered rollover only. Mutation (swap validity-before-reset) REDs only the new test. Includes fire-35 JUDGE-DRILL: inert type/enum-only ADD injected → judge FAILed it (2 mutations stayed green) → rolled back, counter reset — test-hygiene fire 35
- ✓ PRUNE autoconfigure same-named pair `response-filters` (5-case colocated src/ vs 12-case test/) — test/ strict superset of responseLocales (default/single/case-whitespace/mixed-drop/fallback) + adds createResponseFilters coverage; deleted src/. src case5's '   ' whitespace sub-case proven redundant (parseCsv('   ')=undefined → same ??-default branch as unset; no mutation distinguishes). Mutations (ko/en restriction, size===0 fallback) RED surviving cases. 1st autoconfigure pair; provider-utils remains. testFiles 998→997 — test-hygiene fire 36
- ✓ ADD @muse/memory scoreMessageContent DECISION_HINTS break — the hint loop adds +0.2 then breaks, so multiple decision words still cap at +0.2 once; existing decision-vocab tests used single-hint messages only. Two-hint message scores 0.5 (not 0.7 accumulated); removing break REDs only the new test. NOTE: message-importance is near-exhaustively covered by a prior loop — thin remaining ADD vein — test-hygiene fire 37
- ✓ CONSOLIDATE mcp same-named pair `objective-evaluation-loop` (6-case colocated src/ vs 10-case test/; runDueObjectives standing-objective engine) — test/ covered all but 1 src behavior (met→done, unmet→backoff, unmeetable→escalate+sink, maxAttempts, fail-open throwing-evaluator+sibling); migrated src's unique 'act() throws on MET → not fired/not done/stays active' (a met condition whose action failed must not be marked done). Mutation: mark-done-before-act REDs the migrated case. judge verified the escalate-sink + throwing-evaluator claims are genuinely in test/. 7th mcp pair; 7 remain. testFiles 999→998 — test-hygiene fire 38
- ✓ ADD @muse/recall untrustedOnlyGroundingNotice per-claim untrusted branch — the grounded≠true mixed-answer edge (whole-answer gate clears on a trusted note but a specific claim rests only on a poisonable tool source) was uncovered; existing tests only hit whole-answer-untrusted + all-trusted-silent. probe-verified, then test asserts per-claim wording + the surfaced claim; removing the per-claim block REDs only the new test. NOTE remaining gap: citationPrecision/Recall 80-char truncation untested (future ADD) — test-hygiene fire 39
- ✓ CONSOLIDATE mcp same-named pair `web-action-tool` (far-richer colocated src/ 12 cases incl. SSRF×4/DNS-rebinding/method-validation vs thinner test/ 5) — src/ covered all but 2 tool-calling-reliability cases; migrated test/'s validateToolDefinitions-clean+additionalProperties:false+Korean keyword 예약 and the use-when/not+payments description into src/, deleted test/. Mutations (drop 예약, weaken description) RED their cases. 8th mcp pair; 6 remain. NOTE: channel-approval-gate is unit↔integration complementary (skipped). testFiles 1003→1002 — test-hygiene fire 40
- ✓ `muse.tasks.search` matches tags — a task tagged "work" (word not in title/notes) is now found by searching "work" (completes the fire-51 tag story: list FILTERS by tag, search now FINDS by tag) + JUDGE-DRILL (verifier caught a deliberately-inert version) — tool-hardening fire 53
- ✓ `week_agenda` agent tool — "what's my week look like?" ONE merged view of events+tasks+birthdays by day (muse week was CLI-only; groupWeekAgenda moved to @muse/autoconfigure, CLI re-exports) — tool-hardening fire 54
- ✓ `recent_actions` agent tool — "what have you done for me?" lists Muse's autonomous action log (performed/refused/failed, what+why+when) most-recent-first; was CLI-only (muse actions); internal userId/id/prevHash not leaked — tool-hardening fire 63
- ✓ `muse.calendar.list` query filter — "find my meeting with Bob this week" was inexpressible (list had only from/to/provider, no text filter; reminders.list already has search); added optional `query` over title/location/notes — tool-hardening fire 62
- ✓ `home_action` blast-radius guard — an entity-less service call (e.g. `light.turn_off` with no entity) is HA's "apply to EVERY device in the domain" path (whole-house off / every-lock unlock); now fail-closed unless entity or a data target (entity_id/area_id/device_id/target) resolves a scope — tool-hardening fire 60
- ✓ `list_objectives` agent tool — "what objectives are you tracking for me?" lists Muse's live standing objectives (active/escalated); were CLI/passive-only, no agent tool — tool-hardening fire 59
- ✓ `web_action` method validation — a model-emitted GET (read verb) for a book/post intent silently reported performed:true (false success); a garbage verb hit fetch opaquely. Now an allow-set {POST,PUT,PATCH,DELETE} shared by schema enum + handler, fail-closed before approval/HTTP — tool-hardening fire 58
- ✓ `web_action` SSRF-after-redirect closed — the state-changing web actuator followed a 3xx (body included on 307/308) to a private/loopback host the URL guard never vetted; now `redirect:"manual"` + fail-closed on 3xx (the read path already re-checked; the write path didn't) — tool-hardening fire 55
- ✓ `muse.tasks.list` tag filter — "show my tasks tagged work" was inexpressible (list filtered only by status/dueWithinDays, search ignores tags) though tags are first-class + CLI `--tag` exists; added optional `tag` (case-insensitive exact, both branches) — tool-hardening fire 51
- ✓ `egressGuards` self-eval ratchet — local-by-construction moat (cloud egress refused in code) promoted to a deterministic scoreboard regression gate, mirroring the grounding ratchet (a structural edge hermes/openclaw can't copy) — differentiation fire 1
- ✓ `egressGuards` ratchet widened to the voice egress guard — mic audio's cloud STT/TTS path now ratcheted too (drop the MUSE_LOCAL_ONLY voice cloud-key-ignore → self-eval exits 1); value 5→6 — differentiation fire 2
- ✓ `eval:memory-poisoning` adversarial proof battery — proves Muse drops a model-asserted/poisoned claim at WRITE time (`dropModelAssertedValues`) that rivals' frequency-promotion (OpenClaw dreaming minRecallCount 3) would promote; deterministic, no Ollama — differentiation fire 3
- ✓ embedder local-only egress gap CLOSED — `createOllamaEmbedder` followed `OLLAMA_BASE_URL` with no local-only check (chat router only gates it for providerId ollama; daemon bypassed the router), so a remote `OLLAMA_BASE_URL` egressed the user's raw note/memory/episode text under MUSE_LOCAL_ONLY; added construction-time fail-close + 6 behavioural tests + folded the throw into the egressGuards ratchet (6→7) — differentiation fire 4
- ✓ browser act-path ambiguous-target fail-close — element matcher silently clicked/typed the FIRST of several tied "best" matches (two "Delete" buttons → guessed); now `matchElementResult` → `ambiguous` refuses `browser_click`/`browser_type` BEFORE snapshot-mutation/approval-gate, returns candidates + ordinal hint (closes an outbound-safety fail-open hole) — tool-mcp-browser fire 1
- ✓ official-public-MCP preset registry (axis B) — `packages/mcp/src/official-mcp-presets.ts`: curated `createGitHubMcpServer` (`https://api.githubcopilot.com/mcp/`) + `createNotionMcpServer` (`https://mcp.notion.com/mcp`) streamable factories, each carrying an official anyone-may-connect provenance URL + a FAIL-CLOSE `toolRisk` classifier (read tools listed, every write/unknown → `write`) + `withOfficialMcpRisk` projection (domain `external`); wired through the existing `allowedServerNames` allowlist; contract-faithful transport-fake test proves allowlisted connects/read-surfaces & non-allowlisted refuses & write stays gated — tool-mcp-browser fire 2
- ✓ external-MCP presets wired LIVE (axis B, opt-in, write-gated) — per-server env toggles (`MUSE_GITHUB_MCP_ENABLED`/`MUSE_NOTION_MCP_ENABLED`, derived `MUSE_<NAME>_MCP_ENABLED`) register the dormant preset into `assembleMcpStack` + strict allowlist ONLY when set (default OFF), and `withOfficialMcpRisk(withChromeDevToolsRisk(toMuseTools()))` in the live projection re-stamps write/unknown external tools to `write` so they hit `toolApprovalGate` (the toggle alone would be fail-OPEN — shipped coupled). No secret, autoConnect false; 10 behavioural cases (off⇒absent, on⇒read usable, on⇒write gated). Mirrors the chrome-devtools precedent exactly — tool-mcp-browser fire 3
- ✓ browser_type fail-close on non-typeable target (axis C) — a `type` intent whose only match was a button/link silently matched it, drafted "type X into <button>", the user CONFIRMED, then `controller.type`/`locator.fill` threw on the button (misleading outbound-safety draft + wasted confirm + no retarget signal); matcher now returns `notypeable` and `browser_type` refuses with the page`s real text fields BEFORE the approval gate. Distinct from fire-1 ambiguous-tie (this is wrong-KIND-of-target); click/hover unchanged. 72 browser tests, eval:browser-agent 1/1 LIVE — tool-mcp-browser fire 4
- ✓ external-MCP write draft-first e2e PROOF (axis B, outbound-safety capstone) — new battery drives the REAL McpManager register/connect/toMuseTools + withOfficialMcpRisk + AgentRuntime toolApprovalGate (transport-only `callTool` spy, NOT a fake registry) proving GitHub `create_issue` (risk write) is gated and deny/timeout-undeliverable/absent-consent ⇒ ZERO transport write calls, confirmed ⇒ exactly one, read (`get_me`) ungated. Non-vacuous: allow-through/skip-restamp mutation (test-side AND prod-side) makes the deny cases RED. 6 cases — tool-mcp-browser fire 5
- ✓ browser link destinations surfaced to the model (axis C, read-side capability) — link elements carried no URL (snapshot read href only for dedup then discarded it), so the model could click a link but never report WHERE it goes without navigating ("what`s the link to their pricing page?" was inexpressible); now `SnapshotElement.url` carries each anchor`s resolved ABSOLUTE href into the browser_read/browser_open element JSON (emitted only when present, buttons/fields unchanged) + browser_read description advertises link-destination answers. No new tool (augments read path, keeps the 9-tool set). 75 browser tests, smoke #19 LIVE (absolute+relative-resolves+non-link-none), eval:browser-agent 1/1, eval:tools 97% no mis-selection — tool-mcp-browser fire 6
- ✓ external-MCP preset credential resolution (axis B) — enabled GitHub/Notion presets now resolve the user`s token from `GITHUB_MCP_TOKEN`/`NOTION_MCP_TOKEN` env or `~/.muse/mcp-credentials.json` (existing readCredentialsSync env-wins-then-file secure seam, same as model/messaging keys) and inject `Authorization: Bearer <token>`; absent credential ⇒ preset NOT enabled & NOT allowlisted (fail-closed, no blank-auth half-connection); secret never in any serialized/loggable safe-config (leak test catches token AND "Bearer"). 21 cases (13 resolver + 8 behavioral) — tool-mcp-browser fire 7
- ✓ browser navigation-status fidelity for open/back (axis C) — page.goto/goBack resolve (don't throw) on HTTP 4xx/5xx, so a 404/500 error page was returned to the model AS IF the requested content (silent grounding hole); now PageSnapshot.httpStatus is captured from the goto/goBack HTTPResponse (consume-once in snapshot() AFTER the settle-retry loop) and browser_open/browser_back emit {httpStatus, statusError} only when >=400 (200/absent silent). Honest redo of rolled-back fire 8 — open/back ONLY, NO click claim/fake test. 84 tests + LIVE smoke #20 (real headless Chrome vs localhost 404/200) — tool-mcp-browser fire 9
- ✓ muse doctor reports external-MCP preset posture (axis B) — `muse doctor --local` now shows, per official-public preset (GitHub/Notion), enabled (env toggle) + credentialPresent (BOOLEAN, never the token) + allowed (allowlist) + official provenanceUrl, so a privacy-first user audits which external servers the agent is eligible to reach and why. Pure describeOfficialMcpPosture(env) in autoconfigure + cli doctor wiring; leak-guard test RED-able (token 0 occurrences, live-verified). Completes the external-MCP trust/observability story — tool-mcp-browser fire 10
- ✓ browser prompt-dialog response fidelity (axis C) — a native JS prompt() was auto-accepted with a bare dialog.accept() = EMPTY string, discarding the page's own defaultValue (prompt("Enter coupon","SAVE10") sent blank, breaking an approved action with no signal); now prompt dialogs accept with the dialog's OWN defaultValue (never invented text) and surface the submitted text as PageSnapshot.dialog.response. alert/confirm/beforeunload unchanged. RED-able vs REAL headless Chrome (live smoke 10b: revert→blank RED, fix→SAVE10). 85 tests — tool-mcp-browser fire 11
- ✓ external-MCP registry EXPANSION: Linear (axis B, 3rd official-public preset) — added Linear's official hosted remote MCP (https://mcp.linear.app/mcp, provenance linear.app/docs/mcp, OAuth2.1 + Authorization: Bearer personal API key, anyone-may-connect — judge-verified vs Linear's own docs) reusing the full machinery: registry factory + fail-close linearMcpToolRisk (23 documented read tools→read, all create/update/unknown→write) + auto-derived MUSE_LINEAR_MCP_ENABLED toggle + LINEAR_MCP_TOKEN credential + doctor posture. Hardened the credential resolver: presetEnvTokenKey() now auto-derives <NAME>_MCP_TOKEN GATED on Object.hasOwn(OFFICIAL_MCP_PRESETS,name) (arbitrary name never reads an ambient env token — env-exfil surface closed). No secret shipped — tool-mcp-browser fire 12
- ✓ browser CDP protocolTimeout bounded (axis C, reliability) — puppeteer's default protocolTimeout (180s) was left unset and the snapshot-capture page.evaluate calls (innerText/element-walk) had NO higher-level timeout, so a stuck CDP roundtrip hung the agent ~3min with no recovery (a prod agent can't be SIGKILLed); now connect() threads protocolTimeout = max(requested, timeoutMs+15s) (default 30s, ~6x under 180s) — ALWAYS above the per-op timeout so a legit slow nav/click/fill is never killed first. RED-able vs REAL headless Chrome (smoke #21: a HANG_HTML innerText forever-getter; reverted→pending 45s+, fixed→fast-fail ~19.5s). 89 tests — tool-mcp-browser fire 13
- ✓ external-MCP registry EXPANSION: Sentry (axis B, 4th official-public preset) — added Sentry's official hosted remote MCP (https://mcp.sentry.dev/mcp, provenance getsentry/sentry-mcp, anyone-may-connect via the vendor OAuth flow — judge-verified) reusing the full machinery (registry + fail-close sentryMcpToolRisk [27 read tools→read, all create/update/add/unknown→write] + auto-derived MUSE_SENTRY_MCP_ENABLED + SENTRY_MCP_TOKEN + doctor posture). Error/monitoring = a 4th distinct dev category (after code/docs/issues). AUTH NUANCE (honest): Sentry's endpoint is OAuth-primary; direct Bearer-token is upstream-tracked not-yet-shipped (getsentry/sentry-mcp#833) — Muse's Bearer seam is forward-compatible, and absent/rejected credential fail-closes (no blank-auth half-connection), documented in the preset. No secret shipped — tool-mcp-browser fire 14
- ✓ browser_wait — wait for async content then re-observe (axis C, NEW CAPABILITY) — settleDom (400ms-quiet, runs at open/scroll) + the snapshot retry (fires only when looksUnsettled = 0 elements & <40 chars) genuinely MISS a page that's quiet-at-load then inserts content via a later timer/fetch, and there was no way for the model to say 'wait until X appears then read'. New browser_wait tool (forText substring OR CSS selector, bounded timeoutMs) polls then re-snapshots; HONEST on timeout (matched:false + timedOut + note, never throws/fabricates success — fabrication=0 aligned). RED-able vs REAL headless Chrome (live smoke #22, quiet-then-delayed-insert 2.5s); eval:tools EN case STABLE 3/3 @ 93%, NO confusable-pair regression (browser_read/scroll 3/3). KO selection 0/3 (known gemma weakness, NOT gated per agent-testing.md) — tool-mcp-browser fire 15
- ✓ nav-status fidelity extended to the ACT path (axis C) — click/type-submit/key-Enter that NAVIGATE to a 4xx/5xx error page now capture httpStatus via a new withNavStatus wrapper (arms a real page.on('response') for the main-frame document response on the current page + any new-tab target) and the 3 act tools surface {httpStatus, statusError} when >=400 (200/absent silent) — same grounding-hole class fire 9 closed for open/back, now for the act methods that never go through goto/goBack. Closes the fire-9 follow-up ◦ AND honestly completes what fire 8 faked (fire-8's judge identified the real click path never set lastHttpStatus). REAL capture proven by live smoke #23 (real Chrome click→localhost 404), RED-able by reverting the wiring. 98 tests, no tool-schema change — tool-mcp-browser fire 16
- ✓ JUDGE-DRILL (8-consecutive-PASS hard-counter) + browser_read linkCount (axis C) — DRILL: a deliberately bad slice (linkCount = snapshot.elements.length, i.e. count ALL elements not links, hidden by a NON-discriminating all-link test fixture) was injected; the independent Opus verifier CAUGHT it (proved empirically with a mixed 2-link/2-non-link fixture → returned 4 not 2; flagged the non-discriminating test per the fire-8 precedent) and FAILed it → rolled back. Then the REAL fix shipped: linkCount = elements.filter(role===link).length, emitted only when >0 (no false-zero noise), with a DISCRIMINATING test (2 links among 4 elements asserts linkCount:2 not 4; proven RED-able — the .length bug fails both new tests). Verifier reliability re-proven; firesSinceDrill reset — tool-mcp-browser fire 17
- ✓ `muse doctor` surfaces embedder OLLAMA_BASE_URL locality — `evaluateLocalOnlyPosture` now flags status `fail` when local-only is on but OLLAMA_BASE_URL is off-box (a localhost lmstudio chat + remote embedder no longer reports a false "🔒 ok"); same base resolution as the fire-4 runtime guard so doctor and runtime never diverge — differentiation fire 5
- ✓ shared `resolveEmbedderBase()` helper — fire-4 runtime guard + fire-5 doctor posture now resolve the embedder base through ONE `@muse/autoconfigure` helper, so doctor↔runtime parity is structural (can't drift) not two hand-kept literals; behaviour-preserving (532/532) + 4 helper unit cases — differentiation fire 7
- ✓ receipt verifies the quote against the file ON DISK (L4 shows-its-work) — `formatSourceReceipts` (@muse/recall) gained a disk-content map; a snippet edited/deleted after indexing is now hidden with a reason instead of quoted (fake-citation defense rivals can't pay for); proven by `eval:receipt-drift` (real temp files), backward-compat (recall 88/88) — differentiation fire 8

- ✓ JUDGE-DRILL (verifier proven) + truncated-snippet disk-verify coverage — planted an inert test, the independent Opus judge correctly FAILED it (mutation-proven), then landed a real discriminating test locking down fire-8's `…`-truncation disk-verify path (mutation: break `snippetOnDisk` → real test fails) — differentiation fire 9
- ✓ L4 LIVE — `muse ask` disk-verifies cited snippets — `buildDiskContents` (@muse/recall) reads each cited note's current content (ad-hoc skipped) and `commands-ask.ts` feeds it to the receipt, so a drifted/deleted note's snippet is now hidden from the user ("changed since" / "no longer on disk") instead of quoted as a fake citation; recall 95/95, grounding engine untouched — differentiation fire 10
- ✓ L5 action-log tamper-evidence proof battery — `eval:action-log-tamper` proves every autonomous action (performed+refused) is sealed in a genesis-anchored SHA-256 chain: edit/deletion/reorder caught at a precise index, refused actions chained, undo extends (never breaks) the chain — an integrity guarantee rivals' snapshot-rollback (hermes) / un-undoable promoted memory (openclaw #62184) lack; imports @muse/mcp read-only, deterministic, no Ollama — differentiation fire 11
- ✓ L6 deterministic-safety-as-code proof battery — `eval:policy-symmetry` proves @muse/policy guards are model-independent + language-symmetric: injection caught identically in EN/KO/CN, zero-width/homoglyph/HTML-entity obfuscation normalized then caught, PII masked non-destructively (vs hermes #5322 which writes *** into source files), benign prose not over-blocked; imports @muse/policy read-only, deterministic, no Ollama — differentiation fire 12
- ✓ differentiation proofs mechanically defended — `differentiationBatteries` ratchet in `pnpm self-eval` counts the 4 proof batteries (L2/L4/L5/L6 marker), so deleting one fails the build; `pnpm eval:differentiation` bundles all 4 into one command — the edge evidence can't silently rot (egressGuards/groundedSurfaces pattern) — differentiation fire 13
- ✓ L7 outbound fail-close proof battery — `eval:consent-fail-close` proves `performConsentedAction` (@muse/mcp) fail-closes every outbound vector (no-consent/scope-mismatch/host-mismatch/veto/timeout → ZERO external effect, fetch never called) while only a recorded scoped consent sends the credential; contract-faithful HTTP fake, deterministic; auto-folded into differentiationBatteries (4→5) — differentiation fire 14
- ✓ L7 widening: recipient resolved, never guessed (outbound-safety rule 3) — `eval:recipient-resolution` proves `resolveContact` (@muse/mcp) returns `ambiguous` with all candidates on multiple matches (never best-guesses one), `unknown` on no-match/empty/relationship-word, and resolves a unique match by name/email/handle — so "message Alex" with two Alexes clarifies instead of auto-sending to the wrong one; deterministic, ratchet 5→6 — differentiation fire 15

## ◦ Open — differentiation (vs hermes/openclaw — `differentiation` loop)

- ⏳ **fresh non-contended axis VEIN EXHAUSTED (fire 16)** — after 7 levers (L1–L7) + 6 CI-defended batteries, a research pass found no genuinely new non-contended axis; the one fresh competitor weakness (self-authored-skill admission, hermes #25833 / openclaw plaintext Dreaming) is ALREADY closed in Muse (scanSkillBodyForRisks→quarantine, deterministic draft reject, execute-gating) so it's an L2+L6 extension, not a new lever. The differentiation thesis is comprehensive. Future fires: widen/consolidate existing levers, or 진안 may retheme the loop. (differentiation fire 16)
- ◦ **(hand-off → agent-core/skill-authoring loop) `validateSkillToolReferences`** — the one genuine gap Muse lacks (Hermes #25833 dangling-reference half): validate a self-authored skill body references only tools in the live registry. Touches `packages/skills` + skill-review = owned-loop territory, not the differentiation loop's. Source: differentiation fire 16 scout.

## ◦ Open — tool-mcp-browser axis C (browser)

- ◦ BLOCKER (scout finding, fire 23) **browser vein 고갈 — same-origin iframe piercing is ALREADY shipped (no gap).** captureSnapshot's element-walk (puppeteer-controller.ts ~363) descends into same-origin iframe `contentDocument` (like shadow roots), assigns the same `data-muse-ref` scheme across frames under the BROWSER_ELEMENT_CEILING cap, and `try/catch`-skips cross-origin frames without crashing; resolveRef iterates `page.frames()` so an iframe-embedded control is both observed AND clickable. Shipped 2026-06-12 by commit 178c953a (`feat(browser): observation completeness — same-origin iframe piercing + element paging`), with the live smoke already in `scripts/smoke-browser.mjs` step 7 (real `srcdoc` iframe button observed + clickable cross-frame; RED-able by reverting the walk). The 3 candidate axis-C gaps the fire-21 scout flagged are now ALL closed: select (fire 21), file upload (fire 22), same-origin iframe read (178c953a). Recommend repointing the theme or winding down axis C (CronDelete the loop) — further C fires will honestly produce small/no-op work. (fire 23 made NO code change per the honest-stop rule.)

- ◦ (scout finding, fire 21) browser `<select>` dropdown selection is ALREADY handled — browser_type on a role=combobox/<select> grounds the text to an option via matchOption (fail-close: unmatchable option refused, options listed), confirmed in puppeteer-controller.ts type(). NOT a gap; future scouts skip it. **Browser micro-fix vein is thinning** (fires 1/4/6/9/11/13/15/16/17/18 covered ambiguity/non-typeable/link-url/nav-status/prompt/CDP-timeout/wait/linkCount/fill-form; select handled). Remaining candidate distinct C gaps to verify next: same-origin iframe read · file upload · a real CDP error-surfacing edge. If next 2 scouts also come up clean, rotate value-class per EXHAUSTION. (fire 21 deferred its code slice — API was rate-limiting subagent dispatch, so an independent ④b judge couldn't run; no unverified code committed.)

- ◦ doctor posture allowlist display nuance — `describeOfficialMcpPosture` reports `blocked` for an enabled preset absent from a NON-empty allowlist, but `assembleMcpStack` auto-adds a turnkey-enabled preset to the allowlist so it isn't actually denied at assembly; align the doctor detail to the assembled reality (report it as allowed-via-turnkey-auto-add) so the audit matches runtime. (fire-10 follow-up, cosmetic)


- ◦ official-MCP cred file-path whitespace trim + native OS-keychain backend behind `resolveOfficialMcpToken` (fire-7 follow-ups: env path trims, file path passes a whitespace-only token through as literal `Bearer   ` — cosmetic, fails auth upstream, no leak; keychain is the secure-source upgrade behind the single resolver seam).

## Done — loop infrastructure (2026-06-12, 진안-directed)

- ✓→Done **loop-engineering contract + loop-creator skill** — distilled Addy
  Osmani's "Loop Engineering" into `.claude/skills/loop-creator/references/loop-engineering.md` (6 primitives →
  Muse seams · verifiable stopping condition `/goal` · 3 failure-mode guards:
  unattended-verification / comprehension-debt / cognitive-surrender) and a
  generative `.claude/skills/loop-creator/SKILL.md` that fills the checklist,
  generates a principle-compliant recurring loop prompt, and registers the cron
  itself (delegating scheduling to `/loop`). Replaces hand-written ad-hoc loop
  prompts. FOLLOW-UP: pre-verify the skill end-to-end (theme → generated prompt →
  registered cron → reported stop method) on a real theme before relying on it.

## Done — chat-gate toolGrounded blanket bypass (2026-06-12)

- ✓→Done **toolGrounded blanket bypass** — the chat gate skipped on ANY tool call
  (`toolsUsed.length`) even when the tool returned nothing, taking the deterministic
  value checks down with it — a hole in the fabrication=0 floor on the conversational
  surface. FIX (spec `docs/superpowers/specs/2026-06-12-chat-gate-toolgrounded-bypass-design.md`,
  brainstorm+grill-hardened): bypass now keys on **non-empty `toolGroundingSources`**,
  not "a tool ran"; the value checks (`gateChatAnswerDeterministic`) ALWAYS run with
  the tool's own output folded into evidence (a value the tool didn't return is caught,
  a faithful one passes); an empty-result tool falls through to the full gate. Single
  source of truth `groundingSourceFromExecuted` (agent-core) shared by `run()` + the
  `tool-result` stream event (additive `grounding` field) so BOTH chat-repl (run result)
  and chat-ink (stream) gate on one contract. TDD: 4 helper + 2 stream + 3 finalize
  cases (value-check-survives + empty-result-hole RED→GREEN); `pnpm check` (full tree,
  2484 cli) + lint 0. Residual (in spec): tool-grounded PROSE fabrication still passes
  (separate slice, needs judge-vs-tool-evidence). (audit CLI #4)

## ★ Open — computer-control multi-step reliability (진안-directed 2026-06-16, axis ①+②)

Direction picked by 진안: make Muse "control the computer" well. The PRIMITIVES already
exist (`@muse/fs`: file_read/list/grep/write/edit/multi_edit/delete/move, all gated +
path-safe; `run_command` via crates/runner; browser track). The real bottleneck is the
LOCAL 12B completing a MULTI-STEP computer task end-to-end, not more primitives.

- ✓→Done **file_grep no-path default scoped to home → dead-ends a narrowed sandbox** (2026-06-16,
  measure-first finding from the new eval:computer-task) — `fs-read-tools.ts:361` defaulted the
  search scope to `homedir()` when `path` was omitted. Fine for personal recall (roots=home), but
  when roots are narrowed to a workspace/project the home default falls OUTSIDE roots → REFUSED, and
  gemma4 (which routinely omits the optional `path`) retried 3× then gave up — never reaching the
  file. FIX: default scope = first configured root when `roots` is set, else homedir() (recall
  default preserved). TDD RED→GREEN (`fs-read-tools.test.ts` "defaults the scope to a configured
  root"), fs 93/93, lint 0. This alone flipped eval:computer-task from 0/1 → PASS.
- ✓→Done **file_edit literal-`\n` repair → eval:computer-task 1-2/3 → pass^5 5/5** (2026-06-16) —
  DIAGNOSED deterministically (`applyEdit` repro): gemma4 DOUBLE-ESCAPES newlines, emitting the two
  chars `\` `n` in its tool-call JSON instead of a real newline, so a multi-line `old_string` matched
  neither exact NOR the existing Codex-style fuzzy fallback (`findFuzzyBlock` splits on real `\n`, so a
  literal-`\n` string is one un-splittable line) → `not found`, and 12B recovery was inconsistent. FIX
  (`fs-write-tools.ts`): extracted the exact+line-block match into `matchAndReplace`; when it misses,
  `unescapeWhitespace` un-escapes literal `\n`/`\r`/`\t` in old AND new together and retries ONCE —
  adopted only when the repaired form actually matches (a verbatim backslash-n in source is caught by
  the exact pass first, so it's never rewritten; no location guessing). tool-calling.md rule 7
  "validate + repair deterministically". TDD RED→GREEN (repair + verbatim-no-rewrite), fs 95/95,
  repro 4/4, lint 0. Live: `MUSE_EVAL_REPEAT=5 eval:computer-task` = **5/5** (was ~1-2/3). Per 진안:
  eval STAYS report-only (NOT in eval:agent CI bundle) — it's a measurement, not a gate.
- ✓→Done ② **read-before-edit grounding gate** (2026-06-16) — the actuator analog of "every claim
  cites a source": `file_edit`/`file_multi_edit` FAIL-CLOSE on a target this run never `file_read`
  (Muse mutates only a file it has actually seen — codex edits freely). Deterministic + fail-close +
  back-compat: `FsReadToolsOptions.onPathRead(canonicalPath)` fills a per-run set on every successful
  read; `FsWriteToolsOptions.wasPathRead(canonicalPath)` is checked in `editExecutor` right after the
  safe-path resolve; BOTH optional ⇒ unset = no gate (every existing caller/test unchanged). Keyed on
  the resolved canonical path so read and edit agree. Wired in production (`commands-ask.ts`: shared
  `fsReadPaths` Set across the fs read+write tools) and live in `eval:computer-task`. file_write
  (create) is intentionally NOT gated; only mutate-existing is. TDD: fs **100/100** (fail-close when
  unread, applies when read, canonical-key, onPathRead fires on success / not on failed read), CLI
  tsc 0, lint 0. Live `MUSE_EVAL_REPEAT=3 eval:computer-task` = **3/3** — the gate does NOT break the
  completion path (model reads before editing). NOTE: still report-only per 진안 (not in eval:agent).
- ✓ **wrong-tool selection on the file-fix task — FIXED (computer-control fire 4) as a clean DETERMINISTIC structural bug, NOT the fuzzy ranking fires 1-3 concluded.** Deeper measure-first found the real cause: 10 always-on MANDATORY tools (math_eval/regex_extract/time_add/math.evaluate/context×3/skills×3) alone EXCEED `DEFAULT_TOOL_EXPOSURE_CEILING=6`, so `capToolsByRelevance`'s `remaining=max(0,6−10)=0` branch dropped the ENTIRE optional tail — file_read/grep/edit went INVISIBLE (2/2 STABLE FAIL). FIX (`tool-filter.ts`): reserve up to `RELEVANT_OPTIONAL_FLOOR=3` slots for positively-relevant optional tools (irrelevant still dropped) + a `FILE_PATH_RE` boost so the file cluster tops the reserve. OUTCOME: eval:computer-task 2/2 STABLE FAIL → pass^3 3/3 PASS. Deterministic unit tests + Opus ④b judge PASS. RESIDUAL ◦: the always-on bloat itself (time/math/regex as `domain:"core"` across 6+ files) is a BROAD design-sensitive refactor needing keyword coverage + cross-surface verify — NO current measured failure (fire-4 reserve makes eval PASS), so deliberate, not auto-fire.
- ✓ **code-task tool keywords — run_command was unreachable for run/test tasks (computer-control fire 6).** measure-first on `eval:multifile-fix` ("run the test, fix the bug"): `run_command` (domain="system") had **ZERO keywords** → scored 0 → starved under the cap; file tools missed code-fix verbs. FIX (sibling-audit): run_command keywords `run/command/execute/shell/test/compile/실행/명령/테스트/빌드`; file_read/grep/edit/multi_edit += `code/source/bug/fix`. OUTCOME: multi-file exposure improved (file_read + run_command now reach the model); eval:computer-task stays PASS. Mutation-valid test (run_command wins a CAPPED slot only with keywords) + Opus ④b judge PASS (IrrelAcc = approval-gated selection-noise, not harm; write tools NOT over-exposed). ◦ REMAINING (see fire 7).
- ✓ **file_edit unreachable for code-edit intent — FIXED (computer-control fire 7).** The write-tool gate (`write_without_mutation_intent`, `packages/tools/src/index.ts`) blocks write tools unless `isWorkspaceMutationPrompt` is true, but its vocab was workspace-OBJECTS only (issue/task/note) → a code-fix prompt ("fix the bug in the source file") scored false → file_edit BLOCKED. FIX: added code-edit vocab to the 3 hint lists — workspaceHints/mutationTargetHints += file/source/code/bug/function (+KO), mutationPatterns += fix/debug, koreanMutationHints += 고쳐. OUTCOME (probe): file_edit now exposed for code-fix prompts; single-file eval PASS (no regression). Mutation-valid test (RED on revert, needs all 3 hint dims) + Opus ④b judge PASS. **EXPOSURE CHAIN NOW COMPLETE (fires 4·6·7): file_grep/read/edit/run_command all reachable for a code-fix task.** HONEST RESIDUAL (④b-flagged): the relevance-gate backstop excludes unrelated workspace writes for fix/debug prompts (0 leak) but NOT for `add`/`create` homonyms ("add a function to the file" leaks tasks.add/calendar.create — PRE-EXISTING keyword overlap, bounded by the draft-first approval gate so exposure≠write; narrow those tools' add/create keywords if it bites). ◦ REMAINING (multi-file still FAILs): purely **12B multi-step reliability** — even with ALL tools exposed the model uses only file_read and stops (NOT exposure; a model-behavior / agentic-persistence problem, not tool-filter).
- ✓ **file_edit no-match error gives a nearest-line hint so the 12B can self-correct (computer-control fire 8).** A 3× scout confirmed @muse/fs is well-hardened (path-safety on all write tools incl. file_move from+to; read-before-edit on both edit tools via shared editExecutor; sophisticated edit repair: exact + whitespace-fuzzy line-block + double-escape un-escape, all uniqueness-fail-closed). The one gap: on a GENUINE content miss (not whitespace — fuzzy bridges that), `applyEdit` returned only `old_string not found: <80 chars>` with no path to self-correct. FIX (`fs-write-tools.ts` `nearestLineHint`): rank the file's lines by shared-word overlap with old_string's first line; if the best shares ≥max(2,⌈words/2⌉) words, append `Closest line in the file is "<line>" — copy the exact text`. Pure/deterministic, FAILURE-message only (never changes which edit applies or causes a write — fail-closed posture intact), noise-suppressed (unrelated miss → no hint, bounded 120 chars). Mutation-valid test (RED with helper stubbed) + Opus ④b judge PASS. ◦ COMPUTER-CONTROL CLEAN-DETERMINISTIC VEINS NOW LARGELY EXHAUSTED: exposure chain done (4·6·7), fs primitives hardened (8); the remaining multi-file blocker is **12B multi-step behavior** (model uses only file_read) — a fuzzy/stochastic agentic-persistence problem, NOT a deterministic tool/fs slice. Next deliberate candidates: agentic-persistence prompt tuning (stochastic, dedicated eval budget) or the 10-mandatory bloat refactor (broad, design-sensitive).
- ✓ **hallucinated tool name gets a nearest-registered-tool suggestion so the 12B self-corrects (computer-control fire 9).** A deeper measure-first trace of eval:multifile-fix (MUSE_TASK_DEBUG) found the model CAN multi-step (read→read→edit, fixing the bug so test-passes=true) but FAILS to run the test because it HALLUCINATES a tool name (`node_run`) instead of the registered `run_command` — and the bare `Error: tool not found: node_run` left it stuck. FIX (`packages/tools/src/executor.ts` `nearestToolName`): on a not-found tool, suggest the registered tool sharing the most snake/dot-case tokens (≥1 required) — `node_run` → `. Did you mean 'run_command'? Call that exact registered name.`. Deterministic, only on the not-found branch (no happy-path cost), text-only in a failed-call error (re-enters all gates; no execution). Mutation-valid test (RED with helper stubbed; negative guard: unrelated name → no suggestion) + Opus ④b judge PASS. ◦ DEEPER FINDING (multifile is stochastic, multiple 12B failure modes, NOT flipped by this fix): (1) early-stop after file_read; (2) `node_run` hallucination (THIS fix helps); (3) **garbage tool name with leaked gemma chat-template tokens** (`node --exec … <|channel>thought`) — ✓ PARTIALLY ADDRESSED computer-control fire 11: `adapter-ollama.ts` `sanitizeToolCallName` cuts a tool-call name at the first `<|` template marker + strips control/zero-width chars (both generate AND stream parse sites), so a name corrupted by a TRAILING leaked token (`run_command<|channel|>` → `run_command`) now resolves instead of failing tool-not-found. mutation-valid (revert → both tests RED) + Opus ④b judge PASS (no over-stripping of clean/dotted/dashed/Cyrillic names; byte-hygiene escaped char class). A FULLY-garbage base (shell-command-as-name) survives the cut and stays unresolvable — that's model-behavior, not adapter parsing. Also: eval:multifile-fix's `modelRanTest = toolsUsed.includes("run_command")` is brittle path-grading (won't credit a correct fix that ran via another command) — agent-testing.md says grade OUTCOME (test-passes), a separate eval-correctness cleanup.
- ◦ **DELIBERATE (not auto-fire) — multifile ceiling is 12B model-behavior, confirmed computer-control fire 12 measure-first.** With exposure (4·6·7), error-recovery (9), and adapter sanitisation (11) all fixed, a re-measured run hit the **early-stop** mode: the model calls file_read ONCE then voluntarily stops (no grep/edit/run) despite the SYSTEM persistence lines — NOT an iteration cap (the single-file eval does grep→read→edit). The remaining modes are model-behavior, not deterministic tool/fs/adapter gaps — the clean deterministic computer-control veins are exhausted. Candidate for DELIBERATE work (needs design, NOT a 15-min auto-fire): a **verifier-backed action-completion nudge** in agent-core — when the model returns a final answer with NO state-changing tool called on a task that required action, re-prompt ONCE. BLOCKER: per reflection-guard.md any new retry surface needs a deterministic verifier + registry entry, and "action-task vs answer-only" classification is fuzzy (a generic nudge mis-fires on legitimate answer-only turns) — a careful core-loop change, not auto-loop fodder.
- ✓ **read-before-OVERWRITE grounding gate on file_write — closed a fabrication=0 hole (computer-control fire 13).** The read-before-edit invariant (Muse only mutates content it has actually read) was enforced on file_edit/file_multi_edit (shared editExecutor) but NOT on file_write — which CREATES or fully OVERWRITES a file. So a model could `file_write`-overwrite an EXISTING file with content it never read (silent data loss + ungrounded mutation, violating the fabrication=0 floor the theme requires on every actuator). FIX (`fs-write-tools.ts` createFileWriteTool): `if (exists && options.wasPathRead && !options.wasPathRead(safe))` fail-close — overwrite of an existing unread file is refused; CREATING a new file needs no read (nothing to ground); back-compat (wasPathRead undefined → gate skipped). LIVE in production (CLI `commands-ask.ts:1500` wires `wasPathRead` into `createFsWriteTools`). Mutation-valid 3-case test (overwrite-no-read fail-close + overwrite-with-read allowed + create-no-read allowed) + Opus ④b judge PASS (no over-block, create path + symlink/TOCTOU/approval guards untouched, editExecutor parity exact). Sibling-audit: read-before-edit applies to CONTENT-mutating tools (edit/multi_edit/write-overwrite); file_delete/move are not content mutations (own guards) — content-mutation coverage now complete. Shows the computer-control theme is NOT fully exhausted: the grounding-gate dimension ("every actuator passes the gate") had an unaudited surface.
- ✓ **a PARTIAL grep/offset read must not ground a whole-file overwrite (computer-control fire 14 — refines fire 13).** fire-13's overwrite gate was satisfied by `wasPathRead`, which file_grep ALSO sets (so the grep→edit loop works) — but grep shows only matched lines, so a model could grep a file then `file_write`-overwrite it, silently dropping every unseen line. FIX: a stricter `wasPathFullyRead` (file_write-overwrite checks `wasPathFullyRead ?? wasPathRead`); `file_read` fires a new `onFullRead` ONLY on a COMPLETE read (`start === 0 && !truncated` — NOT an offset-skipped tail, NOT a limit/maxTextChars-truncated read), file_grep never fires it. file_edit/multi_edit unchanged (grep→edit intentionally still allowed). CLI wires a second `fsFullReadPaths` set. Mutation-valid tests (write: partial-grep→fail-close, full→allowed; read: complete fires onFullRead, limit/offset/grep do NOT). **maker≠judge worked on a REAL slice**: ④b judge #1 FAILed it — the first impl gated `onFullRead` on `!truncated` alone, which an OFFSET-only read (offset:96 → lines 96-100, truncated=false) wrongly satisfied, re-opening the hole via offset; fixed to `start===0 && !truncated` + an offset test; ④b judge #2 (independent) PASS (offset hole closed, all edge cases correct, no regression, 131/131). LESSON: read PRESENCE ≠ read COMPLETENESS — a grounding gate that means "saw the whole file" must check the read STARTED at the top AND reached the end, not just "not truncated".
- ✓ **run_command dynamic-loader env injection blocked (computer-control fire 15, §3.6 security).** The Rust runner spawns `Command::new(cmd).args(args)` (no shell → no shell injection) and rejects path commands — but the model-supplied `env` map was validated only by KEY FORMAT (uppercase identifier), so `LD_PRELOAD` / `LD_LIBRARY_PATH` / `LD_AUDIT` (glibc) and `DYLD_INSERT_LIBRARIES` / `DYLD_*_PATH` (macOS dyld) — all valid identifiers — passed through and would load ARBITRARY CODE into the spawned process, escaping the no-shell + path-reject guards (a real code-exec / sandbox-escape from untrusted model input). FIX at BOTH layers (defence-in-depth, sibling-audit): TS `runner.ts` `readStringRecord` drops keys matching `/^(?:LD|DYLD)_/`; Rust `is_safe_env_key` rejects `LD_`/`DYLD_` prefixes (the authoritative gate on `command.env(...)`). Precise (trailing `_` → keeps `LDFLAGS`/`LOAD_PATH`/`MY_LD_PRELOAD`). Mutation-valid both layers (TS 284, Rust `cargo test` 7) + Opus ④b judge PASS (no over-block, both layers block the same family, prior env guards intact, honest scope = the well-known LD_/DYLD_ core, not every conceivable env vector). Distinct (pkg=@muse/tools+crates/runner, kind=security/path-safe) — the §3.6 untrusted-input→command threat the theme mandates.
- ✓ **run_command env injection — the WHOLE code-injection family (computer-control fire 16, sibling-audit of fire 15).** fire 15 blocked only the dynamic loader (LD_/DYLD_) but that was 1 of ~24 family members — `NODE_OPTIONS` (=`--require`/`--import` runs arbitrary code in `node`, the runtime Muse actually shells out to), shell startup (`BASH_ENV`/`ENV`/`SHELLOPTS`), interpreter opt/path injection (`PERL5OPT`/`PERL5LIB`, `PYTHONSTARTUP`/`PYTHONPATH`, `RUBYOPT`/`RUBYLIB`), and git command-exec hooks (`GIT_SSH_COMMAND`/`GIT_EXTERNAL_DIFF`/`GIT_PAGER`/`GIT_PROXY_COMMAND`/… + `GIT_CONFIG*` which point git at an attacker config that re-sets `core.sshCommand`/`core.pager`) all still passed. FIX: `UNSAFE_ENV_EXACT` denylist (the exact family) + the LD_/DYLD_ prefix, at BOTH layers (TS `isUnsafeEnvKey` + Rust `is_safe_env_key`), lists IDENTICAL. Exact-match precision keeps legit `NODE_ENV`/`GIT_DIR`/`GIT_AUTHOR_*`/`PYTHONUNBUFFERED`. Mutation-valid (TS 285, Rust `cargo test` 8) + Opus ④b judge PASS — the judge flagged `GIT_CONFIG*` as the strongest remaining miss (2nd path to the blocked git-exec hooks) and it was added in the same slice. LESSON: a sibling-audit must enumerate the FULL class, not the first member found — fire 15 fixed 1/24 and called it done; the right question at LD_PRELOAD was "what is the WHOLE family of code-injection env vars," per-runtime.
- ✓ **run_command resource knobs clamped — unbounded timeout/output DoS (computer-control fire 17).** `timeoutMs`/`maxOutputBytes` are model-supplied tool-schema fields with only a LOWER bound (≥1) — so `timeoutMs:999_999_999` (~11.5 days) wedges the runner and `maxOutputBytes:5e9` buffers unbounded output into memory. FIX (both layers, identical ceilings 10min/10MB): TS `readPositiveInteger(value, max)` clamps via `Math.min`; Rust `effective_timeout_ms`/`effective_max_output_bytes` via `clamp(1, MAX)`; the inputSchema also gained `maximum:` (defence-in-depth + model guidance). A legitimate 9-minute build (540_000ms) passes unclamped; clamp (not reject) keeps the command running, just bounded. Mutation-valid (TS 289 + Rust `cargo test` 9; both go RED on un-clamping) + Opus ④b judge PASS (TS/Rust ceilings identical, no TDZ on the factory-read schema consts, watchdog bounded ≤605s, prior guards intact). Distinct (kind=resource-bound) from the env-injection fires. NOTE — measure-first this fire (multifile eval, all of fires 4-16 in place): the model now investigates correctly (file_read test → file_grep → file_read source) but STOPS before file_edit — a SHARPER characterization of the agentic-persistence ceiling than fire 12 (the deterministic exposure/recovery/grounding layers all work; the model reaches the right files; it just does not follow through to the edit). The remaining multifile blocker stays the deliberate verifier-backed action-completion nudge (agent-core core-loop, not auto-fire).
- ✓ **fs credential deny-list — common credential/key-store files (computer-control fire 18, §3.6 sibling-audit).** The fs path sandbox (resolveSafePath, shared by ALL @muse/fs tools) denied .ssh/.aws/.env/*.pem/*secret*/*credential*/*token*/id_rsa, but a probe found common credential leaves STILL readable/writable: `.npmrc` (npm auth token), `.netrc` (login), `.pgpass` (postgres pw), `.pypirc` (PyPI token), and key-store containers `*.pfx`/`*.jks` (`.p12` was caught only when the name also held "secret"). FIX (DEFAULT_DENY_BASENAME_PATTERNS, leaf-only): `/^\.(npmrc|netrc|pgpass|pypirc)$/` + `/\.(p12|pfx|jks|keystore)$/`. `.key` deliberately EXCLUDED (collides with Apple Keynote — `slides.key` stays allowed; `.pem` already covers real key material). Mutation-valid (8 files ALLOWED pre-slice → denied; over-block probes clean: notes.txt/config.yaml/package.json/npmrc.md/report.p12.txt all stay allowed) + Opus ④b judge PASS (exact-dotfile + extension-at-end anchoring, no regression to the prior corpus, 143/143). Out of scope (honest): run_command is the general approval-gated executor, NOT the resolveSafePath sandbox — its file access is a separate model. Distinct (kind=security/credential-deny).
- ✓ **file_grep ReDoS guard — a model regex can no longer hang the agent (computer-control fire 19, §3.6).** file_grep compiles a MODEL-supplied pattern with `new RegExp(pattern,"u")` (JS backtracking engine, NO timeout) and runs it line-by-line IN Muse's Node process — a confirmed probe: `(a+)+$` on a 40-char failing line HANGS forever (ReDoS, wedges the agent). FIX (`fs-read-tools.ts` `isCatastrophicGrepPattern`): reject the classic nested-quantifier form `/\([^()]*[+*][^()]*\)(?:[*+]|\{\d+,\})/` (an unbounded quantifier on a group whose body also has one — `(a+)+`/`(.*)*`/`(\d+){2,}`) BEFORE compiling, with a clear "simplify it" error so the model retries. Mutation-valid (unit it.each flags 6 catastrophic / allows 7 safe incl. `(abc)+`/`a{2,5}`/`a+b+c+`; detector→false makes the unit tests RED and the integration test HANG = the guard is load-bearing) + Opus ④b judge PASS (ZERO over-block on 11 realistic 12B grep patterns; runs before compileGrepPattern; malformed-`(`-to-literal degradation intact; grep-only). HONEST RESIDUAL (④b-confirmed): the FLAT-group heuristic still misses `((a+))+` (nested parens) and `(a|aa)+` (alternation-overlap) — both still hang. Alternation can NOT be cleanly detected (would over-block safe `(a|b)+`); the complete fix is a worker-thread + kill-timeout (catches ALL forms regardless of shape) — a deferred deeper slice. The common 12B-emittable form is closed. Distinct (kind=regex-safety/ReDoS).
- ✓ **JUDGE-DRILL #2 + harden the ReDoS allow-corpus (computer-control fire 20).** firesSinceDrill=10 / 8-consecutive-PASS triggered the mandatory drill. Injected a plausible "improvement" — close fire-19's alternation-overlap residual by adding `|` to the detector's inner class (`[+*|]`) + a test asserting `(a|aa)+` is now flagged. ALL deterministic gates passed (157 green) because the existing "allows" corpus had NO quantified-alternation pattern. The independent Opus ④b judge FAILED it with concrete evidence: `(foo|bar)+`/`(TODO|FIXME)+`/`(a|b)*`/`(error|warn|info)+` are now wrongly rejected (TIMED sub-millisecond on a 50K failing line → NOT catastrophic; non-overlapping alternation is linear), a fresh regression vs fire-19, and the test corpus is BLIND to it. Rolled back (detector unchanged from fire-19). REAL FIX (the drill's lesson): hardened the "allows" it.each with the safe quantified-alternation patterns the drill exploited (`(foo|bar)+`, `(TODO|FIXME)+`, `(a|b)*`, `(import|export)\s+\w+`, `(GET|POST|PUT)\s`, `(error|warn|info)+`) — mutation-verified: re-applying the drill's `[+*|]` broadening now turns those tests RED, so a future over-block of safe alternation is caught by the gate (it was invisible before). LESSON: the drill's 2nd success shows the verifier catches a gate-passing regression by REASONING+PROBING+TIMING; and the right post-drill fix is to close the test-blindness the drill rode in on, not just revert.
- ✓ **file_read/file_grep missing-path → actionable recovery hint, not a raw ENOENT (computer-control fire 21).** A non-existent DIRECT path returned a raw Node errno — `{error:"ENOENT: no such file or directory, stat '/abs/path'"}` — which dead-ends the 12B (can't self-correct off an errno) AND leaks an absolute host path. FIX (`isNotFoundError` = code==="ENOENT"): both tools now return an actionable message naming the recovery tool — file_read `"no file at '<input>' — check the path, or use file_list (e.g. pattern \"**/<basename>\") to locate it"`; file_grep `"no path '<scope>' to search — … use file_list to find the right directory"`. Sibling-audit: file_list on a missing cwd already returns a clean `{count:0,paths:[]}` (left as-is — an empty list is a clear non-leaking signal). KIND = reliability/error-recovery (not security). Mutation-valid both (RED on raw-errno; grep branch revert → RED) + Opus ④b judge PASS: ENOENT-only intercept (denied→still refused, existing→reads, directory→"directory", EACCES→falls through to the real error, malformed-regex→still literal-degrades), outcome-graded, and a BONUS info-leak reduction (message echoes the model's own `input`, not the symlink-resolved `/private/var/...` the old errno leaked). Helps the multi-step grep→read→edit loop recover instead of stalling. Distinct (kind=reliability-nudge, like fires 8-9).
- ✓ **file_edit/file_multi_edit missing-file → actionable hint (computer-control fire 22, fire-21 sibling completion).** fire 21 fixed file_read/file_grep ENOENT but MISSED the write actuators — file_edit/multi_edit on a non-existent file returned the SAME raw `ENOENT … stat '/abs'` errno (dead-ends the 12B at the COMPLETION step + leaks the resolved host path). FIX (one branch in the shared `refusal` helper, code==="ENOENT"): both tools now return `"no file at '<input>' — to create it use file_write; to edit an existing file, check the path or use file_list to find it."`. Covers file_edit AND file_multi_edit (shared editExecutor→refusal); file_write is correctly EXCLUDED (it mkdir -p's its parent, never hits this — ④b verified it auto-creates). Mutation-valid (branch removed → RED with the raw errno; restored → 164 green) + Opus ④b judge PASS: ENOENT is the 3rd branch (PathSafetyError refusal → ELOOP symlink → ENOENT → generic), so denied-path/symlink/old_string-not-found/directory/existing-edit all keep their own outcome (probed); uses the model's input `path` not the resolved abs (no leak). One non-blocking nit (a dangling symlink hits ENOENT before ELOOP → slightly-off hint, but no regression vs the old raw errno). Distinct (kind=reliability-nudge).
- ✓ **run_command spawn failure → actionable message (computer-control fire 23, reliability-nudge on a DIFFERENT package).** The Rust runner (`crates/runner`) returned a raw `"failed to spawn command: No such file or directory (os error 2)"` when a command could not be spawned — the 12B can't tell a typo from an uninstalled tool. FIX (`describe_spawn_error(command, error)`): `ErrorKind::NotFound` → `"command '<cmd>' not found — it is not installed or not on PATH; check the name."`, `ErrorKind::PermissionDenied` → `"command '<cmd>' is not executable (permission denied)."`, everything else → the original generic message (unchanged). Wired into `run_request`'s spawn `Err` arm; TS passes `error` through to the model unchanged (no TS edit). Mutation-valid (NotFound arm → generic makes the cargo test RED; restored → 10 passed) + Opus ④b judge PASS: pure error-text formatting AFTER an already-failed spawn (zero change to what spawns or the security posture — blank/path/env guards all precede it), names the model's own `request.command` (no host-path leak), generic fallthrough preserves every other error verbatim. Diversity: pkg=crates/runner (off the @muse/fs streak), kind=reliability-nudge. Honest bound: the eval binary may be a stale copy, but the source is correct + cargo-tested.
- ✓ **file_read paging hint `nextOffset` — the model pages a long file deterministically (computer-control fire 24).** A line-truncated text read returned `{truncated:true, totalLines}` with NO continuation guidance, so the 12B had to GUESS the offset to read the next page of a long file. FIX: the text-read result now carries `nextOffset` = the 1-based line to resume at (`start + sliced.length + 1`) when LINE-truncated; OMITTED on a char-cap cut (`text.length > maxTextChars`) since a mid-line cut has no clean line offset (the char-cap branch clears it — char-cap wins). Description gained "a truncated result returns `nextOffset`; pass it back as `offset` to read the next page." Mutation-valid (no-nextOffset → RED; the char-cap clear is independently pinned by a line-truncated+char-capped case → RED when removed) + Opus ④b judge PASS: round-trip paging has NO gap/overlap/off-by-one and the final page stops (truncated:false, no nextOffset); GROUNDING GATE UNCHANGED (nextOffset is purely additive — `onFullRead` still fires only on `start===0 && !truncated`, a paged read fires onPathRead only, never grounds an overwrite); PDF/DOCX/image returns gain no stray nextOffset. Distinct (kind=reliability-nudge, output-paging — the success path, vs the error-recovery nudges of fires 21-23).
- ✓ **false-done backstop recognises the fs/run_command actuators (computer-control fire 25).** SCOUT FINDING: the agentic-persistence/false-done machinery ALREADY EXISTS and is WIRED — `answerClaimsAction` (detects "I fixed it") + `actionToolRan` (did a state-changing actuator run?) gate a flag in `commands-ask.ts:2590` and a RE-PROMPT in `chat-repl.ts:553`. BUG: `actionToolRan`'s `ACTION_TOOL_RE` predated the @muse/fs tools, recognising only `.add/.update/.delete/…` verb tools + `_action`, so `file_edit`/`file_write`/`file_multi_edit`/`file_delete`/`file_move`/`run_command` were NOT counted — a REAL file_edit on a code-fix task was misread as "no action ran", so the backstop FALSELY flagged an honest "I fixed it" as unbacked (and chat would spuriously re-prompt). FIX: added `|\b(?:file_(?:edit|write|multi_edit|delete|move)|run_command)\b` to the classifier. Mutation-valid (RED before; 6 mutators → true, file_read/grep/list stay false) + Opus ④b judge PASS: false-positive fixed (real file_edit no longer flagged) AND true-positive PRESERVED (a genuine false-done with actionToolRan([])===false still fires); no over-match on adversarial names (file_editor_config/run_commander/profile_edit all false); the existing tasks/calendar/memory verb arm byte-identical; 2533 agent-core tests green. Distinct (kind=honesty/false-done, pkg=@muse/agent-core). NOTE: this means the persistence re-prompt machinery exists and now WORKS for computer-control — narrowly avoided building a duplicate (scout caught the existing exports).
- ✓ **false-done backstop REQUEST-side gate now recognises code-fix via a STRUCTURAL signal — RESOLVED by fire 27 (fire-26 blocker closed).** (fire-26 NO-SHIP history kept for the lesson:) Sibling of fire 25: the backstop is also gated by `classifyActionRequest`/`requestsToolAction`, which recognise reminder/task/calendar/email intents but NOT computer-control code-fix requests ("fix the bug in add.ts", "수정해줘") — so even with fire 25's actuator fix, the backstop NEVER ENGAGES for the theme on the CLI ask/chat path. ATTEMPTED a `CODE_ACTION_REQUEST_RE` (edit verb + code/file noun, START-anchored to exclude questions). TWO independent Opus ④b judges FAILED it for OVER-MATCH that a lexical regex cannot avoid: v1 — bare homonyms (`change my class schedule`/`correct the error on my invoice`/`fix the line at the pharmacy`/`change the function next Friday` all → true); v2 (homonyms removed, named-construct `<id> class` kept) — `the <adjective> class` defeats the determiner guard (`update the science class`/`change the spin class`/`fix the parking module`/`update the training module` → true) + strong-noun non-code senses (`fix the variable rate mortgage`/`update the import tax`/`debug my code word` → true). ROOT CAUSE: code-vs-non-code is a SEMANTIC disambiguation (is X a code identifier? is this a code context?), not a lexical one — homonyms (class/test/line/error/function/variable/import/code/syntax/typo) all have common non-code senses, so any verb+noun regex mis-routes innocent personal-assistant queries at commands-ask:903 (early return to a "needs --with-tools" guide). RIGHT DESIGN (deliberate, next): gate on a STRUCTURAL signal, not request text — engage the code-fix backstop only when (a) the run had FILE TOOLS exposed/available, or (b) the query contains an explicit file path / filename token (`\w+\.<code-ext>` or an absolute/relative path). Those are deterministic + homonym-free. Rolled back clean (agent-core back to fire-25 state; actionToolRan fs fix intact). LESSON: two independent judges catching realistic over-match = the maker≠judge control working as designed (organic, not a drill) — a fuzzy lexical classifier on homonym-heavy intent is the wrong tool; reach for a structural/deterministic signal.
- ✓ **false-done backstop engages for computer-control code-fix requests — STRUCTURAL signal (computer-control fire 27, resolves the fire-26 blocker; completes fire 25).** Fire 25 taught the backstop's ACTION side (actionToolRan) to recognise fs actuators; this slice does the REQUEST side the right way — after fire 26's lexical attempt failed 3 independent judges on homonyms, `classifyActionRequest` now matches a code-fix request ONLY when the query carries an explicit CODE-EXTENSION FILENAME (`FILE_PATH_TOKEN` = optional path prefix + `name.<code-ext>` for ~40 code/config extensions). START-anchored on an edit verb (so questions like "how do I fix add.ts" stay false); KO mirror (filename + 고쳐/수정/…). The code-extension filename is homonym-free — no ordinary English word is `name.ts`, which kills BOTH the code-noun homonyms (fix the variable rate mortgage) AND the path-prefix homonyms (update my app/website) that broke fire 26 + the first fire-27 attempt. Deliberate precision-over-recall: a fileless "fix the bug" / bare "수정해줘" does NOT match (a miss costs nothing on the grounded path; a false positive would mis-trigger the backstop + the commands-ask:903 "needs --with-tools" guide). Mutation-valid (positives RED without the patterns; the path-prefix negatives RED if the token is relaxed) + Opus ④b judge PASS on the 4th review (after v1/v2 code-noun FAIL + v3 path-prefix FAIL — each found a real over-match the next design closed): residual is only genuine .md files (correct) or contrived glued-token "dr.py"-style collisions (real abbreviations keep their post-period space → false). Together with fire 25 the false-done backstop now fully works for computer-control on the CLI ask/chat path. Distinct (kind=honesty/false-done, pkg=@muse/agent-core). LESSON: a structural/deterministic signal (a code-extension filename) beats lexical intent-guessing on homonym-heavy classification — and 3 judge FAILs converging on the right design IS maker≠judge working.
- ✓ **false-done backstop THIRD leg — answerClaimsAction recognises code-fix completion claims (computer-control fire 28, completes the backstop end-to-end).** The backstop ANDs three legs (query=classifyActionRequest [fire 27] && answer=answerClaimsAction && tools=!actionToolRan [fire 25]). `answerClaimsAction` recognised only reminder/task/calendar promises, NOT "I fixed the bug" / "수정했습니다" — so even with fires 25+27 the `&&` short-circuited and the backstop NEVER fired for a real computer-control false-done. FIX: a `CODE_DONE_RE` branch — a FIRST-PERSON PAST-TENSE mutation verb (fixed/edited/updated/changed/… case-insensitive `/iu`) OR a KO completion (수정했/고쳤/편집했/…). FULL-LOOP now composes (Opus ④b judge verified end-to-end): code-fix request + "I fixed it" claim + NO actuator → backstop FIRES (the false-done is caught/re-prompted); + a real file_edit → NOT flagged. Mutation-valid (positives RED without the branch; the `/iu` flag is load-bearing — "I fixed" failed under `/u` because `i` only matched lowercase). Over-match contained: future ("I will fix")/offer ("shall I fix")/capability ("I can fix")/advice ("you should edit")/description ("the function returns…") all FALSE (past-tense anchor), and the broad past-tense match ("I changed my mind") only matters when the QUERY was already an action request (all 3 call sites AND-gate it) — the judge could not construct a realistic honest-answer end-to-end false-positive (legitimate "I read/reviewed/analyzed add.ts" stay false). fires 25+27+28 = the false-done/agentic-persistence backstop now works end-to-end for computer-control on the CLI ask/chat path (the fire-17 "model claims a fix without editing" failure mode is now caught). Distinct (kind=honesty/false-done, pkg=@muse/agent-core, the 3rd leg).
- ✓ **JUDGE-DRILL #3 ✅ + terse "Done." claim added safely (computer-control fire 29).** firesSinceDrill=10 triggered the mandatory drill. Injected a plausible "improvement" — add bare `\bdone\b` to CODE_DONE_RE so a terse "Done." reply counts as a completion claim, with a "Done."/"Done!" positive test. ALL deterministic gates passed (2537 green) because the answerClaimsAction negative corpus had NO "done"-negation case. The independent Opus ④b judge FAILED it with concrete evidence: `\bdone\b` flags negations/partials/idioms/questions/passive ("I'm not done yet", "I'm almost done", "this isn't done", "well done!", "are you done?", "done automatically by the framework", and the worst "I'm done looking but I haven't fixed it") — and it DROVE THE ASSEMBLED GATE (code-fix query + "I'm not done yet" + no tool → backstop FIRES → re-prompts an HONEST in-progress answer), a precision regression on the safety-critical path. Rolled back. REAL FIX (the drill's twin lessons — test-blindness + a legit gap): (a) the terse-"Done." gap IS real, so added `TERSE_DONE_RE = /^\s*(?:all\s+)?(?:done|완료…)\s*[.!…]*\s*$/iu` — a WHOLE-ANSWER anchor (matches "Done."/"All done." but NOT embedded "done"), plus `완료` for the KO sentence form; (b) hardened the negative corpus with the 7 drill cases. Mutation-valid: reverting TERSE to bare `\bdone\b` turns all 7 hardened negatives RED (the over-match the drill rode in on is now caught) + Opus ④b judge#2 PASS (terse claim true, every negation/idiom/passive false, `완료하려면`/`완료되지` false, 2537 green). LESSON: a drill's right real-fix can close BOTH a test-blindness AND a legit feature gap — implement the feature with the SAFE form (whole-answer anchor, not substring) the judge pointed to, and add the over-match cases as negatives so the bad form can never pass silently. The verifier drove the COMPOSED gate to prove harm — maker≠judge working (3rd drill).
- ✓ **file_list returns a DETERMINISTIC (sorted) order (computer-control fire 30).** `file_list` returned matched paths in `glob` iteration order, which Node leaves filesystem/implementation-defined — the same cwd could list files in a different order across machines or pass^k eval repeats, a flaky input for the local model. FIX: `matches.sort()` (lexicographic by full canonical path) before returning. Honestly scoped: the glob loop still breaks at `limit`, so a >limit cwd's SET stays the glob-bounded first `limit` (pre-existing truncation) — only the returned ORDER is made deterministic (documented in a comment + the backlog). Mutation-valid (removing the sort turns the test RED — glob does NOT already return sorted order on the fixture) + Opus ④b judge PASS: count/truncated/exclude/ignore/sandbox all unchanged (the sort only reorders the already-filtered, already-capped array); reproducible across machines; honest scoping (order not set). Distinct (kind=determinism/reproducibility, pkg=@muse/fs).
- ◦ **BLOCKER / DECOMPOSE (computer-control fire 30): false-done RE-PROMPT in the AgentRuntime loop (to move the eval, not just the CLI chat).** fires 25/27/28/29 made the false-done backstop work END-TO-END on the CLI ask/chat path (chat-repl re-prompts a claimed-but-unbacked fix). BUT the `eval:computer-task` harness drives `AgentRuntime` DIRECTLY (createMuseRuntimeAssembly + the fs tools), bypassing chat-repl — so the eval does NOT benefit from the re-prompt, and the fire-17 early-stop (model investigates then stops before editing) still caps the eval. To move the eval, the detection (classifyActionRequest + answerClaimsAction + !actionToolRan — all built + tested) must drive a BOUNDED (max 1) re-prompt INSIDE the AgentRuntime run loop, reflection-guard-compliant (verifier = did an actuator run after the re-prompt). DEFERRED here because: (a) it touches the AgentRuntime core loop (shared server+CLI — invasive, highest blast radius), (b) Ollama is down on the loop box so the end-to-end eval effect can't be validated this fire, (c) it may duplicate/should-consolidate the chat-repl re-prompt (architecture decision: re-prompt at the runtime layer vs the CLI layer). Loop-sized sub-slices: (30a ✓ fire 31) extracted `isUnbackedActionClaim({query, answer, toolNames})` in agent-core composing the 3 detectors, unit-tested + wired to the 3 existing CLI sites (DRY, behavior-preserving, the seam); (30b ✓ fire 32) extracted `runResistingFalseDone` — a shared, generic, bounded-1-retry wrapper (clean-history re-run, verifier=actionToolRan) tested with synthetic results; chat-repl DRY'd to it; (30c) validate the real eval delta once Ollama is up (consolidate vs chat-repl). Needs 진안/Ollama for (30c).
- ✓ **runResistingFalseDone — false-done re-prompt extracted to a shared bounded-retry wrapper (computer-control fire 32, decompose 30b).** The ACTION half of the backstop (the clean-history re-run on an unbacked claim) was INLINE in chat-repl:634. Extracted to `runResistingFalseDone({query, firstResult, retry})` in agent-core: if `isUnbackedActionClaim`, call the caller's `retry` thunk ONCE and keep the re-run only if `actionToolRan(retried)` (else keep the first — a 2nd unbacked never replaces the 1st). Generic over `{response:{output}, toolsUsed?}` (no AgentRuntime dependency), so chat-repl AND the eval/agent harness (30c) compose ONE definition. Reflection-guard-compliant: bounded to exactly one retry, deterministic verifier (did an actuator run), fail-closed. chat-repl DRY'd to it (behavior-IDENTICAL — Opus ④b judge leg-for-leg diff; const-capture for the closure narrowing; actionToolRan removed from imports, isUnbackedActionClaim retained; builds exit 0). Mutation-valid (4 synthetic cases; `actionToolRan?retried:first`→`retried` makes the "re-run also fails→keep first" case RED). Honest bound: the EVAL does NOT compose it yet — 30c (wire the harness + validate the eval delta) needs Ollama. Distinct (kind=refactor/seam+bounded-retry, pkg=@muse/agent-core+apps/cli).
- ✓ **file_read refuses a binary-content text file instead of returning corrupted text (computer-control fire 33).** A text-EXTENSION file (`.txt`/`.ts`/…) can actually be BINARY (a NUL byte). file_read's TEXT branch decoded its bytes as UTF-8 and returned NUL-containing "text" — corrupted, edit-poisoning content the model could try to mutate. file_grep already SKIPS binary files via `isProbablyBinary` (a NUL byte); file_read did NOT (sibling inconsistency). FIX: after `rawText = data.toString("utf8")`, `if (isProbablyBinary(rawText)) return {read:false, reason: "looks like a binary file (contains a NUL byte), not text — …"}`. The guard is in the TEXT branch only (image/PDF/DOCX/directory/unsupported untouched) and returns BEFORE onPathRead/onFullRead — so a refused binary read is fail-closed (cannot ground a later edit/overwrite). Mutation-valid (removing the guard → the read:false + text-undefined asserts flip RED) + Opus ④b judge PASS: no regression (PNG vision read, real text read, PDF-with-NUL-extract all still read; verified resolveFileKind routes a binary .txt to the text branch so the guard is LIVE); no false-positive (UTF-8 source/markdown/Korean never embeds a NUL; a UTF-16 file was already garbled, so a clear refusal beats corruption); the read↔grep binary handling now matches. Distinct (kind=correctness/reliability, pkg=@muse/fs).
- ✓ **run_command timeout → actionable message (computer-control fire 34, fire-23 spawn-error sibling).** When a command exceeded its timeout the Rust runner killed it and returned `{timed_out:true, ok:false, error:None}` — a bare flag the local 12B can miss, with NO message. FIX (`describe_timeout(ms)`): on the timeout path `error` now carries `"command timed out after {ms}ms and was killed — it may be hanging; retry with a larger timeoutMs or a more targeted command."` (`ms` = the EFFECTIVE clamped timeout, not the raw request). Wired into the success-path RunnerResponse (`error: if timed_out { Some(...) } else { None }`); TS passes `error` through (no TS edit). Mutation-valid BOTH ways: dropping the "timeoutMs" hint → the helper test RED; reverting the wiring to `error:None` → the END-TO-END test RED (a real `sleep 5` killed at 50ms through `run_request` must surface the message) + Opus ④b judge PASS: no-weakening (only the error string on the timeout path — timed_out/ok/kill/drainers unchanged; a non-timeout command gets NO spurious timeout error), correct ms (effective clamped value), non-flaky E2E (#[cfg(unix)], 50ms vs 5s no race). cargo 12 tests. Diversity: pkg=crates/runner (off @muse/fs/agent-core), kind=reliability-nudge — completes the run_command failure-message family (spawn-error fire 23 + timeout fire 34).
- ✓ **file_read caps to fit the model context — a 200K read no longer overflows the 12B window (computer-control fire 35).** The agent created its fs read tools with NO `maxTextChars`, defaulting to `DEFAULT_MAX_TEXT_CHARS = 200KB` (~50K tokens) — but the local model's context is `DEFAULT_OLLAMA_NUM_CTX = 32768` tokens, so ONE max file_read exceeds the WHOLE window and the runtime silently truncates the prompt/history (adapter-ollama documents this LIVE: an 8K window ate the whole prompt → 1 output token). FIX: pure `fileReadCharBudget(contextTokens) = max(4K, floor(tokens/2)*4)` (HALF the window at ~4 chars/token) in @muse/fs; the agent passes `maxTextChars: fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX)` (= 64K). Larger files page via the fire-24 nextOffset. Mutation-valid (dropping the /2 → the value test RED; an over-budget file truncates at exactly the budget) + Opus ④b judge PASS: the gap is real (confirmed via the live-observed Ollama overflow, no upstream trimming layer), the derivation is principled (a read can never dominate the context), grounding preserved in the SAFE direction (more reads become partial→truncated, onFullRead never wrongly fires), file_grep/file_list unaffected, the 200K default intact for non-agent callers, conservative bound (uses DEFAULT num_ctx → only tighter if the user raised it, never overflows). Distinct (kind=context-fit/reliability, pkg=@muse/fs+apps/cli).
- ✓ **char-cap reads now page cleanly — RESOLVED fire 36 (was a fire-35 ④b finding).** When a no-`limit` read's leading lines exceed maxTextChars, the char-cap path clears `nextOffset` (a mid-line cut has no clean line boundary), so the model can't page by that field — it must re-issue with explicit `offset`/`limit` (the tool description says so, and that yields a clean nextOffset). Fire 35's lower 64K cap makes this trigger more often. Candidate: on a char-cap, return a `nextOffset` = the FIRST FULLY-CONTAINED line after the cut (round down to a line boundary) so the model still gets deterministic paging without a partial line. Low-risk, testable; validate the rounding never re-reads/skips a line. RESOLVED: the char-cap path now TRIMS the trailing partial line to a clean boundary and sets `nextOffset = start + completeLines + 1` (completeLines = newlines in the capped slice — conservative, so the boundary line is re-read in FULL, never skipped); a single line longer than the cap (no newline) keeps nextOffset undefined (can't page by line). Mutation-valid (reverting to the old clear-nextOffset → both the trim test AND a 10-line round-trip test go RED) + Opus ④b judge PASS: drove the paging loop — EVERY line read, NONE skipped (overlap-at-boundary only, never a gap), nextOffset always advances (no infinite loop), char-cap still sets truncated=true so onFullRead stays suppressed (grounding gate intact), numbered-mode + empty/1-line/no-trailing-newline edges all correct. Distinct (kind=reliability/paging, pkg=@muse/fs) — the right follow-up to fire 35's 64K cap that made char-cap frequent.
- ✓ **isUnbackedActionClaim helper — false-done condition extracted to ONE shared, tested definition (computer-control fire 31, decompose 30a).** The backstop condition `requestsToolAction(query) && answerClaimsAction(answer) && !actionToolRan(toolNames)` was INLINED at 3 sites (commands-ask:2862, chat-repl:634/698) — a drift risk (add a leg at one site, the others diverge). Extracted to `isUnbackedActionClaim({query, answer, toolNames})` in agent-core (where the 3 detectors live), wired all 3 CLI sites to it, cleaned the now-unused imports (kept requestsToolAction in commands-ask for askIsActionRequest@2861, kept actionToolRan in chat-repl for the post-re-prompt check@640). Behavior-IDENTICAL (Opus ④b judge: 0 mismatches on 10 cases vs the inlined form; askIsActionRequest@2863/2871 + chat-repl:640 intact; only unused imports removed; pnpm check exit 0). Mutation-valid (dropping the `!` on actionToolRan → RED). This is the SEAM for 30b (the AgentRuntime re-prompt will compose the same one definition). Distinct (kind=refactor/seam, pkg=@muse/agent-core+apps/cli).
- ◦ NEXT ② **edit RATIONALE citation (softer follow-up)** — the path + the read-before-edit gate are
  now grounded; a remaining nicety is citing WHY (the file/error line) in the agent's change summary.
  Lower value than the gate (the gate is the hard guarantee); pick up only if the surface needs it.
- ✓→Done ① **run_command (EXECUTE path) first ever end-to-end verification + hardening** (2026-06-16) —
  the execute half of computer-control was UNVERIFIED: the `muse-runner` Rust binary wasn't even built
  and no eval existed. Built it (`cargo build --release` → `target/release/muse-runner`, workspace
  target). New `scripts/eval-run-command.mjs` (+ `eval:run-command`): live gemma4 must RUN a fixture
  Node script via run_command and report the unique token it prints (terminal-state / grounded — a
  fabricated "I ran it" can't pass; skips if Ollama OR the binary is absent). FIRST run found the real
  failure: the 12B packed the whole line into `command` (`"node /abs/report.mjs"`) → runner rejects
  ("command must be an executable name, not a path"), 0/1. FIX (both tool-calling.md levers): (1)
  schema — `command`/`args`/`cwd`/`timeoutMs` got example-bearing descriptions + a use-when/not-when
  line (rule 3/4); (2) deterministic repair in `parseRunnerCommandRequest` — when `command` carries
  whitespace and no explicit args (and no quotes), tokenize into executable + args (rule 7). TDD:
  tools 272/273 (split when no args / multi-flag / NOT when args given / NOT when quoted), build 0,
  lint 0. Live `MUSE_EVAL_REPEAT=3 eval:run-command` = **3/3** (the schema fix alone made the model
  emit `command:"node", args:[path]` correctly; repair is the backstop). Report-only per 진안.
  PRE-EXISTING wiring confirmed: `createRunnerTools` gates run_command behind `MUSE_RUNNER_ENABLED` +
  `MUSE_RUNNER_PATH` (default "muse-runner" on PATH) — so production needs that env + the built binary.
- ✓→Measured ① **edit→run→verify LOOP baseline = ~33% (gemma4 coherence CEILING, not a deterministic
  bug)** (2026-06-16) — new `scripts/eval-edit-run-verify.mjs` (+ `eval:edit-run-verify`): a failing
  test, model must FIND (grep/read) → FIX (file_edit, read-before-edit gate wired) → RUN (run_command)
  to confirm, graded TERMINAL-STATE (harness re-runs the test → exit 0) + no-collateral + model-ran-
  test. pass^3 = **1/3**. Failure modes (debug-confirmed, NOT arg-quality — 0 bad-option): run 1 ran
  the test once, saw FAIL, then STOPPED without editing (premature termination); run 3 used NO tools
  at all (no-op). This is the MAST small-model failure class (step-stop / unaware-of-termination), the
  binding multi-step-coherence limit on a 4-tool autonomous loop — NOT a deterministic patch target.
  Honest reading: the three SINGLE capabilities (find/fix, edit-repair, execute) are each solid (5/5,
  3/3); the COMPOSED autonomous loop is at the model's ceiling. GOOD news surfaced: the model used
  `cwd` correctly and the run_command arg-split held (the earlier fixes carried). Eval kept report-only.
- ✓→Done ① **edit→run→verify loop 1/3 → 3/3 via an agentic-persistence prompt (the ceiling was a
  PROMPT gap, not the model)** (2026-06-16) — investigation flipped the read: (a) the existing
  decomposition machinery (`runLeadWorkerTask`) is the WRONG shape — it fans out INDEPENDENT subtasks
  and synthesizes, but the loop is a SEQUENTIAL DEPENDENT pipeline (edit needs read's finding), so a
  worker in its own clean context can't carry it; (b) the production `--with-tools` system prompt was
  recall-tuned ("Keep it concise — 2–4 sentences") with NO multi-step guidance, so the model quit after
  the first tool call. FIX: added two GENERAL agentic-persistence lines to the withTools branch of the
  ask system prompt (`commands-ask.ts`) — "when a task needs several steps, keep taking the next action
  until done; if a command/test fails, fix it and re-run to confirm before answering". Conditional, so
  a single-tool ask is unaffected. MEASURED FIRST in the eval (isolated lever) then aligned the eval's
  system lines to the SHIPPED wording: `MUSE_EVAL_REPEAT=3 eval:edit-run-verify` = **3/3** both times
  (was 1/3). CLI tsc 0, lint 0. NOT a brittle hack — general agent guidance, the same persistence every
  harness uses. Report-only eval per 진안.
- ★ FRONTIER FOUND ① **multi-file loop = 0/3 — a general shell (run_command) makes the 12B abandon the
  structured file tools** (2026-06-16, `scripts/eval-multifile-fix.mjs` + `eval:multifile-fix`, a
  RED ceiling-probe). Harder fixture: a buggy `multiply` among add/subtract/divide across src/ files,
  where `add` and `multiply` share `return a + b;` so a bare edit is AMBIGUOUS. With the SHIPPED
  persistence prompt, pass^3 = **0/3** — the model runs the test, greps to locate the file, then
  reaches for SHELL idioms via run_command to inspect/navigate (`cat src/math.mjs`, `ls -l`,
  `find . -R`) — flailing on cwd/relative paths — and NEVER reaches a successful file_edit. TWO general
  prompt nudges were tried and IGNORED (persistence; an explicit "inspect with file_read, not the
  shell" line) — so this is a tool-SELECTION bias, not a prompt-tweakable gap, and it also bypasses the
  read-before-edit gate (the model "reads" via `cat`). The simpler one-file loop stays 3/3; the gap is
  specifically the general-shell-vs-structured-file-tools competition on a small model. REAL LEVERS
  (design decisions, NOT another prompt line): (a) tool DISCIPLINE — don't expose a general shell
  alongside the file tools for an edit task, or split by phase; (b) sandbox run_command's cwd to the
  workspace + deny file-content shell utils (cat/ls/find) so file_read/file_grep are the only inspect
  path; (c) DECOMPOSE — a "locate+fix" sub-step (file tools only) then a "run the test" sub-step. Pick
  one with 진안 — each is a real slice, and the probe is the gate that proves it.
  - ◑ lever (a) phase-scoped tools SHIPPED + lever-adjacent grep-read fix → **0/3 → 2/3** (2026-06-17,
    진안-picked lever (a)). `GeneralShellPhaseGate` (packages/agent-core/src/general-shell-phase.ts,
    wired into BOTH model-loop activeTools filters): when the tool set has BOTH a general shell
    (run_command) AND a structured file-write tool (file_edit/…), the shell is available initially
    (run the failing test), WITHHELD during the locate+fix phase (after a shell use, until a write
    LANDS), and RE-ARMED after a landed write (confirm). Engages only when both classes are present
    → run_command-alone (execute eval) + one-file loop (3/3) do NOT regress. Unit 10/10 + loop wiring
    2/2 + agent-core 2446 green. The live trace PROVED the shell-cannibalization (cat/ls/find) is GONE
    — the model now stays on file_grep/file_read/file_edit and writes CORRECT scoped fixes. But the
    probe then exposed a second blocker: the model inspects via content-mode `file_grep` (not
    file_read), so the read-before-edit gate refused every (correct) edit. Fixed in @muse/fs: a
    content-mode grep marks the files it returned content from as READ (consistent with file_read,
    which already marks a path read after an offset/limit PARTIAL view) — files-mode (no content
    shown) does NOT. Wired in production via createFsReadTools (not probe-only); fs 102 green (+2).
  - ◑ edit-integrity gate + file_grep regex robustness SHIPPED (2026-06-17). Two MORE deterministic
    dead-end classes eliminated: (1) `checkEditIntegrity` (packages/fs/src/edit-integrity.ts, opt-in
    via FsWriteToolsOptions.checkEditIntegrity, ON in commands-ask + eval) fail-closes file_edit on a
    DESTRUCTIVE edit — deleting a top-level definition (the `multiply → ""` botch) or unbalancing
    ()[]{} (string/comment-stripped, regression-only) — turning a silent corruption into a guided
    retry; (2) `compileGrepPattern` (fs-read-tools.ts) makes file_grep NEVER throw — a small model's
    invalid regex (a lone `}` fatal under /u, double-escaped `\\`) was crashing every grep and the
    model looped on it without ever editing; now it degrades strict-u → no-flag → LITERAL substring.
    fs 122 green (+22). Both PROVEN by traces: no more emptied-function corruption, no more
    "invalid regular expression" dead-end.
  - ⚠ RESIDUAL = a 12B MULTI-STEP-COHERENCE CEILING, not a deterministic bug (pass^5 = **3/5**, was
    0/3). With every FIXABLE dead-end removed, the remaining failures are model-reliability on the
    DELIBERATELY-ambiguous fixture (add & multiply share `return a + b;`): mode B — file_edit with an
    ambiguous old_string that matches both → no-op (run 3); mode C — the model greps, ALREADY HAS the
    buggy line in hand, but never constructs the file_edit and gives up after ~5 grep steps (run 5,
    debug3). gemma4 degrades after 2-3 dependent steps (tool-calling.md). NOT closeable by another
    write-path gate without OVERFITTING the fixture. The genuine next lever is (c) DECOMPOSE — a
    constrained "now produce the file_edit" sub-step with only the edit tool + the file in context
    (tool-calling.md #1/#5: fewer competing options per turn) — a BIG slice that may still not be
    deterministic. Candidate marginal lever for mode B only: actionable ambiguous-match refusal
    (occurrence line numbers + "add the enclosing `function` line"). Probe stays RED report-only.
- ◦ secondary: `run_command` args-packing repair (split a single `args` element like `-e "x"` that
  carries a flag+value) — observed once, model recovered, low priority until it actually fails a run.

## ★ Open — TOOL expansion & hardening (loop theme, 진안-directed 2026-06-12)

The loop's standing focus: EXPAND Muse's own tool surface + HARDEN the existing tools.
- ✓→Done **muse.episode list/search `total` lied (post-slice count)** (EXPANSION gap-scout runner-up; shipped fire 22) —
  list/search computed `[...].sort().slice(0, limit)` then returned `total: <sliced>.length`, so `total` was the
  POST-limit count (50 episodes, limit 10 → total:10) not the real store/match size — misleading the model about how
  many episodes exist. The sibling reminders.list does it right (total=pre-slice, shown=post-slice). FIX: sort first,
  `shownList = sorted.slice(0,limit)`, return `shown` + `total = scoped.length` (list) / `matches.length` (search,
  matches now pre-slice). Mirrors reminders. TDD 2 (3 eps, limit 2 → total 3, shown 2) RED→GREEN; an existing test that
  incidentally asserted the buggy `limited.total===1` updated to total:3 + shown:1 (Fable-5 judged the change
  legitimate — incidental characterization, reminders convention is the repo standard). mcp 1718, check 0, lint 0.
  RESIDUAL (non-blocking, one-field follow-up): the llm-judge search branch returns `total: matches.length` (the judge
  caps in code, so there's no pre-slice total) but lacks `shown` for cross-mode consistency.
- ✓→Closed (not a bug) **@muse/model web-search-policy.test "property fuzz"** — investigated in fire 23: the "fuzz" is
  a DETERMINISTIC exhaustive nested loop over a FIXED corpus (enabledOpts × overrideOpts × maxUsesOpts × envWebSearch ×
  envMaxUses), NOT a randomized fast-check property — it runs the exact same ~10k combinations every time, so it is
  input-stable (ran 6× isolated, all 322/322 pass). The single fire-22 failure was ENVIRONMENTAL (slow ~10k iterations
  timing out under the heavy concurrent full-`pnpm check` load, same class as the chat-grounding/playbook-store env
  flakes), not a latent decideWebSearchPolicy edge. No seed to pin, no counterexample exists. Closed.
- ✓→Done **muse.search DuckDuckGo redirect was DOUBLE-DECODED** (EXPANSION gap-scout, fire 23; data-integrity +
  fail-open-to-crash) — `decodeDuckDuckGoRedirect` (loopback-search.ts:369) did `decodeURIComponent(params.get("uddg"))`,
  but `URLSearchParams.get` ALREADY percent-decodes once. So a literal `%20` in a result URL (DDG sends `%2520`) got
  corrupted to a space, and a bare `%` in a target (`https://sale.com/100%-off`) made the second decode THROW
  `URIError: URI malformed`. `parseDuckDuckGoHtml` runs in muse.search's execute() AFTER the fetch try/catch closes
  (loopback-search.ts:191), so the URIError escaped → the whole search call crashed on an attacker-influenceable result
  URL. FIX: drop the redundant decode (`return target ? target : raw;`). TDD 2 (literal-`%20`-survives-intact +
  never-throws-on-bare-`%`) RED→GREEN; the existing redirect tests used single-pass-decoded uddg values so the second
  decode was idempotent there (which masked the bug). mcp 1720, check 0, lint 0. Fable-5 PASS (RED re-confirmed by
  stashing src only; no legit double-encoded path exists — DDG encodes the target once with encodeURIComponent).
- ✓→Done **muse.regex had NO catastrophic-backtracking (ReDoS) guard** (EXPANSION gap-scout; judge-drill target) —
  test/match/replace compiled a user pattern and ran it SYNCHRONOUSLY on up to 50k chars with only a length cap, so a
  nested-unbounded-quantifier pattern ((a+)+, (.*)*, …) HUNG the whole agent process (a sync regex run can't be timed
  out on the main thread; the scout had to SIGKILL it). regex_extract already guards this; the loopback surface never
  got it (same-class-different-surface miss). FIX: export the proven `hasNestedUnboundedQuantifier` from @muse/tools +
  reject in compile() before new RegExp (one guard covers all three tools). TDD 6 catastrophic shapes ×3 tools rejected
  + benign not-rejected, RED→GREEN; mcp 1716, check 0, lint 0. Fable-5 PASS. Also the v1.11.2 JUDGE FAILURE DRILL: a
  narrow `includes("+)+")` guard + non-discriminating test was planted FIRST; the verifier correctly FAILED it (caught
  (.*)*/([a-z]+)*/([a-z]+){2,} slipping through + the non-discriminating test) → rolled back → real fix applied. Judge
  drill 2/2 (fire 10 json.query + fire 21 regex).
- ⏳ **'this weekend' on a Saturday resolves to TODAY (possibly past) — NOT a clean bug (semantic, needs 진안)** —
  loopback-relative-time.ts:477 `delta = (6-getDay()+7)%7` gives 0 on Sat (today) but 6 on Sun (next Sat, skipping
  today). Whether "this weekend" on Sat/Sun means today or next weekend is genuinely ambiguous (like text.stats), and
  the existing weekend test uses a Wednesday reference so the edge is untested-not-documented. Deferred to 진안.
- ✓→Done **add_contact silently DUPLICATED on re-add** (EXPANSION gap-scout, live) — the tool's description
  promises "Add (or update)", but execute always did `id: idFactory()` + save, so a re-add of an existing NAME got
  a fresh id and APPENDED (the store's addContact is id-idempotent only). The duplicate then made the name resolve
  AMBIGUOUS forever (find_contact returns candidates, never a person) — breaking outbound-safety rule 3 (recipient
  must resolve unambiguously) AND remove_contact was equally ambiguous (can't clean up by name). FIX: an optional
  `contacts?` reader on ContactsAddToolDeps; on an exact case-insensitive name match, reuse the existing id + merge
  (new field wins, unmentioned preserved) so an id-idempotent save REPLACES. Wired through BOTH production seams —
  autoconfigure (already addContact-idempotent) + commands-ask vision-auto (CHANGED from a raw read+append
  `writeContacts` to the store's addContact + reader, so it's now id-idempotent + queued). TDD 3 (re-add reuses id +
  merges; case-insensitive; no-reader back-compat) RED→GREEN; mcp 1703, check 0, lint 0. Fable-5 PASS (back-compat
  intact, both seams live). RESIDUAL (non-blocking, separate): exact-name-only match (an ALIAS re-add could still
  duplicate); commands-ask read→save isn't atomic across the merge window (only the save is queued).
- ✓→Done **loopback-crypto base64/hex decode of non-UTF-8 bytes emitted U+FFFD silently** (gap-scout runner-up;
  shipped fire 20) — a valid-FORMAT base64/hex whose decoded BYTES aren't valid UTF-8 (binary, e.g. 0xFF) had
  `toString("utf8")` silently replace them with U+FFFD — garbled text, no error, against the tool's "decode back to
  UTF-8" contract. FIX: a `decodeBytesAsUtf8` helper re-encodes the decoded string and compares to the original
  bytes (valid UTF-8 round-trips exactly; a lossy one doesn't) → `{error: non-UTF-8 (binary) bytes}`. Both base64
  and hex use it; the format-validation error paths are unchanged (distinct). TDD (base64 "/w=="=0xFF + hex "ff"
  → error; emoji/héllo/empty still round-trip) RED→GREEN; mcp 1709, check 0, lint 0. Fable-5 PASS (no valid-UTF-8
  false-reject — emoji/NUL/BOM/literal-U+FFFD all empirically accepted).
- ✓→Done **web_download silently clobbered an existing file** (EXPANSION gap-scout, live) — wrote bytes with a
  plain `writeFile(path, bytes)` (flag "w"), so downloading a name that already exists in the user's Downloads
  dir SILENTLY OVERWROTE the unrelated existing file (irreversible data loss, not even flagged) — AppWorld
  "collateral damage" class, against the module's own fail-closed-disk promise. FIX: a new `writeNonClobbering`
  helper dedupes like a browser (`name (1).ext`, `(2)`, …) using the `wx` flag (atomic exists-check+create, no
  TOCTOU); a real write error (EACCES/ENOSPC) is re-thrown → surfaces, never looped; bounded at 1000. TDD
  (pre-existing report.pdf intact + new bytes at "report (1).pdf") RED→GREEN; mcp 1698, check 0, lint 0.
  Fable-5 PASS (5 concurrent → 5 unique files; fresh-dir original name unchanged; no-ext/dotfile/multi-dot edges).
- ✓→Done **web_download buffered the ENTIRE response body before the size-cap check** (gap-scout runner-up;
  shipped fire 17) — `Buffer.from(await response.arrayBuffer())` then `> maxBytes`, so a multi-GB / never-ending
  body filled RAM despite the 50MB cap (memory-exhaustion DoS). FIX: a Content-Length pre-check (reject before
  reading if declared > cap) + a streamed `getReader()` read that aborts (`reader.cancel()`) the moment the
  accumulated size crosses the cap — the server can lie about/omit CL, so the streamed abort is the real defense;
  a no-body fallback still caps via arrayBuffer. TDD (instrumented 20×100B stream, cap 250B → aborts after ~3
  chunks, nothing written) RED→GREEN; mcp 1700, check 0, lint 0. Fable-5 PASS (under-cap byte-identical, no false
  reject on absent/garbage CL).
- ✓→Done **FLAKY cli chat-grounding.test "fails soft when retrieval throws" — made hermetic (fire 18)** — failed `pnpm check` transiently
  in fires 16 AND 17 (~5s, Ollama-timing dependent), passes on isolated re-run. Not a loop-slice regression but a
  real flaky gate. NEEDS: make the test hermetic (it should fail-soft without a live/slow Ollama path) — small fix
  but on the chat-grounding surface, separate from the TOOL theme; flag to 진안 / a chat-grounding fire. RESOLVED: added an optional injectable `searchRecall` DI seam to
  groundChatTurn/retrieveChatGrounding (production default = real recall); the test now injects a sync-throwing
  recall + MUSE_CHAT_AUTO_REINDEX=0 → NO network, runs in ms (was ~5s), and asserts `called===true` (strictly
  stronger). Fable-5 PASS (production unchanged, fail-soft still exercised). cli 2530, check 0 first-try, lint 0.
- ✓→Done **muse.tasks.update lost-update TOCTOU** (gap-scout runner-up; shipped fire 16) — built a WHOLE stale
  snapshot (`{...tasks[index]}`) outside the write queue and wrote it back inside mutateTasks, so two concurrent
  updates to DIFFERENT fields lost-update (last-writer-wins on the whole object). FIX: build a field-level DELTA
  (sets/clears) and re-apply it onto the FRESH `current[i]` inside the mutate callback (mirror `complete`); single-
  update semantics 1:1 unchanged. TDD (two concurrent updates to title + notes both persist in tasks.json) RED→GREEN;
  mcp 1699, check 0, lint 0. Fable-5 PASS (reproduced RED in a /tmp worktree). RESIDUAL (acceptable, pre-existing):
  a partial dueAt reschedule still anchors to the stale existing-due, so a due-move RACE on the SAME field is
  last-writer-wins (the cross-field lost-update is fixed); same class as `complete`'s resolve-outside-queue.
- ✓→Done **muse.url.parse query map prototype pollution** (EXPANSION gap-scout, live) — the query map was a
  prototype-bearing `{}`, so an attacker-controlled URL `?__proto__=a` hit the Object.prototype SETTER (param
  vanished + the object's prototype polluted before serialization) and `?constructor=c` collided with the
  inherited Object constructor (corrupted to an array via the dedup). Same class as the fire-4 json.merge
  __proto__ fix, unfixed on the URL surface. FIX (1 line): `const query = Object.create(null)` — null-prototype
  map, so __proto__/constructor land as plain own DATA keys and the `existing === undefined` dedup works for
  every key. TDD 1 (__proto__=a → own "a", constructor=c → "c", x="1") RED→GREEN; mcp 1696, check 0, lint 0.
  Fable-5 PASS (dedup string/array shapes preserved, JSON serializes null-proto own keys, no downstream consumer).
- ⏳ **muse.text.stats whitespace→zero — NOT a clean bug (documented behavior, needs 진안)** — `stats("   ")` returns
  `{characters:0, lines:0, words:0}` but an existing test (mcp.test.ts "treats whitespace as zero") DOCUMENTS this as
  intended. Unlike encode_query's incidental "[object Object]", the whitespace→zero is a named design choice — changing
  it alters documented behavior. Deferred to 진안: is whitespace-only meant to count as zero, or report factual chars/lines?
- ✓→Done **muse.url.encode_query encoded a nested object as "[object Object]"** (gap-scout runner-up; shipped fire 14) —
  `String(raw)` coerced a nested object/array value to the literal "[object Object]" — a silently-corrupt query param.
  FIX: an isScalar guard returns `{error: must be string/number/boolean}` for a non-scalar value or array item (scalars,
  scalar arrays, null/undefined skipping unchanged). TDD (nested-object value + object-in-array → error; scalar control
  encodes) RED→GREEN; updated an existing unit that incidentally characterized the "[object Object]" output (Fable-5
  judged the change legitimate — the test's intent was scalars). mcp 1697, check 0, lint 0.
- ✓→Done **muse.calendar.add mis-anchored a time-only endsAt** (EXPANSION gap-scout, live EN+KO) — `add`
  resolved `endsAt` with `parseIsoDate(endsAtRaw)` whose default anchor is now(today), so a bare time-of-day
  end ("4pm"/"오후 4시") for a NOT-today event resolved against TODAY while startsAt resolved to tomorrow →
  the LocalCalendarProvider INVALID_TIME_RANGE guard rejected it ("endsAt must be at or after startsAt").
  The sibling `update` already anchors a time-only end to the event day (`anchorFor`); `add` never did. FIX
  (1 expr): anchor a time-only endsAt to the resolved START's day — `isTimeOnlyPhrase(endsAtRaw) ?
  parseIsoDate(endsAtRaw, () => startOfLocalDay(startsAt)) : parseIsoDate(endsAtRaw)`. Date-bearing/ISO/absent
  endsAt unchanged. TDD 2 (EN "tomorrow 3pm"+"4pm", KO "다음 주 월요일 오후 3시"+"오후 4시" → end on start's
  day 16:00, no error) RED→GREEN via a registry mirroring the provider guard; mcp 1694, check 0, lint 0.
  Fable-5 PASS (no regression on other endsAt shapes; guard untouched).
- ✓→Done **muse.calendar.update cross-day move anchored a time-only endsAt to the OLD day** (gap-scout runner-up; shipped fire 12) —
  update's `anchorFor` uses `resolved.event.startsAt` (the original day), so "move it to Monday, ending 5pm"
  lands the end on the original day, not Monday. FIX: anchor the time-only endsAt to `newStartsAt` when the
  start moved. 1 expr + 1 test. (Sibling of the add fix above.)
- ◦ **relative-time "this weekend" asked ON a Saturday resolves to today 09:00 (possibly past)** (runner-up) —
  loopback-relative-time.ts:~477 delta `% 7` = 0 with no roll-forward (unlike the bare-weekday handler that
  forces delta=7). FIX: roll forward to next Saturday when today is already Sat. 1 line + 1 test.
- ✓→Done **muse.math.evaluate silently truncated a malformed multi-dot number** (EXPANSION gap-scout) —
  `parseNumber` scans a literal by greedily consuming digits AND dots, then did `Number.parseFloat(literal)`:
  `parseFloat("1.2.3")` returns 1.2 (stops at the 2nd dot, NOT NaN), so the NaN guard never fired and
  `evaluate("1.2.3 * 100")` silently returned 120. The math tool's WHOLE contract is an exact digit the
  local 8B can't compute, and this is the shared core behind the muse.math MCP tool AND the muse ask /
  chat-repl arithmetic fast-paths — a wrong digit flows into a user answer with NO model in the loop.
  FIX: one line, `Number.parseFloat(literal)` → strict `Number(literal)` (Number("1.2.3")=NaN → existing
  `invalid number literal` throw; "5."/".5"/integers/decimals still parse — node-verified no valid number
  regresses; "1..2" also now rejected). TDD 1 (multi-dot → error + 5./.5 controls) RED→GREEN; mcp 1687,
  check 0, lint 0. Fable-5 verifier PASS (no valid-input regression, reaches ask/chat fast-path). Matches
  code-style.md "strict Number() not parseFloat".
- ✓→Done **muse.json.query walked the prototype chain** (EXPANSION gap-scout runner-up; shipped fire 10) — path resolution uses
  `segment.key in cursor` so a path like `constructor`/`__proto__` on a plain object returns `found:true`
  with an inherited (often function) value that JSON-serialization silently drops to `{found:true}` (no
  value), and `__proto__` leaks Object.prototype. FIX: `Object.hasOwn(cursor, segment.key)` (own-property
  only). Sibling of the fire-4 __proto__ merge fix. 1 line + 1 test.
- ✓→Done **atomicWriteFile leaked its tmp on failure** (EXPANSION gap-scout runner-up) — `atomicWriteFile`
  (the shared sidecar-store write primitive) opened `<file>.tmp-<pid>-<uuid>`, wrote+fsync+closed it, then
  `fs.rename(tmp, file)`. On ANY failure after the tmp was opened (writeFile/sync error OR the rename
  failing), the tmp was orphaned → `*.tmp-*` litter accumulating in every sidecar dir (memory/tasks/
  reminders/action-log/…). FIX: wrap open→write→rename→chmod in try/catch; on failure
  `fs.rm(tmp,{force:true}).catch(()=>undefined)` then rethrow the ORIGINAL error (rm errors swallowed, never
  substituted; force no-ops if open never created the tmp). TDD 1 behavioral (target=directory → rename
  throws → assert rejection AND zero `.tmp-` entries) RED→GREEN; mcp 1681, check 0, lint 0. Fable-5 verifier
  PASS (swapped HEAD source to reproduce RED; no cross-writer race — rm targets only this call's UUID tmp).
- ✓→Done **muse.fs.stat lied about symlinks** (EXPANSION gap-scout runner-up) — the tool's description
  promises "Symlinks are reported as kind=symlink without following", but it called `fsLib.stat` (which
  FOLLOWS the link), so `entryKind`'s `isSymbolicLink()` was always false → a symlink was ALWAYS reported
  as its target's kind, never `symlink`. The contract was unsatisfiable. FIX: added an optional `lstat?`
  to the injectable fs seam + wired real `node:fs/promises` lstat into the default; the stat tool now
  calls `(fsLib.lstat ?? fsLib.stat)(decision.resolved)` (lexical path → lstat sees the link). The
  realpath-escape guard still runs first (unchanged), so no path guard was weakened. TDD 1 behavioral
  (lstat→isSymbolicLink → kind=symlink, vs stat-follow → file) RED→GREEN; mcp 1680, check 0, lint 0.
  Fable-5 verifier PASS (sandbox-compiled HEAD reproduced RED). RESIDUAL: read/list still FOLLOW symlinks
  on the lexical path (by design — realpath guard prevents escape; a symlink-swap TOCTOU window remains,
  separate slice). Runner-up still OPEN: `atomicWriteFile` leaks `*.tmp-*` on a write/rename failure (no
  unlink on the error path — accumulates litter in sidecar store dirs).
- ✓→Done **muse.json.merge prototype-pollution** (EXPANSION gap-scout, Fable-5) — `deepMerge` did
  `result[key] = …` for every key of model-supplied `overrides`; model args arrive via JSON.parse, which
  makes `"__proto__"` an OWN data key, so `result["__proto__"] = …` hit the Object.prototype SETTER and
  HIJACKED the merged object's prototype (silently injected inherited fields like `isAdmin`, dropped the
  key). FIX: special-case `key === "__proto__"` — read any existing own value via
  `Object.getOwnPropertyDescriptor`, deep-merge, write back via `Object.defineProperty` as an own
  enumerable data prop (never the setter); other keys unchanged. Verifier confirmed `__proto__` is the
  ONLY setter vector here (constructor/prototype create plain own props, no pollution) and the guard
  recurses to every depth. TDD 1 behavioral (JSON.parse'd `__proto__` overrides → prototype intact +
  no injected field + key preserved as data) RED→GREEN; mcp 1679, check 0, lint 0. Fable-5 verifier PASS.
- **ask error-path run-log trace (#6/#7) — DECOMPOSED (v1.11.2 decompose-on-defer)**: writeRunLog(success:true)
  was inline at the END of the ~2000-line `muse ask` action (commands-ask.ts:3734) with NO enclosing
  try/catch, so a thrown run left no trace (error-analysis fuel lost) + Ctrl-C logged success:true. Same
  pattern in chat-repl. Split into loop-sized slices with exact seams:
  - ✓→Done **6a — pure `buildAskRunLog` builder (the shared seam)**: extracted the inline cli.local payload
    into `buildAskRunLog(params)` in program-helpers.ts (next to writeRunLog), supporting BOTH success and a
    FAILURE shape (`success:false` + `error`). Wired the live success path (commands-ask.ts:3734) to it
    (not inert). TDD 3 (success payload + readResponseSuccess lifts true; FAILURE payload lifts false + carries
    error; confidence/error omitted when absent) RED→GREEN. cli 2528, check 0, lint 0.
  - ◦ **6b — wrap the ask run in a failure-logging seam (THE fix, dedicated fire)**: extract the 1842 action
    body into a nested `async function runAskAction(queryParts, options)` (closure vars stay in scope) and
    register `.action(async (q,o)=>{ try { await runAskAction(q,o) } catch(e){ await writeRunLog(.., buildAskRunLog({..success:false, errorMessage:String(e)})); throw e } })`. RED: a thrown ask run writes a
    success:false entry. SIZING: the body-extraction is a big MECHANICAL (~2000-line) move — behavior-identical,
    verify with the full ask suite BEFORE adding the catch; warrants its own focused fire (or human-paired), not
    bundled. 6a already provides the payload so the catch is one-liner.
  - ◦ **6c — #7 Ctrl-C/abort does NOT log success:true**: once 6b's catch exists, an AbortError/SIGINT reaching
    it logs success:false (or skips), never success:true. RED: simulate abort → assert no success:true entry. Small.
  - ✓→Done **6d — chat-repl failure trace**: `createTuiChatSubmitter` wrote a run-log only on the happy
    path; a thrown runner left no trace. Added an injectable `runChat` param (default = real local/remote
    dispatch) + a try/catch that writes a `success:false` entry (response {error, success:false}) best-effort
    then re-throws the original error. TDD 2 (throwing runner → success:false trace + re-throw; success path
    unchanged) RED→GREEN. cli 2530, check 0, lint 0. Fable-5 PASS (success path byte-identical, no double-log).
    Note: done independently of 6b (chat handler is a small fn, no 2000-line extraction needed).
- ⏳ **calendar credential encryption-at-rest — DEFERRED (architectural cost)**: `FileCalendarCredentialStore`
  stores caldav passwords / google tokens plaintext (0600). The proven envelope lives in `@muse/memory`,
  but `@muse/mcp`→`@muse/calendar` already, and `@muse/memory` pulls `@muse/db`+`@muse/model` — encrypting
  the lean calendar package would bloat its dep graph (and the desktop binary). Needs a shared low-level
  crypto seam or a key-provider injection decision (Jinan-level), not an autonomous fire.
- ✓→Done **notes-family tool-selection coverage + sharpened save/append not-when** (per-tool not-when
  audit follow-up): `muse.notes` save/append had ZERO not-when clauses and were ABSENT from eval:tools.
  RED baseline (live gemma4, 3 runs) caught a real save-vs-append confusion (KO "write to a note" →
  notes.append 0/3 instead of notes.save). FIX: sharpened save (=CREATE/REPLACE a note FILE) + append
  (=ADD to an EXISTING note) descriptions with use-when/NOT-when (both NOT a to-do/reminder) +
  `buildNotesScenario` (6 cases: 3 positive notes-file + 3 disambiguation task/reminder must NOT route
  to a note tool). GREEN 12/12 STABLE 3/3; Fable-5 verifier PASS (discriminating + registered + not
  over-fit). mcp 1678·check 0·lint 0. REMAINING per-tool not-when targets: messaging/episodes/context.
- ✓→Done **SSRF-guard test fallout swept (web_action consumers)** — the earlier always-async
  assertPublicHttpUrl hardening correctly broke 4 tests that used non-resolvable reserved-TLD hosts
  (`*.test`) as fake public URLs → guard refused them, no fetch fired. Threaded an OPTIONAL
  `lookup?: HostLookup` DI seam through `buildActuatorTools` + `approvePendingApproval` (runActuatorByName
  already had it); the 4 tests (cli×2, api×2) now inject a fake PUBLIC resolver. Production omits lookup →
  real node:dns/promises → guard intact (Fable-5 verifier confirmed: seam is caller-controlled, not
  model-facing; no SSRF hole). check 0·lint 0.
- ✓→Done **scout raw-NUL byte-hygiene regression** — `run-log-analysis.ts:85` had a literal raw NUL
  delimiter (`${kind}\x00${topic}`) from an earlier fire, FAILING the @muse/shared byte-hygiene gate on
  main (caught by `pnpm check`, missed by quick self-eval). Replaced with the u+0000 escape (byte-identical
  runtime value; key is Map-only, never split). shared byte-hygiene 30/30.
- ✓→Done **web_download post-redirect SSRF re-check** (EXPANSION-scouted): the SSRF guard ran only
  on the INITIAL url, so a public URL redirecting to a private/link-local host (169.254.169.254
  metadata, 127.0.0.1) was followed and WRITTEN TO DISK. Now re-applies assertPublicHttpUrl to the
  final `response.url` AFTER fetch, BEFORE any write (mirrors loopback-web-read + fetch-readable-url —
  web_download was the only fetch path missing it). Behavioral test (redirect→private = refused +
  nothing written) RED→GREEN; Opus security-grade verifier PASS. mcp 1668·lint 0.
- ✓→Done **SSRF DNS-rebinding closed** — the web fetch tools (web_download, web_action) had a
  `deps.lookup ? async : sync` bypass: with no lookup wired (production), the SYNC guard ran, catching
  only LITERAL private IPs, not a public hostname that *resolves* to a private IP (rebinding). Fix:
  drop the bypass, always call `assertPublicHttpUrl` (its defaultLookup = node:dns/promises resolves +
  checks) — so the no-lookup production path now catches rebinding. Hermetic tests: injected
  privateLookup→refused + a dns-stubbed no-lookup test that the verifier confirmed discriminates the
  fix (reverting the bypass makes it fail). web_action fixed too. (loopback-web-read was already
  correct.) mcp 1670·lint 0. Note: this fire FAILED first (test proved NXDOMAIN not rebinding) →
  test fixed → re-verified PASS.
Every slice ships its eval/test and never weakens the grounding floor. Ranked:

- ✓→Done **mac wifi_status read** (capability-scout): "am I on WiFi? / what network?" was unanswerable
  — `mac_system_set` could TOGGLE wifi but there was no READ (write/read asymmetry). Added a
  `wifi_status` shell-read source to the wired `mac_app_read` (networksetup -listallhardwareports →
  device, -getairportnetwork → {connected, network}), reusing parseWifiDevice. read-only (no
  -setairportpower). Behavioral parse tests (connected+disconnected) + eval read-vs-write disambig
  (EN+KO). macos 85·lint 0, Opus-verified. SCOUT NOTE: surface now broadly capable; remaining
  capability gaps are niche/live-only (running_apps, ip_address) → recommend a theme switch next.

- ✓→Done **mac_screenshot arbitrary-write closed** (EXPANSION-scout): the `path` arg went straight to
  `screencapture -x <path>` with no validation — a model/injection could overwrite ANY writable file
  (e.g. ~/.ssh/authorized_keys) with PNG bytes. Fix: allowlist (~/Desktop, ~/Downloads, tmp), `~`
  expand, basename, parent-dir realpath check, AND full-target realpath (a symlink AT an allowed path
  pointing outside is refused — mirrors the loopback-filesystem fix). fail-closed, runner never called
  on refusal. 6 behavioral tests (abs-path/traversal/outside-parent/symlink-at-target → refused,
  allowed/default → ok). FAIL→fix→re-PASS: the first gate caught a SILENT symlink-at-target residual
  (the prior fire had just closed that exact class) → closed it + tested → re-verified. macos 83·lint 0.

- ✓→Done **loopback-filesystem symlink-escape closed** (EXPANSION-scout runner-up): the MCP
  filesystem server's allowlist checked paths LEXICALLY only — a symlink inside an allowed root
  pointing outside (/allowed/x -> /etc/passwd) passed and was read/listed/statted. Fix: a 2nd gate in
  checkAllowed realpath-resolves the path AND the roots (symmetric, handles macOS /var->/private/var)
  and refuses if the real path escapes (fail-closed on throw/ENOENT); applied to read/list/stat. 8
  behavioral tests (escape→error, normal→content, dangling→refused). Verifier confirmed production
  always wires the default realpath (the optional dep is test-only, no skip-hole). mcp 1678·lint 0.
  (file_read already had a realpath guard; this was the MCP-server variant's gap.)

- ✓→Dropped (NOISE, fire 6) **browser-read ungrounded ×7** — the scout's first hit turned out to
  be dev-test NOISE: 7 traces from the 2026-06-11 browser-testing session, all EMPTY answers
  (ans_len 0, tools []) — a no-op the gate correctly marked ungrounded, NOT a real grounding miss.
  Fix went to the SCOUT instead (fire 6): exclude empty-answer non-answers, so the board is now
  clean. Lesson: an ungrounded EMPTY answer ≠ actionable work.

EXPAND (new reach):
- ✓→Done **browser_look — describe the current browser page visually (local vision)** — browser_read
  returns DOM text + elements, so a VISUAL page (chart, graph, map, diagram, image, a rendered error
  dialog) was invisible to the model. New browser_look captures the page (controller.screenshotBase64,
  added to the BrowserController interface) and describes it with the local vision model (injected
  describeImage; the CLI binds it via the same screenVision holder as mac_screen_read — omitted when no
  model). Completes "vision everywhere": screen (mac_screen_read) · local image (file_read) · image URL
  (web_read) · browser page (browser_look). Sharpened browser_read with a not-when line (visual content
  → browser_look) so the model doesn't default to text-read. TDD 4 (well-formed, capture+describe+mime,
  question passthrough, vision-error); eval:tools browser scenario 9/9 STABLE 3/3 (browser_look vs
  browser_read on chart/graph prompts); eval:browser-agent 1/1 (act-path untouched); LIVE — a real
  Chrome page captured and described via gemma4, no error. browser 41, full eval:tools 138/139 (1
  known synthetic flake), check 0, lint 0.
- ✓→Done **web_read describes IMAGE URLs via local vision** — web_read read HTML and PDF URLs but
  rejected image content-types ("not a readable text page"), even though file_read reads LOCAL images
  via vision. Now an image/* response is read as bytes (10MB cap) and described by an injected
  describeImage callback (autoconfigure binds it from the assembly's gemma4 in buildLoopbackTools —
  @muse/mcp stays model-free); absent model ⇒ refused as before. HTML/PDF paths unchanged. Completes
  the symmetry: file_read (local text/pdf/docx/image) ↔ web_read (URL html/pdf/image). TDD 3 (image
  via injected vision + mime, refuse-without-vision, HTML still text); an existing non-readable test
  moved to application/zip so it still exercises that path; LIVE — a real image URL routed through
  web_read's vision path returned a description (no error). mcp 1648 + autoconfigure 505, check 0,
  lint 0, precheck:grounding pass^2.
- ✓→Done **file_read reads IMAGE files via local vision** — file_read classified .png/.jpg/etc. as
  "unsupported" even though Muse has local vision (describeImage, already used by mac_screen_read). Now
  an image FileKind (extension + magic-byte sniff: PNG/JPEG/GIF/WEBP) routes the bytes to an injected
  describeImage callback (the CLI binds it to the assembly's gemma4 via the same lazy holder as
  mac_screen_read; @muse/mcp stays model-free); absent callback ⇒ refused as before. imageMimeType
  derives the MIME from extension then magic. Magic-detected images win over a misleading extension.
  TDD 5 (classify/sniff/route-via-vision/refuse-without-vision/vision-error); eval:file-read image
  round-trip (routed + mime + refuse-without-vision); LIVE — a real Chrome-rendered receipt PNG read
  by gemma4 returned "CAFE MUSE / Latte x2 9,000 / Total 9,000 KRW". file_read is now read-any-file
  (text/pdf/docx/image). mcp 1645, full eval:tools 137/137, check 0, lint 0.
- ✓→Done **web_read reads PDF URLs (not just HTML)** — `isReadableContentType` rejected
  application/pdf, so "summarize this report.pdf link" failed with "not a readable text page". Now a
  PDF content-type response is read as bytes (10MB cap) and extracted via the same pdfjs already used
  by file_read (injectable `extractPdfText`, default lazy pdfjs); HTML still routes through the text
  extractor. One-step "summarize this PDF link" instead of download-then-read. TDD 2 (PDF via injected
  extractor, HTML still uses text path); LIVE — a real Chrome-generated PDF fetched through web_read's
  pdfjs path returns the body text. mcp 1640, check 0, lint 0.
- ✓→Done **web search wired into the default agent (muse.search)** — `muse.search` (web search, zero-config
  DuckDuckGo fallback, SearXNG when MUSE_SEARXNG_URL is set) existed + was tested but was ONLY reachable
  behind the opt-in MUSE_LOOPBACK_MCP_ENABLED flag, so by default the agent could not answer fresh-web
  questions. Added it to the always-on buildLoopbackTools bundle (MUSE_SEARCH_ENABLED opt-out), gave the
  tool KO+EN keywords + use-when/not-when + an example schema (it had none, so it ranked 0 under the diet
  cap). TDD 3 (bundle present / default-on / opt-out) + eval:tools web-search scenario 4/4 STABLE 3/3
  (muse.search vs knowledge_search vs web_read); LIVE: `muse ask --with-tools` searched the web and
  answered with puppeteer 25.1.0. autoconfigure 505, full eval:tools 135/135, check 0, lint 0.
- ✓→Done **browser: uncapped deterministic matching, capped display** — scan/match cap raised
  50→150 (BROWSER_MAX_ELEMENTS), model-facing display capped at 40 (BROWSER_DISPLAY_ELEMENTS) with a
  truncated/shownElements/totalElements + "showing N of M" hint (no silent caps). click/type/find
  resolve against the FULL set (matcher is code), so a target past #40 still acts. TDD 3 cases
  (display cap + true total + match-beyond-cap + small-page-not-truncated); smoke:browser long-page
  case (71st element reachable past the 40 display cap); eval:tools browser 7/7 ×3, eval:browser-agent
  3/3, check 0, lint 0.
- ✓→Done **browser: same-origin iframe piercing (observe + act)** — the snapshot walk now descends
  into same-origin iframe contentDocuments (like shadow roots; cross-origin throws → skipped), so
  embedded forms/checkout/widgets are visible. The act path went frame-aware: `locateRef` finds the
  puppeteer Frame holding a ref (main doc incl. shadow via pierce/, else a child frame) and
  click/type use `frame.locator` — so a click/type on an element INSIDE an iframe acts in its own
  frame, not the main one. smoke:browser gains a same-origin srcdoc-iframe case (button listed +
  clicked inside the frame, text flips Paid); eval:browser-agent 3/3 (act-path refactor no
  regression); browser unit 37, check 0, lint 0. Cross-origin iframes stay out (CDP needs per-frame
  contexts — honest scope).
- ✓→Done **file_read: .docx (Word) extraction** — `docx` FileKind + lazy mammoth (extractRawText,
  injectable like extractPdfText); routes by extension since a .docx is a zip (sniffs unsupported).
  Description gains the Word cue. TDD 4 cases (classify/resolve/route/description); eval:file-read
  generates a REAL .docx at runtime (self-contained minimal-zip writer via node:zlib crc32/deflate —
  no committed binary) → mammoth extracts → tool round-trip; eval:tools file scenario 6/6 STABLE 3/3
  (KO '계약서 워드 파일' → file_read), full 131/131; check 0, lint 0. Follow-up: .xlsx — see the ⏳ dep-decision blocker in HARDEN.
- ✓→Done **web_download — save a file from a URL to Downloads** — chose the URL-based design over
  browser-element download (no controller interface change, no live Chrome, fully deterministic
  verification). New `web_download` tool: SSRF-guarded (loopback/internal refused via the shared
  assertPublicHttpUrl), 50MB size cap, basename-only filename (`safeDownloadName` — no path escape).
  The write-side companion to file_read; file_read then reads/summarizes what was saved. Wired
  default-on under --with-tools next to file_read. TDD 9 (safeDownloadName 3 + tool 6: well-formed,
  download+write, SSRF refuse, non-http refuse, size cap no-write, filename sanitize); eval:tools
  web scenario 6/6 STABLE 3/3 (web_download vs web_read vs search vs knowledge_search); LIVE — a real
  http server's file fetched and written to disk with matching bytes. mcp 1638, full eval:tools
  137/137, check 0, lint 0.
- ✓→Done **mac: read Calendar.app / Notes.app / Reminders.app** — all three shipped as SOURCES on
  the already-wired `mac_app_read` tool (`reminders` incomplete items+due, `calendar` today's events,
  `notes` recent titles) — not new tools, keeps the exposed set small (tool-calling.md). Each:
  reachable in the model-facing app enum (verifier confirmed), behavioral parse test (fake osascript
  runner), eval:tools golden cases (EN+KO). risk=read (snippets never mutate). The earlier INERT
  separate-tool attempt was rolled back; done the COMPLETE way (extend wired tool + eval). So
  "what's on my calendar today / what reminders do I have / what notes" works locally.

HARDEN (make existing tools more reliable):
- ✓→Done **regex_extract ReDoS guard** — the tool ran a model/untrusted-supplied regex with no
  backtracking protection; a nested-quantifier pattern like `(a+)+$` against just 50 chars hung the
  whole agent for ~90s (measured by the RED test). JS regex can't be timed out on the main thread,
  so added `hasNestedUnboundedQuantifier` (the safe-regex star-height heuristic, escape-aware proper
  paren matching) and reject the pattern BEFORE compile. Catches the common catastrophic class
  ((a+)+, (.*)*, ([a-z]+){2,}); overlapping-alternation ReDoS ((a|ab)+) is out of scope (still
  bounded by the 100k input cap) — documented honestly. TDD 5 (flags nested shapes, accepts ordinary
  patterns the model writes, escaped parens, tool rejects-not-hangs, normal extract still works);
  tools 242, byte-hygiene 30, check 0, lint 0.
- ✓→Done **muse.search snippet length cap** — result snippets were sanitized but not LENGTH-bounded, so a
  SearXNG/DDG engine returning a full paragraph × up to 10 rows blew the local 8B's context. Added a 280-char
  word-boundary cap (`capSnippet`) on both the DDG and SearXNG paths; titles/urls untouched. A search result is
  for TRIAGE (pick a URL to read), not the full text. TDD 1 (long snippet capped, short snippet + title intact);
  mcp 1629, byte-hygiene 30, check 0, lint 0.
- ✓→Done **web_read readability — strip nav/footer boilerplate** — extractReadableText dropped
  script/style/head but kept <nav> menus and <footer> (copyright/link farms), so a "summarize this
  URL" answer grounded on site chrome, not the article. Added nav|footer to the element-strip regex
  (HTML5 boilerplate by definition). TDD 1 (nav+footer dropped, article kept); live on a realistic
  article shape (nested footer>nav handled) — only the article body survives. mcp 1628, byte-hygiene
  30, check 0, lint 0.
- ✓→Done **browser_open scheme guard (no local-file read via file://)** — browser_open passed any
  URL straight to page.goto, so `file:///etc/passwd` (or chrome://, view-source:, javascript:, data:)
  would load+return arbitrary local files — a broader local read than file_read's allowlisted,
  symlink-guarded path, and a prompt-injection exfil vector. Now `normalizeBrowserUrl` accepts only
  http(s) (bare host → https; host:port preserved) and refuses every other scheme. TDD 4 cases;
  eval:browser-agent migrated to a loopback http server (was file://) and still 3/3; smoke unaffected
  (uses the controller directly). mcp/browser 37, check 0, lint 0.
- ✓→Done **command_injection pattern over-fired on legit loopback URLs** — dropped the bare `http`
  trigger so the pattern requires a command VERB (curl|wget|fetch) near an internal host. "open
  http://localhost:3000 in the browser" / "내 dev 서버 http://127.0.0.1:8080 열어줘" no longer trip the
  input guard (it was blocking the whole turn); curl/wget/fetch-toward-internal still fire. TDD 3
  false-positive + 3 true-positive cases; eval:browser-agent reverted off the [::1] workaround back
  to 127.0.0.1 and still 3/3 (proves the guard fix end-to-end); policy 129, byte-hygiene 30, check 0,
  lint 0, precheck:grounding pass^2.
- ✓→Done **file_read symlink-escape guard** — the absolute-path check was LEXICAL only: a file
  lexically inside the roots could be a symlink to /etc/passwd, and readFile followed it. Now
  realpath-verifies the target (and the roots — /tmp is itself a symlink on macOS) before reading;
  a link resolving outside the roots is refused, a realpath error refuses. Optional fsImpl.realpath
  (default node realpath; a fake fs with no symlinks is a no-op so existing tests are unchanged).
  TDD 3 cases (candidate-link escape, absolute-path-link escape, identity still reads) + eval:file-read
  REAL symlink round-trip (a link under Downloads → outside is refused, target content not returned);
  mcp 1627, check 0, lint 0.
- ⏳ **file_read .xlsx — BLOCKED on a dep decision (needs 진안)** — the maintained npm xlsx reader
  is exceljs (~21MB unpacked) and SheetJS `xlsx` on npm is the old CVE-flagged build. A 21MB dep or a
  fragile hand-rolled OOXML parser is too much to adopt autonomously; surface the choice. (.docx
  shipped via mammoth ~2MB, which was proportionate.)
- ◦ **per-tool not-when audit** — PROGRESS (loop fire): the `followup` tools (list/cancel/snooze)
  were the ONLY personal-tool family with ZERO not-when clauses → added "use when / NOT when"
  disambiguating them from tasks/reminders (followup = agent auto-captured thread, not a user item)
  + buildFollowupScenario in eval-tool-selection.mjs (6 positive + 4 disambiguation cases). Verifier
  confirmed the disambig cases are discriminating + wired. Other families (tasks/reminders/calendar)
  already have not-when. REMAINING: spot-audit any other tool families that lack it.
- ✓→Done **muse.status.notes_index promised "size" but never returned it** (EXPANSION gap-scout, fire 24;
  tool-contract output drift) — the tool description says "Returns relative path + size — no contents. Use this as a
  discovery surface before deciding to embed/search", but `execute` mapped each file to `{ name }` ONLY — `size` was
  silently absent, so the model couldn't use size (the embedding-cost signal the description sells) to decide what to
  embed. FIX: map to `{ name, size: await fileSize(pathJoin(dir, e.name)) }` reusing the pre-existing `fileSize` helper
  (returns `number | undefined`, swallows a TOCTOU-delete so one racing file can't blank the index); map became
  `Promise.all`. TDD 1 (2 .md files of 5 + 6 bytes → each entry's size === byte length) RED(size undefined)→GREEN; mcp
  1721, check 0 (all pkgs green), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; total/error-path untouched; no
  other test pinned the old `{name}`-only shape — the tool output was previously untested). Picked over the tasks.search
  total runner-up for KIND diversity (fire 22 was the episode total-post-slice, same KIND).
- ◦ **muse.tasks.search `total` is post-slice (capped at 50)** (EXPANSION gap-scout fire-24 runner-up; misleading-value,
  diversity-deferred) — `loopback-tasks.ts:406-411`: matches are `…sort().slice(0,50)` then `total: matches.length`, so
  `total` caps at 50 not the true match count — and unlike the SAME file's `list` tool (which reports pre-slice `total`
  + `shown`), search is internally inconsistent and has no `shown`. Distinct from the contested followups.total: here
  `list` vs `search` in ONE module disagree. Only test uses 2 tasks (total 1/0), so the cap is undocumented. FIX: pre-
  slice `total = filtered.length`, return the 50-cap slice + add `shown`. Slice: 1 file + 1 test (51 matching tasks →
  total 51, shown 50). NOT this fire (same KIND as the fire-22 episode total fix — pick a different KIND first).
- ✓→Done **bare day-of-month roll silently overflowed to a WRONG date** (EXPANSION gap-scout, fire 25;
  data-integrity / silent-wrong-value) — `resolveRelativeTimePhrase`'s `dayOfMonthMatch` branch
  (loopback-relative-time.ts:537-541) rolled a past/absent day forward with a SINGLE `new Date(y, month+1, dom)` and no
  re-validation, so a short +1 month overflowed: "the 31st" late on Jan 31 → `new Date(2026,1,31)` = Feb 31 → silently
  **March 3** (not March 31); "the 30th"→Mar 2, "the 29th"→Mar 1. The file's own comment promised "the next month that
  has it". That wrong date persisted into a reminder/task. FIX: bounded loop (ahead 1..12) advancing month-by-month,
  re-checking `getDate()===dom && getTime()>reference` each step, `return getDate()===dom ? finiteDate : undefined`. TDD
  3 (the 31st/30th/29th @ Jan, each → March same-day) RED(getDate 3≠31)→GREEN; relative-time file 44/44, mcp 1722, check
  0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; loop terminates, returns first future occurrence,
  final guard rejects nothing valid; no existing test documented the overflow).
- ✓→Done **relative-time SIBLING year-roll overflows** (fire 26; completes the fire-25 date-overflow class) — both
  +1-year roll sites skipped re-validation: (A) `resolveAbsoluteMonthDate` (loopback-relative-time.ts:230-236) and (B)
  the Korean `koAbsDate` roll (~750-758) — "feb 29" / "2월 29일" asked in a leap year AFTER it passed (ref 2028-06-01)
  rolled into the non-leap next year where `new Date(2029,1,29)` silently became **Mar 1, 2029** (a date the user never
  asked for, persisted into a reminder/task). FIX: re-check the rolled date's month/day and return undefined (fail-safe)
  instead of a wrong date — consistent with the file's reject-don't-roll philosophy for impossible dates. TDD 3 (en + ko
  feb-29 → undefined; mar-5 valid-roll → 2027 no-regression guard) RED(both gave 2029-03-01)→GREEN; relative-time 47/47,
  mcp 1725, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; both are the ONLY two +1-year
  roll sites; getMonth-only suffices for B since day≤31 pre-validated; 413 tests across 3 files green). NOTE: returns
  undefined rather than finding the next leap year (2032) — a fail-safe minimal fix; next-leap resolution is a separate
  enhancement if 진안 wants it.
- ✓→Done **muse.math#evaluate silently failed on a valid tab/newline expression** (EXPANSION gap-scout, fire 27;
  input-validation / whitelist↔tokenizer contract drift) — `SAFE_MATH_PATTERN = /^[\s\d+\-*/().,%]+$/u` (line 13) admits
  ALL whitespace, but the tokenizer's `skip()` only advanced over a literal space `" "`. So a contract-valid `"2 *\t3"`
  or a pasted multi-line `"1000\n+ 2000"` passed the whitelist, then the tab/newline stalled the cursor and the parser
  threw "expected number" / "trailing characters" — the math fast-path (also behind `muse ask`'s exact-arithmetic
  route) silently rejecting input its own contract accepts. FIX: `skip()` advances over any `\s` (`/\s/u.test(...)`),
  aligning the tokenizer with the whitelist. TDD 1 ("2 *\t3"→6, "1000\n+ 2000"→3000, "(1 +\n2)*3"→9) RED("expected
  number")→GREEN; mcp 1726, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; "1 2"/"1\t2"
  still error — no number concatenation; whitelist unchanged so no new chars reachable, no injection; 364 math/file
  tests green). KIND deliberately non-date after two date-overflow fires.
- ✓→Done **mac_say argv flag-injection** (EXPANSION gap-scout, fire 28; argument injection / fail-open option
  parsing) — `mac_say` built `argv = voice ? ["-v", voice, text] : [text]`, passing the user's `text` as the first
  positional with NO `--` option terminator. A text of "-0" / "--version" was reparsed by `say` as a flag (live: `say
  "-0"` → exit 1 "invalid option"), so a user asking Muse to speak a dash-leading string silently failed. FIX:
  `["-v", voice, "--", text]` / `["--", text]` — `say` supports `--` (independently live-verified by the Fable-5 judge:
  `say -- "-0"` → exit 0; mdfind/pbcopy do NOT, so the guard stays say-specific). TDD: leading-dash "-0"/"--version" →
  argv carries `--` before the text, spoke:true; the existing argv assertion updated (incidental characterization, no
  masked regression). macos 95/95, check 0 (all pkgs), lint 0. Fable-5 PASS (runner seam contract-faithful; voice not a
  vector — consumed as the `-v` value, no shell). KIND security (argv injection), fresh surface.
- ✓→Done **muse.notes.save TOCTOU clobber** (fire 29; data-integrity / TOCTOU) — save did stat-then-writeFile, so a
  concurrent create landing between the stat and `nodeWriteFile(..., "utf8")` (flag `w`) was silently CLOBBERED under
  overwrite:false. FIX: write create-exclusive under !overwrite (`{ encoding: "utf8", flag: "wx" }`) so a stale probe +
  concurrent create yields EEXIST → "already exists" error instead of a clobber; added an injectable `probeExists` option
  (defaults to the prior stat-based check, byte-identical) so the TOCTOU window is deterministically testable. TDD 2
  (injected absent-probe + real pre-existing file → "already exists" + content unchanged; overwrite:true still replaces)
  RED(reverting wx → file clobbered to "CLOBBER")→GREEN; mcp 1728, check 0 (all pkgs), lint 0. Fable-5 PASS
  (contract-faithful real-fs write, only the probe injected; EEXIST mapping scoped to !overwrite so EACCES still surfaces
  as "cannot write note"; atomic guarantee is in `wx`, not the probe). KIND TOCTOU, fresh surface.
- ◦ **mac_spotlight_search argv-injection (fire-28 rejected, recorded)** — `mac_spotlight_search` (macos-tools.ts:1439)
  has the SAME leading-dash argv-injection as mac_say (fixed fire 28), BUT `mdfind` rejects `--` (`mdfind -- q` →
  "Unknown option"), so there's no one-line terminator fix — needs query-rewriting/escaping logic (a real ◦, not
  trivial). KIND security (argv injection).
- ✓→Done **muse.fs read corrupted multi-byte UTF-8 at the truncation edge** (EXPANSION gap-scout, fire 30;
  encoding round-trip / byte-boundary) — `read` truncated with `buffer.subarray(0, maxBodyBytes).toString("utf8")`,
  cutting mid-character whenever the 64KB cap lands inside a multi-byte sequence. Korean is 3 bytes/char, so the cap
  lands mid-char ~2/3 of the time → the agent ingested a U+FFFD replacement char at the truncation tail of every large
  Korean note (the tool promises "Reads a UTF-8 text file"). FIX: new exported pure helper `utf8SafeSliceEnd(buffer,
  maxBytes)` backs the cut off to the previous UTF-8 char boundary (walks back over 10xxxxxx continuation bytes); read
  wires it in. TDD 6 helper unit (fits/Korean-mid/exact-boundary/4-byte-emoji/ASCII-unchanged/non-positive) + 1 e2e
  (fake-fs "가나다라" maxBodyBytes:8 → "가나", no U+FFFD) RED(reverting wiring → "가나�")→GREEN; mcp 1735, check 0
  (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed; helper fuzzed 2000+ cases vs an optimal-prefix oracle — never
  over-shoots the cap, never over-trims a fitting char, longest valid prefix; ASCII test stays green). KIND
  encoding-boundary, fresh surface — directly fixes garbled tails in 진안's Korean notes.
- ✓→Done **loopback-fetch readBodyWithCap U+FFFD at the truncation tail** (fire 31; encoding-boundary + the ~10-fire
  JUDGE FAILURE DRILL) — `readBodyWithCap` decoded the truncating chunk with a NON-streaming `decoder.decode(head)`,
  flushing a partial multi-byte sequence at the cap to U+FFFD (a Korean body got "가나�"). KEY: the correct fix is NOT
  `utf8SafeSliceEnd(head)` as this ◦ originally guessed — that helper treats `head` as a standalone buffer and misreads
  leading continuation bytes when an earlier full chunk left pending bytes in the STREAMING decoder. The right fix is
  `decoder.decode(head, { stream: true })` + never flushing on the truncated branch (the `if (!truncated)` guard already
  skips the flush), so the partial char straddling the cap is buffered and dropped. TDD 2 ("가나다라" cap 8 → "가나";
  "가나" cap 2 → "") RED("가나�")→GREEN; mcp 1737, check 0 (all pkgs), lint 0. JUDGE DRILL: an inert slice (comment-only
  code change + a declaration-only test asserting just truncated:true/length>0) was planted FIRST; the Fable-5 verifier
  correctly FAILED it (traced result.body="가나�", flagged the test as declaration-only, AND independently derived the
  stream-flag fix) → rolled back → real fix applied + PASS. Judge drill 3/3 (fire 10 json.query, fire 21 regex, fire 31
  fetch). Optional follow-up (verifier note): a multi-chunk-stream test would pin the cross-chunk decoder-state case
  (currently proven ad hoc, not by a committed test).
- ✓→Done **muse.url.encode_query encoded null/undefined ARRAY items as "null"/"undefined"** (EXPANSION gap-scout,
  fire 32; contract-output-drift / inconsistent null handling) — the array branch guard
  `if (item !== null && item !== undefined && !isScalar(item)) return error` let a null/undefined item FALL THROUGH to
  `search.append(key, String(item))`, so `{tags:["a",null,"b"]}` emitted a corrupt `tags=a&tags=null&tags=b`. The SCALAR
  branch one line below explicitly skips null/undefined (and a unit test pins that skip as the contract) — so the array
  branch was internally inconsistent. FIX: `if (item === null || item === undefined) continue;` before the object check,
  matching the scalar branch. TDD (`["a",null,undefined,"b"]` → `tags=a&tags=b`; nested-object-in-array still rejected;
  falsy-but-valid `[0,false,""]` → `v=0&v=false&v=` still encode — strict null/undefined skip only) RED(`tags=null...`)
  →GREEN; mcp 1738, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; nested object AND array
  still rejected; 0/false/"" still encode; no test pinned the old corrupt output). KIND contract-drift, fresh surface.
- ✓→Done **performConsentedAction let caller headers override the consent-gated credential** (EXPANSION gap-scout,
  fire 33; SECURITY — credential-override / fail-open on the outbound-safety seam) — the fetch headers were
  `{ authorization: \`Bearer ${credential}\`, ...(body?{content-type}), ...request.headers }` with the caller's
  `request.headers` spread LAST, so `request.headers.authorization: "Bearer attacker"` silently REPLACED the
  consent-gated token, and the case-variant `{ Authorization: ... }` produced two own keys that `new Headers()` merges
  into the corrupt `"Bearer svc-token, Bearer attacker"`. Violates outbound-safety.md's "Security is code, not a prompt"
  — the scoped credential is supposed to be the only Bearer that leaves. FIX: strip every caller header whose
  `.toLowerCase() === "authorization"` (`callerHeaders`) before spreading, so the code-owned token is unstrippable;
  non-auth headers (content-type, x-custom) still forward. TDD (lowercase + capitalized override attempts →
  `new Headers(init.headers).get("authorization") === "Bearer svc-token"`; x-custom still passes) RED("Bearer attacker")
  →GREEN; mcp 1739, check 0 (playbook-store flake re-run green), lint 0. Fable-5 PASS (RED re-confirmed by stashing src;
  all case variants covered; whitespace/Unicode keys are invalid header names → fail-closed via try/catch, not a bypass;
  consent/veto gates untouched). KIND security, fresh surface.
- ✓→Done **performConsentedAction: request.url destination-binding (credential-exfil guard)** (fire 34; SECURITY —
  fire-33 verifier finding) — `request.url` was fully caller-controlled with nothing tying it to the consent, so the
  scoped Bearer token could be sent to ANY url (`https://attacker.example/...`). DESIGN (verified: performConsentedAction
  + recordConsent have NO production callers — unwired P5-b3 primitive; trust-correct source = the consent RECORD set at
  grant time, NOT the caller's url, and NOT a non-existent service→host registry): `ScopedConsent` gained an OPTIONAL
  `allowedHost`; `performConsentedAction` refuses (fail-closed, no HTTP) when a consent's `allowedHost` is set and
  `new URL(request.url).host` differs OR the url is unparseable; added `findConsent` (returns the record; `hasConsent`
  delegates). TDD (consent bound to api.test + url to evil.example → refused, 0 HTTP; unparseable url → refused) RED
  (neutralize the check → token reaches evil.example)→GREEN; mcp 1741, check 0 (all pkgs), lint 0. Fable-5 PASS —
  including the userinfo bypass `https://api.test@evil.example/` → `host` resolves to `evil.example` → correctly
  refused; `host` (incl. port) is stricter than `hostname` (fail-closed-safe). KIND security, fresh surface.
- ◦ **performConsentedAction: make allowedHost MANDATORY / fail-closed-on-absence (fire-34 follow-up)** — the
  destination-binding is currently enforce-WHEN-PRESENT (optional), so a consent without `allowedHost` still sends the
  token to any url. Once the (future) grant flows that call `recordConsent` all populate `allowedHost`, flip it: make
  the field required (or treat absence as refuse) so the binding is fail-closed by construction, not opt-in. Slice =
  require allowedHost in `isScopedConsent` + refuse on absence in performConsentedAction + update the duplicate test
  corpus (consent literals live in BOTH src/*.test.ts and test/*.test.ts — ~10 sites). Gated on grant-flow wiring
  existing first (no production caller today).
- ✓→Done **muse.history.recent returned an EMPTY feed for a fractional limit < 1** (EXPANSION gap-scout, fire 35;
  boundary-condition / silent-failure) — `clampLimit` (loopback-history.ts:34) checked `raw <= 0` BEFORE truncating, so
  `limit: 0.5` passed the guard then `Math.trunc(0.5) === 0` → `Math.min(cap, 0) === 0` → the activity feed sliced to
  empty, so "what did I do last night?" with a model-emitted fractional limit silently answered "nothing happened"
  (`{entries: [], total: 0}`). 0 and negatives already correctly took the fallback (20). FIX: truncate BEFORE the
  positivity check so a sub-1 fractional joins 0/negatives in taking the fallback (self-consistent with history's own
  contract — NOT the proactive sibling's clamp-to-1, which has a different undefined→store-default contract). Exported
  `clampLimit` for direct unit testing. TDD 5 unit (0.5/0.999→20, 0/-5→20, 2.9→2, 1.5→1, 50→50, 500→200 cap,
  string/NaN/Inf→20) + 1 e2e (recent({limit:0.5}).total === recent({}).total, not 0) RED(0.5→empty)→GREEN; mcp 1747,
  check 0 (all pkgs), lint 0. Fable-5 PASS (RED reproduced "expected 0 to be 5"; exact 1.0→1 boundary verified; valid
  integer limits unchanged; export not in barrel — no collision). KIND boundary, fresh surface.
- ✓→Done **browser_read `find` pagination was a dead-end / loop trap** (EXPANSION gap-scout, fire 36;
  contract-output-drift) — the tool description promises "A long page reports total + hasMore/nextOffset; pass offset to
  read the next batch", and the no-find branch (snapshotToJson) honours it, but the FIND branch did
  `matched.slice(0, BROWSER_MAX_ELEMENTS)` (always from 0, ignoring the documented `offset` arg) and returned only
  `{ hasMore: true }` with NO `nextOffset`. So when >50 elements matched, the local 8B was told hasMore, followed the
  protocol (`find` + `offset`), and got the SAME first 50 back forever — a loop trap. FIX: align the find branch with
  snapshotToJson — clamp offset, slice `[start, start+MAX)`, emit `offset`/`hasMore`/`nextOffset`. TDD (60 matches:
  find→50 + nextOffset:50; find+offset:50→10, offset:50, ref continuity) RED(force start=0 → offset:50 returned the
  first 50 again)→GREEN; browser 58, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed; past-end clamps to
  empty, negative clamps to 0, contiguous pages no dupes/skips, filterElements order-stable; only consumer is the CLI
  tool registration — opaque JSON to the model). KIND contract-drift, fresh surface (browser). Minor pre-existing nit
  (out of scope): the find branch names the count `matched` while no-find uses `total`.
- ✓→Done **dismissPattern lost-update race (user veto could be silently dropped)** (EXPANSION gap-scout, fire 37;
  lost-update / concurrent RMW missing serialisation) — `dismissPattern` did an UNSERIALISED read→append→write on
  patterns-fired.json while its sibling `recordPatternFired` already wraps the identical RMW in `withFileMutationQueue`.
  Concurrent in-process dismissals/fires read the same snapshot → last write clobbers the rest → a lost dismissal means
  Muse keeps suggesting a pattern the user explicitly vetoed (learned-avoidance dropped — the trust failure proactivity
  exists to avoid); same-ms writes also crashed on the `tmp-${pid}-${Date.now()}` rename (ENOENT). FIX: wrap the body in
  the per-file queue (mirrors recordPatternFired); deleted a stale JSDoc that falsely claimed "the daemon is the only
  writer… we accept that [clobber] trade". TDD (Promise.all of 12 dismiss + 13 fire on one file → all 25 present, all 12
  dismissals survive) RED(revert queue → ENOENT/lost record)→GREEN; mcp 1748, check 0 (messaging pending-approval flake
  unrelated, isolated 17/17), lint 0. Fable-5 PASS (read inside critical section; no nested-queue deadlock; non-flaky).
- ◦ **patterns-fired (and sibling stores) lack CROSS-PROCESS write serialisation (fire-37 verifier finding)** —
  `withFileMutationQueue` serialises only WITHIN one process, but the motivating race is the CLI `muse pattern dismiss`
  vs the proactive daemon — TWO OS processes writing the SAME patterns-fired.json. Atomic rename prevents corruption but
  NOT a cross-process clobber (a dismissal landing between the daemon's read and write is still lost). This is
  pre-existing and shared by every store on the queue. FIX (if it ever bites): a file lock (lockfile / flock) around the
  RMW. Slice = a cross-process lock primitive + wire the patterns-fired RMWs + a two-process race test (spawn). Larger;
  gated on whether single-user concurrency is real enough to justify the complexity.
- ✓→Done **writeFollowupLlmBudget hand-rolled write (same-ms ENOENT crash + orphaned tmp)** (EXPANSION gap-scout,
  fire 38; resource-leak / race-induced crash) — `writeFollowupLlmBudget` hand-rolled `tmp-${pid}-${Date.now()}` then
  open/write/sync/rename with NO catch-cleanup, while the SAME package's `atomicWriteFile` already fixes exactly this
  class (randomUUID tmp + fsync + 0o600 + orphan cleanup) and the module already imports `withFileMutationQueue` from it.
  Two same-ms writers → identical tmp → the slower rename ENOENT-crashes; any write/rename failure orphans the tmp
  (UNCONDITIONALLY real, independent of concurrency). FIX: replace the body with `atomicWriteFile(file, payload)` (byte-
  identical payload, same fsync/0o600 durability). TDD (frozen Date.now → 2 concurrent writes both resolve + no `.tmp-`
  orphan) RED(ENOENT rename on `budget.json.tmp-<pid>-1700000000000`)→GREEN; mcp 1749, check 0 (all pkgs), lint 0.
  Fable-5 PASS (durability preserved; both defects closed; the one production caller composes inside its queue). The
  collision is defense-in-depth (writeFollowupLlmBudget is a public export) but the orphan defect was unconditionally
  real. KIND resource-leak, fresh surface.
- ◦ **appendReminderHistory hand-rolls the same tmp write (fire-38 runner-up)** — `personal-reminder-history-store.ts`
  (~line 64-68) hand-rolls `tmp-${pid}-${Date.now()}` with NO fsync and no leak cleanup. Same one-line `atomicWriteFile`
  adoption. Lower urgency: it sits inside the mutation queue so the in-process collision is unreachable and the fsync gap
  isn't behaviorally testable — but adopting the shared primitive removes the orphan-on-failure leak + the fsync gap.
  Slice: swap to atomicWriteFile + a no-orphan-on-injected-failure test (or accept it's covered by the primitive's tests).
- ◦ **cleanupFollowupTempFiles is dead-wired (fire-37/38 runner-up, NOT a crisp fix)** — `personal-followups-store.ts`
  `cleanupFollowupTempFiles` docstring claims "Called by readFollowups" but has ZERO production callers (only a test), so
  crash-orphaned followup tmp files accumulate forever. The naive wiring (call it from readFollowups) is NOT objectively
  correct — readFollowups runs unqueued from the list tool, so cleanup could unlink an in-flight atomicWriteFile tmp
  before its rename and kill a concurrent write; the safe fix needs an mtime age-gate whose threshold is a judgment call.
  Real leak but needs a design decision — record, don't auto-pick.
- ✓→Done **active objective with an unparseable nextEvalAt was silently frozen forever** (EXPANSION gap-scout, fire 39;
  silent-failure / NaN-poisoned date comparison) — the `due` filter was
  `o.status === "active" && (!o.nextEvalAt || Date.parse(o.nextEvalAt) <= nowMs)`; a non-ISO nextEvalAt makes
  `Date.parse` → NaN, `NaN <= nowMs` → false, and `!o.nextEvalAt` is false (truthy string), so the objective is EXCLUDED
  from `due` on EVERY tick forever — never evaluated, never escalated (contradicts the module's "never silently dropped"
  contract; the same file already guards this exact NaN-poison class for maxPerTick). Reachable via a hand-edited /
  foreign-written objectives.json (isStandingObjective never validates nextEvalAt). FIX: fail-open to evaluation when
  unparseable (`!Number.isFinite(nextMs) || nextMs <= nowMs`); the backoff path then rewrites a valid ISO (self-heal).
  TDD (nextEvalAt:"not-a-date" → evaluated once, retried, persisted nextEvalAt now parseable === nowMs+1000)
  RED(excluded → evaluated 0)→GREEN; mcp 1750, check 0 (all pkgs), lint 0. Fable-5 PASS (future-valid still excluded so
  cooldown intact; no legitimate non-ISO sentinel — "never" is status not a magic string; self-heals after one eval).
  KIND silent-failure, fresh surface.
- ◦ **append-only stores silently DESTROY a forward-version entry on the next write (fire-39 runner-up)** —
  `appendActionLog` (personal-action-log-store.ts:212-221) and `addObjective`/`patchObjective`
  (personal-objectives-store.ts:97-130) round-trip through a validation-FILTERING read (`readActionLog`/`readObjectives`
  flatMap-drop entries failing `isActionLogEntry`/`isStandingObjective`), so any stored entry a newer schema wrote (e.g.
  a forward `result` value or unknown field) is permanently ERASED by the next unrelated append — violating the
  documented "APPEND-ONLY… preserved verbatim / never silently destroyed (quarantine)" contract. FIX needs a RAW-read
  path for the write (read+append+write on the raw array, validate only on the READ-for-consumers path) — bigger than
  one filter line. Slice: add a raw passthrough reader + wire the append/patch RMWs + a forward-compat test (seed an
  entry with an extra field, append another, assert the first survives byte-identical). Two stores share the KIND+shape.
  BLOCKERS (fire-40 eval, NOT a clean single fix — needs a design decision): (a) the action-log is a HASH-CHAIN
  (`prevHash: chainTipHash(existing)`), so preserving an unvalidatable forward-version entry breaks the typed
  chain-hash computation — raw preservation + chain integrity conflict; (b) "corrupt entry (drop is correct)" vs
  "forward-version entry (preserve)" are INDISTINGUISHABLE to `isActionLogEntry`, so preserve-unknown also re-persists
  genuine garbage — a real preserve-vs-drop judgment, not a mechanical fix. The objectives store (no hash chain) is the
  cleaner first target IF the preserve-unknown policy is decided. 진안 input on the policy + chain handling.
- ✓→Done **muse.calendar.update silently dropped an unparseable startsAt/endsAt and reported success** (EXPANSION
  gap-scout, fire 40; missing-validation) — `resolvedStartsAt = startsAtRaw ? parseIsoDate(...) : undefined` returns
  undefined for an unresolvable phrase, then the spread `...(newStartsAt ? {startsAt} : {})` omitted the move and
  `update` called `registry.updateEvent` + returned `{event}` SUCCESS — so "move my dentist to flurbsday" reported done
  while nothing moved. The sibling `add` already errors on this exact condition; a parseable start + unparseable end
  also moved the start but left the end (end-before-start risk). FIX: error (mirroring `add`) when a raw startsAt/endsAt
  was PROVIDED but parses to undefined, BEFORE updateEvent (omitted args unaffected; valid phrases still parse). TDD
  (startsAt:"flurbsday" → error + updateEvent NOT called; valid-start + endsAt:"flurbsday" → error + no call — the
  τ-bench no-partial-side-effect property) RED(remove guards → updateEvent called, success)→GREEN; mcp 1752, check 0
  (all pkgs), lint 0. Fable-5 PASS (omitted untouched, newEndsAt fallback algebraically identical, no partial state).
  KIND missing-validation, fresh surface. (Side effect, per the slice's intent: an empty-string "" startsAt/endsAt now
  errors too, consistent with `add`.)
- ◦ **calendar.add silently coerces an unparseable endsAt to start+60min (fire-40 runner-up)** — `add`'s endsAt
  fallback (`(endsAtRaw && isTimeOnlyPhrase ? ... : parseIsoDate(endsAtRaw)) ?? new Date(startsAt+60min)`) means a
  PROVIDED-but-unparseable endsAt silently becomes a 1-hour default instead of erroring — the same family as the update
  fix. Lower urgency (endsAt is optional with a sensible default, vs update's success-while-noop), and erroring needs to
  preserve the omitted-endsAt→default path. Slice: error only when `endsAtRaw !== undefined && parse === undefined` +
  test. Also (fire-40 verifier nit): a non-string startsAt (numeric epoch) is silently ignored via readString→undefined
  on BOTH add and update — string-but-unparseable is fixed, wrong-TYPE is not; fold into the same slice if worth it.
- ✓→Done **appendReminderHistory persisted secrets to the plaintext audit log unscrubbed** (EXPANSION gap-scout,
  fire 41; SECRET-LEAK / data-integrity) — `appendReminderHistory` appended the raw `entry` to reminder-history.json
  while the SIBLING proactive-history store deliberately scrubs at the persist chokepoint
  (`redactSecretsInText(title/text/error)`). So a reminder "rotate key sk-proj-…" is DELIVERED scrubbed (the delivery
  path scrubs only the copy it SENDS) but ARCHIVED VERBATIM; `error` can also quote an upstream response body (e.g. a
  Telegram bot token). FIX: scrub `text` + `error` at the chokepoint (`{ ...entry, text: redactSecretsInText(text),
  ...(error ? { error: redactSecretsInText(error) } : {}) }`) — exact parity with the proactive sibling, so every caller
  inherits it. TDD (text with sk-proj key + error with telegram token → read-back has `[redacted-openai-key]` /
  `[redacted-telegram-bot-token]`, raw tokens absent) RED(raw entry → plaintext key persisted)→GREEN; mcp 1753, check 0
  (all pkgs), lint 0. Fable-5 PASS (text+error = full secret-bearing set; destination non-secret by the messaging
  contract; chokepoint inherited by both call sites). KIND secret-leak, fresh surface — directly on Muse's "it can't
  tell anyone" identity.
- ◦ **reminder daemon prints raw error strings to daemon.out.log (fire-41 verifier finding; secret-leak)** —
  `runDueReminders` returns raw `errors` strings (reminder-firing-loop.ts:~140 — the same upstream error that can quote
  a Telegram/Slack token), and the daemon prints them to stdout, which the macOS LaunchAgent persists to
  `daemon.out.log` (commands-daemon.ts:~486). Reminder TEXT is not echoed there (only error strings), but a
  token-quoting send failure archives the raw token in that log. FIX: apply `redactSecretsInText` at the daemon's
  error-print seam (and/or scrub the `errors` array in the summary). Slice: 1 wrap + 1 test (a secret-bearing error →
  the printed/returned string is redacted). Fresh surface (daemon stdout).
- ✓→Done **commitment check-ins lost-update / stale-snapshot write** (EXPANSION gap-scout, fire 42; data-integrity /
  lost-update) — `appendCheckins` did an UNQUEUED read→append→write, and `runDueCheckins` read `all` (snapshot), awaited
  multi-second network sends, then wrote `all.map(...)` (the STALE pre-send snapshot) — so a check-in appended (chat-turn
  hook) or cancelled DURING the send window was clobbered: a fresh check-in vanished, a CANCELLED nudge RESURRECTED and
  re-fired (trust failure — the user silenced it). Siblings (followups/objectives) use `withFileMutationQueue`; this
  store predates the pattern. FIX: wrap `appendCheckins` in the per-file queue; make the fired-status write re-read the
  FRESH store inside the queue and patch ONLY the fired ids, not the stale `all`. TDD (registry.send appends a check-in
  mid-send → it survives + the fired one is marked; 2 concurrent appendCheckins both persist) RED(stale write clobbers +
  ENOENT)→GREEN; mcp 1773, check 0 (all pkgs), lint 0. Fable-5 PASS (re-read inside queue, patch-by-id, cancel-not-
  resurrected by construction, no deadlock — send loop OUTSIDE the queue; scope honest: fixes IN-PROCESS races,
  cross-process CLI-cancel-vs-daemon is the existing file-lock ◦). KIND lost-update, fresh surface.
- ◦ **commitment-checkin keeps a bespoke writeFileAtomic (pid+Date.now tmp) (fire-42 verifier nit)** — the store's local
  `writeFileAtomic` (line ~226) still uses `${file}.tmp-${pid}-${Date.now()}` instead of the shared `atomicWriteFile`
  (randomUUID + orphan cleanup). The queue masks the in-process collision on the fixed paths, but the CLI's direct
  `writeCheckins` (cancel/snooze, unqueued + cross-process) can still hit the same-ms ENOENT + orphan. FIX: adopt
  `atomicWriteFile`. Joins the appendReminderHistory tmp-write ◦ (same one-line swap, resource-leak KIND).
- ✓→Done **proactive-notice firedKey separator-injection collision (a real notice silently suppressed)** (EXPANSION
  gap-scout, fire 43; dedup / key-collision) — `firedKey` built the dedup key as `${kind} ${id} ${startIso}` (space-join
  of free-form fields). `id` is a provider event / task id (untrusted, can contain spaces), so two DISTINCT
  {kind,id,startIso} tuples collide on one key (id="a b"+startIso="X" vs id="a"+startIso="b X" both → "calendar a b X");
  the dedup `seen.has(key) → continue` then SILENTLY SUPPRESSES a legitimate second proactive notice — violating the
  module's own "fires at most once per {kind,id,startIso} tuple" contract. FIX: `JSON.stringify([kind,id,startIso])`
  (unambiguous; JSON escapes field boundaries — injective). In-memory key (rebuilt each run from the entries sidecar),
  so NO persisted migration. TDD: unit (collision pair → distinct keys; same tuple → same key) + e2e (crafted colliding
  sidecar entry → runDueProactiveNotices fires the new event, summary.fired===1) RED(space-join → suppressed,
  fired=0)→GREEN; mcp 1776, check 0 (all pkgs), lint 0. Opus PASS (JSON injective incl. quote/bracket injection;
  entries-not-keys persisted so backward-compatible; reachable — calendar event ids are provider-reported/untrusted).
  KIND dedup, fresh surface. (Fable-5 was unavailable this fire; scout + judge ran on Opus 4.8 per the fallback.)
- ✓→Done **objective verdict parser leaked a NESTED outcome → FALSE autonomous `met`** (EXPANSION gap-scout, fire 44;
  parsing-bug / safety — false-positive completion) — `balancedJsonCandidates` (objective-evaluator.ts:79-110) pushed
  every balanced `{...}` span starting at every `{` WITHOUT advancing past a consumed span, so a NESTED object was
  re-extracted as its own candidate. `parseObjectiveVerdict` takes the LAST candidate with a recognized `outcome`, so
  `{"plan":{"outcome":"met"},"note":"not yet"}` leaked the inner `{"outcome":"met"}` → returned `met` — the one outcome
  the module promises "never a false met" (it's autonomous: `runDueObjectives` calls `act()` + flips status:done on a
  `met` verdict). FIX: after pushing a balanced span ending at `j`, set `i = j` so only TOP-LEVEL objects are verdict
  candidates; a nested-only outcome is ambiguous ⇒ the conservative `unmet`. TDD (nested-only met → unmet; nested-in-
  array → unmet; top-level unmet + nested met → unmet) RED(remove i=j → false met)→GREEN; mcp 1778, check 0 (all pkgs),
  lint 0. Opus PASS (separate top-level objects still both extracted; brace-in-string/escaped-quote unaffected; the
  evaluator SYSTEM_PROMPT demands a TOP-LEVEL `{outcome,reason}` so a nested-only reply is off-spec → unmet is correct,
  not a dropped legit verdict). KIND parsing-bug, fresh surface — directly on the fabrication=0 / autonomous-safety edge.
- ✓→Done **runDueFollowups fired an arbitrary file-order slice, starving the most-overdue followup** (EXPANSION
  gap-scout, fire 45; sort-ordering + the ~10-fire JUDGE FAILURE DRILL) — the due selection was
  `all.filter(scheduled && scheduledFor<=now).slice(0, max)` with NO sort, so when a backlog exceeds `maxPerTick` (a
  daemon catching up after downtime), the FILE-FIRST commitments fire and the genuinely most-overdue self-followup is
  deferred tick after tick. The sibling `compareFollowupsByScheduledFor` (soonest-first) existed but was never applied.
  FIX: `.sort(compareFollowupsByScheduledFor)` before `.slice(0, max)` (soonest-scheduledFor = most-overdue for past
  times). TDD (3 distinct-due followups, oldest written LAST, maxPerTick:1 → fired[0].id==="fu_oldest" + the other two
  stay scheduled) RED(no sort → fires file-first "fu_recent")→GREEN; mcp 1779, check 0 (all pkgs), lint 0. JUDGE DRILL:
  an inert slice (comment-only code + a test asserting just `delivered===1`) was planted FIRST; the Opus verifier
  correctly FAILED it (empirically probed fired[0].id==="fu_recent", flagged the test as count-only, derived the sort
  fix) → rolled back → real fix + PASS. Judge drill 4/4 (fire 10 json.query, 21 regex, 31 fetch, 45 followups). KIND
  sort-ordering, fresh surface. (Fable-5 unavailable; scout + both judge passes ran on Opus 4.8 per the fallback.)
- ✓→Done **runDueObjectives left backoffBaseMs/backoffMaxMs un-NaN-guarded → objective spins every tick** (EXPANSION
  gap-scout, fire 46; missing-validation / NaN-poison) — `maxPerTick`/`maxAttempts` are `Number.isFinite`-guarded (the
  file's own comment names this class) but `const base = options.backoffBaseMs ?? DEFAULT; const cap = options.backoffMaxMs
  ?? DEFAULT` used bare `??`, which does NOT catch NaN/Infinity. A non-finite backoff → `delay = Math.min(cap, NaN*…) =
  NaN` → `new Date(nowMs + NaN).toISOString()` throws RangeError → the sibling-protecting catch swallows it → the
  objective never gets a new nextEvalAt and re-evaluates EVERY tick forever (backoff defeated, the exact failure the
  comment claims to prevent). FIX: mirror the guard — `Number.isFinite(base) ? base : DEFAULT` for BOTH base and cap. TDD
  (backoffBaseMs:NaN → retried + valid nextEvalAt = nowMs+60_000, not errored; backoffMaxMs:NaN → also guarded) RED(bare
  ?? → RangeError, retried empty)→GREEN; mcp 1780, check 0 (all pkgs), lint 0. Opus PASS (NaN/Inf/undefined caught,
  finite incl 0 preserved, base+cap symmetric; verifier nit "cap not independently tested" addressed with a cap-NaN
  case). KIND missing-validation; same file + NaN-poison class as fire 39 (nextEvalAt) — completes the file's guard
  symmetry. (Fable-5 unavailable; scout + judge on Opus 4.8.)
- ◦ **tool-arg grounding coverage** — extend `groundedArgs` (the deterministic anti-fabrication
  boundary) to every actuator persisting model-named free-text; one behavioral drop test each.
  DONE: `tasks.add` (notes/tags), `tasks.update` (notes), `add_contact` (relationship), `calendar`
  (location/notes), `followup.cancel` (reason) — each Opus-verifier-traced to the runtime grounding.
  REMAINING: spot-audit other update/edit paths' optional free-text (reminders has none fabricable —
  text=user-stated, dueAt=time, recurrence=enum).
- ✓→Done **content-sniff over extension** — file_read now classifies by CONTENT
  (`sniffFileKind`/`resolveFileKind`): `%PDF` magic always wins (a mislabeled `.txt`-that-is-a-PDF
  routes to the extractor), an extensionless download with text bytes reads (extension-only refused
  it), a NUL/binary blob is still refused. Extension stays the fast path; the sniff is the
  correction. Also fixed classifyFileKind's no-dot bug (`split('.').pop()` returned the whole name).
  TDD 10 cases (sniff + resolve + 2 tool integration); eval:file-read gains the no-ext + mislabeled
  real-file round-trips; mcp 1616, check 0, lint 0.
- ✓→Done **web_action URL vetting (SSRF guard)** — the existing assertPublicHttpUrl guard protected
  muse.web.read (READ) but NOT web_action (state-changing SUBMIT — the higher-risk tool was the
  unguarded path). Wired it in BEFORE the approval gate/any HTTP. Split the guard into a sync half
  (assertPublicHttpUrlSync: protocol + literal loopback/private/link-local IP + blocked host — always
  on, no DNS) and the async DNS-rebinding layer (opt-in via deps.lookup), so literal SSRF
  (127.0.0.1, 169.254.169.254 metadata, file://) is always blocked and the happy path needs no
  resolver. TDD 4 SSRF cases + injected-private-resolver (DNS-rebinding); web_action selection
  unaffected (eval:tools actuator scenario), mcp 1620, check 0, lint 0, precheck:grounding pass^2.

## Open — 2026-06-10 full-feature audit (3 reviewers; VERIFIED findings → fix queue)

FIXED already: actuator non-TTY fail-close (d7112db9) · hybrid-MMR scale bug · write-run cache
replay (this commit). Remaining, severity order:

- ✓→Done **Ink chat output gate** — finalizeGatedChatAnswer (the ONE shared post-stream pipeline:
  gate→reverify→citation strips→receipt) now runs on the Ink surface AND chat-repl was refactored
  onto it so the surfaces cannot drift again; groundingFor returns matches; render test pins that
  a fabricated answer is gated before display AND before history commit. (CLI audit #1, HIGH)
- ✓→Done **calendar↔reminder lifecycle link on EVERY surface** — helpers moved to
  @muse/mcp (event-reminder-link.ts), wired into the MCP update/delete executors (results carry
  remindersShifted/remindersRemoved) AND the API DELETE route; CLI re-exports. BONUS: a fired
  reminder rescheduled into the future resets to pending (audit CLI #3) while a still-past shift
  never instant-re-fires. 5/5 incl. loopback integration + no-partial-side-effect. (both audits, HIGH)
- ✓→Done (reminders) **Reminders store unserialized RMW → serialized via mutateReminders** — the
  daemon firing loop read the reminders once then wrote its in-memory copy per delivery, CLOBBERING a
  reminder a chat `add` wrote after the tick started (the reported daemon-vs-chat lost write). Added
  `mutateReminders(file, fn)` = read→fn→write under the cross-process `withFileLock`; converted EVERY
  RMW site (add, snooze, fire, delete in loopback-reminders + the firing loop's per-delivery write,
  which now re-reads current and marks fired by id, merging with concurrent adds). TDD 3 (two
  concurrent adds both persist, mutate returns+persists, serial sequence keeps all); mcp 1651, check
  0, lint 0. FOLLOW-UP: the TASKS store has the same shape — apply mutateTasks next.
- ✓→Done (tasks) **Tasks store unserialized RMW → serialized via mutateTasks** — same fix as
  reminders: `mutateTasks(file, fn)` = read→fn→write under the cross-process `withFileLock`;
  converted EVERY RMW site (add/complete/update/delete in loopback-tasks). mutate-tasks.test.ts
  proves two concurrent adds both persist (lost-update gone). mcp build + 1654 tests green, lint 0.
  (stores audit #2, tasks half — completes the reminders FOLLOW-UP)
- ✓→Done **Calendar store + credential store: corrupt file → silent full wipe** — both
  `LocalCalendarProvider.readAll` and `FileCalendarCredentialStore.readAll` returned empty on
  JSON-parse-failure OR schema-mismatch, and the next atomic write then overwrote the corrupt-but-
  recoverable original — permanent data loss. Adopted the sibling reminders-store posture via a shared
  `corrupt-quarantine.ts` (`quarantineCorruptStore` = best-effort rename to `<file>.corrupt-<ts>`),
  called on all 4 corrupt branches; writes were already atomic (tmp→rename). TDD 3 (corrupt JSON +
  schema-mismatch quarantined with original bytes preserved; credential corrupt quarantined) RED 3/3 →
  GREEN; calendar 152, check 0, lint 0. Fable-5 verifier PASS (ENOENT/transient-IO not quarantined,
  predicate unchanged so strictly safer, rename preserves 0600, concurrency-safe). RESIDUAL (out of
  slice): local-provider's per-entry `isPersistedEvent` flatMap still silently drops INDIVIDUAL corrupt
  events from an otherwise-valid array — a partial-loss path (logs nothing); separate slice.
- ✓→Done **toolGrounded blanket bypass** — fixed; keys on non-empty toolGroundingSources, value checks
  always-on, single-source helper shared run()+stream. See the Done entry up top. (CLI audit #4)
- ✓→Done **Chat-only users never get the embedder migration** (CLI audit #5) —
  `refreshStaleNotesIndexForChat` gated re-embed on CONTENT staleness only and returned early when
  notes were unchanged, so a chat-only user (the desktop companion never runs `muse ask`, the only
  other reindex trigger) kept ranking v2-moe query vectors against a legacy v1 index forever
  (cross-model cosine noise above the 0.5 floor). FIX: read the index model BEFORE the staleness
  gate; re-embed on `modelStale || contentStale`, where `notesIndexNeedsModelMigration` =
  `resolveIndexModel(existing, requested) !== existing` (legacy→default migrates; custom/default/none
  unflagged so no every-turn loop). Made the fn exported + deps-injectable (isStale/reindex/
  readIndexModel) for an Ollama-free OUTCOME test. TDD 5 (1 helper unit + 4 DI behavioral: legacy-fresh
  reindexes to default, default/custom-fresh don't, content-stale still does) RED→GREEN; cli 2525,
  check 0, lint 0. Fable-5 verifier PASS. RESIDUAL (separate slice): if the embedder is DOWN during a
  model-mismatch rebuild, `reindexNotes` drops prior-entry carry-forward → saves an empty index until
  notes change / manual reindex (fail-close: zero hits → refusal, not fabrication; pre-existing path).
- ◦ **ask error paths skip the run-log trace** (failed runs are exactly the error-analysis fuel) +
  Ctrl-C still runs the verdict pipeline and logs success:true. try/finally + success:false entries.
  (CLI audit #6/#7)
- ◦ smaller: ~~correction-polarity regex unanchored ("NOT CONTRADICT"→contradict decay)~~ ✓DONE
  (2026-06-13 fire 17: core de-negation existed; HARDENED to cover contraction auxiliaries
  WON'T/CANNOT/WOULDN'T/SHOULDN'T/COULDN'T + 0-2 intervening words "NOT A CONTRADICTION"/"DOESN'T
  REALLY CONTRADICT"; conservative-by-design over-strip = fail toward no-decay; 99 agent-core green) ·
  ~~enforceAnswerCitations whitespace rewrite on clean answers~~ ✓DONE (fire 18: cleanup gated on stripped.length>0 — clean answers verbatim, code blocks preserved; 1732 green) ·
  ~~casual-prompt 말해줘 over-match suppresses source blocks~~ ✓DONE (fire 20: removed 말해줘 from isCasualPromptText social regex — "내 일정 말해줘" etc are recall imperatives, were wrongly classed casual → source footer suppressed; Fable-judge PASS, agent-core 1741 green) · ~~dedup memoizes write results~~ ✓DONE (fire 19: real bug was stale-READ-after-write — a memoized read went stale after an intervening write in-loop; fix = mutating record invalidates read entries, keeps write entries/anti-double-write; Fable-judge PASS, agent-core 1738 green) ·
  ~~groundToolArguments partial-array reported as dropped~~ ✓DONE (fire 21: partial-array clean now keeps survivors WITHOUT reporting the arg in `dropped` — dropped = fully-removed args only, per the contract; .args cleaning unchanged; Fable-judge PASS, agent-core 1746 green) · consented-action header override ·
  web_action URL vetting · encryption coverage (calendar credentials!). (audit LOW/MED tail)

## Open — refilled 2026-06-09 (gap-finding scout, clean autonomous slices)

## Open — frontier research pass 2026-06-10 (3 fresh tracks; full table → docs/strategy/frontier-research-2026-06.md)

KEY UNLOCK (first-hand verified): Ollama 0.30.6 native API exposes `logprobs`/`top_logprobs`
for gemma4 — token-level confidence is no longer blocked (`<|channel>` marker tokens must be
excluded when scoring).

- ✓→Done **F1 logprob instrumentation** (shipped, independent-evaluator PASS — see Done).
- ✓→measured **F2 BM25 promotion: NO DELTA** — bm25Scores + RRF already existed
  (knowledge-recall.ts, env `MUSE_RECALL_BM25`); A/B on the embedder-ab corpus AND a targeted
  exact-string identifier probe (ERR codes, license key, IP, model tag) both saturate 100%
  with bm25 on OR off — the default lexical-overlap arm already handles identifier tokens.
  Default stays off (no unverified win); revisit only if real-trace misses provide
  discriminating cases. Contextual chunk annotation (Anthropic slice 2) remains a candidate.
- ✓→Done **F3 KnowNo conformal tool selection (offline)** — `pnpm eval:conformal-tools`:
  MCQA top_logprobs + leave-one-out conformal at α=0.1 over the 14-case time family →
  coverage 13/14 (92.9% ≥ 90% target), wrong-but-confident 0, unnecessary clarifies 0
  (docs/benchmarks/RESULTS-conformal-tools.md). Runtime wiring (set>1 ⇒ clarify-directive)
  is the follow-up once a larger calibration set exists.
- ✓→Done **ACT-R base-level activation for recall ranking** — frequency×spacing activation over the
  access logs now drives promotion RANKING (not the single recency half-life). (T2-1)
  [DONE 2026-06-12, cognition loop fire 1–3 + 진안 review-gate decision: RANKING-ONLY; the
  gate-scale migration (ACT-R driving eligibility, needs log-scale threshold recalibration + A/B)
  was deliberately NOT pursued — ranking lift is captured, gate stays on the scale-safe plain score.]
  — [in progress 2026-06-12, cognition loop] fire 1: `actrActivation(accessAgesDays,{decay,minAgeDays})`
  = `ln(Σ tⱼ⁻ᵈ)` + 9-case battery SHIPPED in `@muse/memory` (recall-promotion.ts). fire 2: the DATA
  FOUNDATION — `personal-recall-hits-store.ts` now logs a bounded `recentAccessMs` per memory (cap 20,
  tolerant migration of old records, garbage-sanitizing read). fire 3: WIRED — `recallActivation` +
  opt-in `useActrRanking` on selectPromotable/selectForgettable ranks by ACT-R (frequency×spacing)
  while the eligibility GATE stays on the plain recency score (scale-safe); enabled at the `muse memory
  consolidate`/promote call sites. ⏳ REMAINING (review-gate decision): a measured A/B on whether ACT-R
  should also drive the eligibility GATE (needs threshold recalibration to the log scale) before
  graduating — ordering is live now, gate-migration is the open call. Then this item → Done.
- ✓→Done **ACE deterministic playbook delta-merge** — itemized deterministic deltas replace the
  LLM-rewrite first pass + an anti-collapse invariant test (+10.6% AppWorld for the pattern). (T1-1)
  [DONE 2026-06-12, cognition loop fire 4: `deltaMergePlaybookStrategies` (whitespace-dedup +
  token-coverage subsumption + non-transitive anti-collapse GUARD) was already implemented & wired
  ahead of the LLM merge; the MISSING piece — a DIRECT anti-collapse invariant battery — was added
  (7 cases incl. the non-vacuous property "if it returns a survivor, that survivor token-covers EVERY
  input", so a learned strategy is never silently dropped). Test-only; agent-core 1691 green.]
- ✓→Done **Multi-group/multivalid conformal UQ for abstention** — pooled abstention calibration
  over an EN-only corpus silently loses its coverage guarantee on the Korean subgroup (the exact
  failure of arXiv:2407.21057, Liu & Wu). [DONE 2026-06-13, cognition loop fire 29:
  `calibrateAbstentionByGroup` (per-`dominantScriptFamily` conformal tau, pooled fallback for thin
  groups) in conformal.ts + additive `groups`/`calibration`/`groupCoverageViolations` in
  `scoreGroundingEval` + per-group rows & ⚠ violation render in grounding-eval-runner; made LIVE by
  adding a Korean subgroup (12 answerable + 4 must-refuse + 12 grounded notes) to the production
  `GROUNDING_EVAL_CORPUS` — `muse doctor --grounding` now renders latin+hangul groups (judge v1 FAIL
  caught it inert on the EN-only corpus; v2 PASS proved live on real Ollama). Additive measurement
  only, verdict/threshold unchanged (fabrication-floor safe).]
- ◦ **Per-group abstention threshold at serve time** — `calibrateAbstentionByGroup` now MEASURES the
  per-script-family gap; the follow-up is to SERVE the per-group tau (route a Korean query through the
  hangul threshold, not pooled) once the per-group calibration set is large enough to trust. (next)
- ✓→Done **MemoryBank Ebbinghaus forgetting loop — close the inert fade seam** — fade was COMPUTED
  (`selectForgettable`) but applied nowhere (report-only across 3 surfaces, arXiv:2305.10250 Zhong et
  al. AAAI 2024). [DONE 2026-06-13, cognition loop fire 30: `muse memory consolidate` writes `plan.fade`
  keys to `~/.muse/memory-fade.json`; the default-ON `StoreBackedEpisodicRecallProvider.resolve` reads
  it and down-ranks faded sessions ×FADE_PENALTY=0.5 (post-minScore-gate, ranking-only, never deletes);
  re-recalled memories auto-reinstate via consolidate overwrite + lastHitMs reset. Judge PASS: session-key
  identity holds end-to-end, counterfactual robust, fail-open 3 layers, fabrication floor intact.]
- ✓ **MemoryBank fade importance term** — `selectForgettable` gains `importanceHitsFloor` (default 8): a memory with ≥ floor LIFETIME recall hits resists fading even when idle+decayed (frequency consolidation, MemoryBank arXiv:2305.10250). AND-conjoined (only more conservative), default reaches daemon+manual consolidate, non-destructive. — self-improvement fire 3
- ✓→Done **ReConcile consensus-gated council rounds** — `muse swarm council` ran a fixed round count
  blind to convergence (MAST step-repetition + termination-unawareness, arXiv:2309.13007 Chen/Saha/Bansal
  ACL 2024). [DONE 2026-06-13, cognition loop fire 31: `hasCouncilConsensus` (every member's mean pairwise
  Jaccard support ≥ DEFAULT_COUNCIL_AGREE_AT=0.16) added to the debate loop condition; `--rounds` default
  bumped 1→2 (required — the loop is dormant at 1) so an agreed panel stops at round 1 and only a contested
  panel spends the (previously dormant) debate round, bounded by the unchanged cap 3. Single gather-closure
  seam → the assembled-path test drives the real production loop. Judge PASS: both counterfactuals
  non-vacuous, refactor behavior-preserving, floor-safe (gate only shortens; dedupe/screen/id-gate/reverify
  unchanged).]
- ◦ **Council cross-lingual consensus (KO/EN agreeing panel)** — `hasCouncilConsensus` uses Jaccard token
  overlap, so a genuinely-agreeing KO+EN panel scores support ~0 → falsely "diverged" → wastes one bounded
  round (no floor violation; cap holds). Same CJK hazard family as fire-28's outlier screen. Needs an
  embedding-based cross-lingual similarity to fix both. (judge-flagged fire 31)
- ◦ **Stabilize mcp playbook-store weighted-eviction test flake** — `playbook-store.test.ts:309`
  (recordPlaybookStrategy weighted eviction, added fire 27) times out at the 5000ms per-test default under
  full-suite parallel load; passes 1696/1696 in isolation. Raise the per-test timeout or reduce its async
  file-write count. (judge-flagged fire 31; same family as the cli chat-grounding concurrency flake)
- ✓→Done **BKT weakness resolution — close the Whetstone loop** — the weakness ledger was append-only
  (nothing recorded a gap got FIXED), so `muse recap` nagged about already-remediated grounding gaps for
  30 days (arXiv:2105.00385 Bayesian Knowledge Tracing, pyBKT EDM'21). [DONE 2026-06-13, cognition loop
  fire 32: `WeaknessEntry.pKnown` BKT mastery estimate raised by the grounding gate's own SUCCESS verdicts
  (`muse ask` grounded non-action → `recordWeaknessResolved`); `selectRemediableWeaknesses` drops mastered
  (pKnown≥0.95) entries. One grounded answer does NOT clear a weakness (needs 3 — slip/guess noise, pass^k
  spirit). Judge PASS: writer default-ON, reader = the selector recap reads, BKT math recomputed exact,
  both counterfactuals non-vacuous, answer path byte-identical, legacy entries unaffected.]
- ◦ **Doctor weakness nudge uses a different selector** — `muse doctor`'s fuel/--weaknesses nudge calls
  `selectDevFixableWeaknesses` (DEV_FIXABLE_AXES excludes grounding-gap), so BKT mastery (fire 32) doesn't
  affect it, and doctor's raw `formatWeaknesses` inventory still lists mastered topics (honest dump, not a
  nag). If desired, apply `!isMasteredWeakness` to the doctor inventory view too. (judge-flagged fire 32)
- ◦ **Whetstone resolution — remaining axes & decay** — fire 32 closed grounding-gap resolution only.
  Remainder: dev-axis resolution (clear `unbacked-action`/`wrong-tool` when the tool later succeeds);
  chat-path resolution (needs chat's wrong-value check as the success signal — chat has no grounded label);
  BKT+Forget P(F)>0 mastery decay for long-idle topics (pairs with fire 30's fade); surface the stored
  `hint` in the recap nudge line. (fire 32 remainder, arXiv:2105.00385)
- ✓→Done **MemRL two-phase value-aware playbook retrieval** — `scoreStrategy` blended RAW unbounded
  token-overlap relevance with a bounded ±2.5 reward, so fire-27's Memp tallies vanished on verbose
  queries and leaked past relevance on sparse ones (arXiv:2601.03192 MemRL, Zhang et al. 2026). [DONE
  2026-06-13, cognition loop fire 33: two-phase `rankEligible` — Phase A relevance gates eligibility
  (relevanceOnly>minScore, k1=2·topK), Phase B z-score-normalized `0.5·rel̂+0.5·Q̂−reflected` re-ranks
  among candidates so utility can never lift an off-topic strategy into the prompt. scoreStrategy removed;
  both lexical + embed rankers rewired. Judge PASS via real revert: raw blend fails the verbose-include,
  sparse-exclude, and applyPlaybook-render tests. Selection-only, floor untouched.]
- ✓ **Playbook recency-floor score-scale mix** — FIXED fire 58 (this exact bug): fillers now scored
  minSelectedScore−rank, strictly below every Phase-B pick. (judge-flagged fire 33 → agent-core-cognition fire 58)
- ◦ **MemRL remainder** — (a) Q-update EMA `Q ← Q + α(r−Q)` as an alternative to net tallies in
  adjustPlaybookReward; (b) close the bandit loop with automatic per-turn reinforcement from turn outcome
  (today reward writes are manual CLI + correction-decay only — the real cold-start fix); (c) λ sensitivity
  A/B (eval:playbook-rank) before tuning off the paper's 0.5; (d) tuned δ for the cosine channel.
  (fire 33 remainder, arXiv:2601.03192)
- ✓→Done **Compaction-fidelity: salient detail retention** — conversation compaction dropped
  numbers/dates/decisions, duplicated the summary each round, and wiped a designed-but-dead StructuredFact
  field (arXiv:2511.17208 Zhou & Han, non-compressive detail retention). [DONE 2026-06-13, cognition loop
  fire 34: `salient-facts.ts` extracts VERBATIM NUMERIC/DECISION/ENTITY facts from user/assistant turns only
  (tool excluded), merges newest-wins into one `[Key details]` block in the compaction summary, and persists
  them instead of wiping. PROVABLY non-truncating: numeric = maximal-token-or-drop via a complete
  continuation-char set (digits∪separators∪scale-words∪Sino-Korean numerals, 4-way boundary guard); decision
  = fit-or-drop (no mid-sentence cut that would invert a Korean sentence-final negation). 5 adversarial judge
  FAIL rounds hardened the floor before PASS. Floor-strengthening (the chat number-value gate regains the
  true value post-compaction), additive, answer path byte-identical.]
- ◦ **Faithful KO numeric parser for salient facts** — fire 34's regex extractor DROPS (safely) what it
  can't parse faithfully: Latin-unit numbers (`42 people`), and KO multi-segment compounds (`3억 5천만원` =
  350,000,000, space-separated). A real Korean numeral parser (arabic + hangul numerals 영일이…, compound
  scales 천/만/억/조, spacing) would extract these whole. Until then they're omitted, not truncated.
  (fire 34 remainder, arXiv:2511.17208)
- ◦ **Compaction legacy-line dedup** — fire 34 deduped only the `[Key details]` block; the legacy
  "Tools kept / Recent user topics / [Pinned entities]" lines still accumulate one copy per compaction round
  in `buildCompactionSummaryText`. Strip-and-re-emit them the same way. (fire 34 remainder)
- ✓→Done **RAG-Fusion compound-query retrieval** — headline `muse ask` embedded the question once, so a
  compound question blended between topics and dropped one answer chunk at topK=3 (half-answer/false-refusal
  on a fully-covered corpus). [DONE 2026-06-13, cognition loop fire 35: `splitCompoundQuery` deterministically
  splits KO/EN coordinated questions into 2–3 clauses (each ≥2 content tokens, else []); `diversifyAskChunks`
  fuses each clause's cosine ranking into the existing RRF (arXiv:2402.03367 RAG-Fusion). Pure selection over
  the user's own chunks — per-chunk score stays full-query cosine so confidence is never inflated; fail-open;
  byte-identical when not compound. Judge PASS via real revert (non-vacuity test fails when fusion ignored).]
- ◦ **Fusion must-refuse verdict assertion** — `commands-ask-fusion.test.ts`'s must-refuse-compound case
  asserts only per-chunk score equality, not the `classifyRetrievalConfidence` verdict (the judge verified the
  verdict invariant manually; it's deterministic given unchanged scores). Add the explicit `verdict` assertion
  for defense-in-depth. (judge-flagged fire 35, low priority)
- ◦ **RAG-Fusion remainder** — (a) LLM-backed decomposition (full RQ-RAG, arXiv:2404.00610) for implicit
  compounds the deterministic splitter misses, gated like chat's `needsContextualRewrite`; (b) port the
  knowledge-recall second-hop PRF to the headline ask path for sequential bridge-entity questions; (c) extend
  the multi-hop A/B battery with compound-question joint@K cases to measure the live delta. (fire 35 remainder)
- ⏳ **Council hand-off injection quarantine — DEFERRED on detector calibration (fire 36)** — the
  MECHANISM is sound and was built + judge-confirmed (screenCouncilInfection at the council hand-off,
  fail-close all-infected→null, non-inert on the live `muse swarm council` path, cuts the Prompt-Infection
  self-replication channel before the round-2 debate digest / synthesis — arXiv:2410.07283 Lee & Tiwari
  2024). The BLOCKER is detector CALIBRATION: reusing `@muse/policy`'s `sharedInjectionPatterns` (tuned for
  hostile USER input) to screen fluent MODEL reasoning over-quarantines honest/dissenting peers — across 4
  adversarial judge rounds, FPs surfaced in `environment_extraction` (`env` in "envision"), `credential_extraction`
  (`token`+"give"), `prompt_override` (bare "from now on"), `sandbox_escape` ("without an approval check"),
  `cross_user_access` ("another" matches unanchored `other`), `training_data_extraction` ("print internal
  context"), and `role_override`'s debug-mode subpattern ("enable debug mode for this test"). Over-quarantine =
  silently dropping an honest peer = unacceptable (corrupts deliberation, subtle censorship). Whack-a-mole on
  subpatterns did not converge (each round found a new FP). PATH FORWARD (dedicated slice): build a council-LOCAL,
  prose-safe pattern set anchored to literal-attack token SEQUENCES (not single common words), empirically
  calibrated against a LARGE corpus of (legitimate model reasoning, genuine injection) pairs; the survived-all-4-rounds
  clean families are a starting core (korean_role_override, korean_prompt_extraction, multilingual_prompt_leak,
  punctuation_obfuscation, tool_spoofing, few_shot_poisoning, history_poisoning, command_injection, plus role_override
  MINUS its debug-mode subpattern, system_delimiter for literal control tokens). Reuse the screenCouncilInfection
  mechanism design (it passed). (fire 36 deferred — mechanism done, calibration is the work.)
- ✓→Done **ISR-LLM pre-execution plan validation + repair** — the runtime plan gate validated only
  step-count + tool-registered, not arguments, so a plan with a later missing-arg step executed earlier
  (possibly writing) steps first → partial side effects + dead run (arXiv:2308.13724 ISR-LLM). [DONE
  2026-06-13, cognition loop fire 37: `validatePlan` gains `toolSchemas` and flags missing-required-args
  (reusing validateRequiredToolArguments/coerceToolArguments at plan time) + exact-duplicate steps;
  `dedupeExactSteps`; `streamPlanExecute` dedupes → validates → one verifier-backed repair round
  (PLAN_REPAIR_MAX_ROUNDS=1, re-call generatePlan with the validator errors, re-validate) → else throws.
  Judge PASS via real revert (no-partial-side-effects test fails 6 ways without the arg-check); registered
  in reflection-guard. Validation runs before any tool executes; back-compat preserved.]
- ◦ **Plan-validation remainder** — (a) `plan-repaired` PlanExecuteStreamEvent so eval:plan-quality/traces
  can count runtime repair rate (deferred — strict event union needs downstream changes); (d) plan-cache
  hygiene — cache the REPAIRED plan, never the invalid original.
  (fire 37 remainder, arXiv:2308.13724) — NEW sub-items from fire 8: (e) tighten the still-open false-negative
  classes (bare `$N` and bare `{{N}}` dropped as currency/template-ambiguous → undetected); (f) wire backward-ref
  SUBSTITUTION (LLMCompiler Task Fetching Unit — resolve `{{step1.output}}` to the prior step's output, not just validate);
  (g) extend write-precondition to non-string args (empty array / `{}` on a write — fire 21 covered string args).
- ✓ Plan-validation remainder (b) ordering/dependency validation — agent-core-cognition fire 8
- ✓ Plan-validation remainder (c) write-step precondition checks (ISR-LLM arXiv:2308.13724) — a write/execute step with an unfilled-placeholder arg is rejected before any tool runs (no partial side-effect) — agent-core-cognition fire 21
- ✓ Playbook staleness re-probation gate (SSGM arXiv:2603.11768) — a once-reinforced strategy gone cold (>120d, sparse) is withheld from injection until re-reinforced — agent-core-cognition fire 22
- ✓ Correction-distillation gist gate (SIB arXiv:2603.01455 + ReasoningBank 2509.25140) — a near-verbatim restatement of the correction (cosine ≥0.92) is dropped before playbook promotion, completing the support gate into a [0.50,0.92) grounded-AND-abstracted band — agent-core-cognition fire 23
- ✓ Episodic near-duplicate consolidation-merge (Mem0 arXiv:2504.19413) — a near-identical lower-ranked episode (cosine ≥0.92) is collapsed before the CAR cutoff so a distinct episode advances into the freed recall slot — agent-core-cognition fire 24
- ✓ Council cross-peer echo collapse (Talk-Isn't-Cheap arXiv:2509.05396 + MAST 2503.13657) — distinct peers emitting identical reasoning are collapsed (after the outlier screen, before synthesis) so a Sybil/echo can't double-weight a voice or inflate the consensus label — agent-core-cognition fire 25
- ✓ Playbook pessimistic Wilson-LCB ranking (PEVI arXiv:2012.15085) — strategies rank by the lower confidence bound (point − uncertainty), so a proven strategy outranks a lucky-but-thin one; avoidance gate structurally isolated (keys on clampReward, not the LCB) — agent-core-cognition fire 26
- ✓ Plan-cache retrieval-exemplar toolset-fit gate (RAP arXiv:2402.03610) — a cached plan referencing a tool not registered in the current turn is withheld as a cache miss, so a stale exemplar can't seed an unbuildable plan that fails validation and burns the repair round — agent-core-cognition fire 27
- ✓ Correction seed-informativeness gate (NEMORI arXiv:2508.03341) — a contentless correction (all-marker-no-directive: "no", "별로야", "redo") no longer seeds a confident grounded playbook strategy (short-circuits before the model call) — agent-core-cognition fire 28
- ◦ **Correction-informativeness remainder** — (a) tune DIRECTIVE_RESIDUAL_FLOOR (2) on a real correction corpus (a single-content-token directive like "no, table" is currently dropped — subtractive + re-correctable so safe, but a tuning param); (b) semantic informativeness signal (embed correction vs marker-only baseline) if token-residual proves too coarse; (c) parity gate on the detectApprovals/inferPreferenceFromCorrection twin. (fire 28 remainder, arXiv:2508.03341)
- ◦ **Plan-exemplar fit remainder** — (a) extend the fit-check to step ARGS (a passing exemplar can still reference a stale entity id / miss a required arg under the current schema — surfaces at validatePlan's arg-check, not this gate); (b) emit a plan-exemplar-rejected stream event for eval:plan-quality telemetry (deferred — strict event-union change); (c) live A/B: does toolset-fit filtering raise one-shot plan validity on the plan-quality battery. (fire 27 remainder, arXiv:2402.03610)
- ◦ **Playbook LCB-ranking remainder** — (a) tune PLAYBOOK_PEVI_LAMBDA / Wilson z (1.96 default) on a real reinforcement corpus via eval:playbook-rank A/B (pessimism strength is a principled default, not empirically fit); (b) `effectiveStrategyReward` is now dead production code (only the test point-estimate oracle / revert-target uses it) — remove or mark test-only; (c) carry the LCB into the @muse/recall non-embed selectPlaybookSection path (concurrent-owned, defer). (fire 26 remainder, arXiv:2012.15085)
- ◦ **Council echo-collapse remainder** — (a) ✗ WONTFIX/INERT (agent-core-cognition fire 55): wiring collapseEchoUtterances into the `hasCouncilConsensusSemantic` early-exit gate is INERT — that gate is EVERY-member (`supports.every(s => s >= agreeAt)`), so a single dissenter already blocks agreement and collapsing IDENTICAL echoes can never raise a member above the floor or flip the agreed/diverged verdict (verified: an echo-panel test passed both with and without the collapse). The 1524(a) premise (a duplicated panel inflates consensus → premature stop) assumed a MEDIAN/majority gate; under the every-member gate it cannot. Do NOT re-attempt (a). (b) near-duplicate semantic echo collapse still open but needs the deferred live KO/EN battery. (fire 25 remainder, arXiv:2509.05396)
- ◦ **Episodic consolidation remainder** — (a) tune EPISODIC_CONSOLIDATION_THRESHOLD (0.92, Mem0 constant) on real nomic-embed distributions; (b) text-concatenation merge (carry the lower-ranked dup's complementary detail into the kept slot — Mem0's full UPDATE, LLM-free string merge — vs the current slot-freeing-only collapse); (c) a robust assembled-path discriminator that isolates consolidation from lateral-inhibition (currently geometrically fragile: CAR's cliff floor proj×0.5 and a dup's inhibited score proj−0.5·cos are close at cos≈0.92-1.0; the isolated binding is carried by the pure-helper counterfactual). (fire 24 remainder, arXiv:2504.19413)
- ◦ **Distillation gist-gate remainder** — tune DEFAULT_STRATEGY_VERBATIM_CEILING (0.92) on real nomic-embed distributions (chosen from synthetic fixtures; a short correction's valid concise generalization could score ≥0.92 and be dropped — subtractive + re-distillable so safe-direction, but untuned); calibrate against eval:self-improving / verify-pattern-suggestion. (fire 23 remainder, arXiv:2603.01455)
- ◦ **Playbook staleness-gate remainder** — tune PLAYBOOK_STALE_AFTER_DAYS (120) + the tally<3 sparsity bar on real reinforcement-interval data (chosen from SSGM framing + synthetic fixtures; a rarely-triggered useful/seasonal strategy could be withheld until re-reinforced — reversible + re-distillable so safe-direction, but untuned). Optionally a `muse doctor` "N strategies withheld as stale" surface. (fire 22 remainder, arXiv:2603.11768)
- ✓ Playbook temporal reward discounting (Discounted-UCB arXiv:0805.3415) — agent-core-cognition fire 9
- ◦ **Playbook recency-discount remainder** — (a) carry recency anchors into the `@muse/recall` non-embed
  `selectPlaybookSection` path too (this slice scoped to the agent-runtime applyPlaybook path); (b) tune
  PLAYBOOK_RECENCY_HALF_LIFE_DAYS (30) via A/B vs the daemon's 30-day decay step. (fire 9 remainder, arXiv:0805.3415)
- ✓ Playbook recency-discount remainder (c) wire nowMs into the cli embed-rank path (+extract testable module) — agent-core-cognition fire 10
- ✓ JUDGE-DRILL (firesSinceDrill≥10): injected inert reinforcementVelocity → independent Opus judge correctly FAILed it → rolled back — agent-core-cognition fire 10
- ✓ a2a council per-peer straggler timeout (MAST arXiv:2503.13657 termination) — hung peer no longer blocks the whole council — agent-core-cognition fire 11
- ✓ Commitment semantic near-duplicate collapse (SemDeDup arXiv:2303.09540) — daemon no longer schedules duplicate check-ins for one loop — agent-core-cognition fire 12
- ✓ Set-level semantic sufficiency advisory (Sufficient Context arXiv:2411.06037) — multi-part ask names the uncovered part instead of fabricating it — agent-core-cognition fire 13
- ✓ Outcome-conditioned plan-cache storage (Agent Workflow Memory arXiv:2409.07429) — cache records only succeeded steps, never teaches the model a failed tool sequence — agent-core-cognition fire 14
- ◦ **Plan-cache exemplar-quality remainder** — (a) live A/B: does success-filtering raise one-shot plan validity? (plan-quality battery, needs a live eval); (b) annotate per-step success in renderPlanExemplar for a richer exemplar signal. (fire 14 remainder, arXiv:2409.07429)
- ◦ **Context-sufficiency remainder** — (a) tune coverAt (0.55=DEFAULT_CONFIDENT_AT) on a REAL nomic multi-part corpus (tests use synthetic orthogonal vectors; real-world discriminating power unproven); (b) feed coveredFraction into classifyRetrievalConfidence as a set-level demotion (confident→ambiguous when insufficient) — a GATING change, needs its own floor proof; (c) wire the advisory into the `muse chat` grounding path (chat-grounding.ts), currently ask-only. (fire 13 remainder, arXiv:2411.06037)
- ◦ **Commitment dedup remainder** — (a) tune COMMITMENT_DEDUP_COSINE (0.86) on a REAL nomic-embed-text-v2-moe corpus (current tests use synthetic stub vectors; the threshold's discriminating power is unproven on real embeddings — A/B like eval:embedder-ab); (b) wire collapseNearDuplicateCommitments into the chat-ink.ts recap-count path (currently over-counts open loops) and the `muse commitments scan` list; (c) staleness/expiry pass for old commitments + cross-session dedup vs already-tracked tasks. (fire 12 remainder, arXiv:2303.09540)
- ◦ **a2a council timeout remainder** — (a) wire an env override `MUSE_A2A_COUNCIL_TIMEOUT_MS` (needs A2AEnv widened in transport.ts) + thread `timeoutMs` through the commands-swarm requestReasoning closure; (fire 11 remainder)
- ✓ Council consensus-weighted contributor ordering (Roundtable Policy arXiv:2509.16839) — highest-consensus reasoning leads the synthesis prompt — agent-core-cognition fire 15
- ✓ Plan-step normalized near-duplicate collapse (Mem0 arXiv:2504.19413) — case/whitespace/numeric-format duplicate steps no longer waste budget or double-act a write — agent-core-cognition fire 16
- ✓ Playbook small-bank injection-time near-duplicate suppression (arXiv:2510.17940 + MMR 2502.09017) — same-lesson paraphrases no longer both injected on the common ≤topK path — agent-core-cognition fire 17
- ✓ Episodic-recall adaptive cluster-transition cutoff (CAR arXiv:2511.14769) — episodic recall cuts a low-relevance tail at a sharp cliff instead of always padding to topK — agent-core-cognition fire 18
- ✓ Council weak-consensus advisory (ConfMAD arXiv:2509.14034, guardrail 2511.07784) — surfaces "the council barely agreed" instead of emitting a low-consensus synthesis silently — agent-core-cognition fire 19
- ✓ Council consensus-floor correct-by-construction + fire-19 caveat (a) MOOT — agent-core-cognition fire 20 [councilMemberSupportsSemantic never throws (per-member catch → support 0) → the fallback catch is unreachable and the cosine floor was already always correct on the embed path; refactored to tie supportFloor to the realised support computation anyway]
- ✓ JUDGE-DRILL (firesSinceDrill≥10): injected a floor-weakening plant (weak-consensus → suppress the answer, violating advisory-only / consensus≠truth) → independent Opus judge correctly FAILed it → rolled back — agent-core-cognition fire 20
- ◦ **Council consensus-advisory remainder** — tune the two floors (0.5 cosine / 0.16 Jaccard, reused from ReConcile) on a real council support distribution (needs a live KO/EN council battery; smoke:live stalls). (fire 19 remainder (b), arXiv:2509.14034)
- ◦ **Episodic adaptive-cutoff remainder** — (a) tune EPISODIC_CLUSTER_DROP_RATIO (0.5, conservative ≥50%-cliff-only — 33% drops survive) on a real episode corpus; (b) measure the live recall benefit against real nomic embeddings (the assembled test isolates the cutoff with hand-built orthogonal vectors; real-embedder behavior unmeasured); (c) CAR's full clustering variant (k-means/silhouette over the score vector) vs this single-transition approximation. (fire 18 remainder, arXiv:2511.14769)
- ◦ **Playbook injection-dedup remainder** — (a) tune PLAYBOOK_INJECT_DEDUP_THRESHOLD (0.8) on a real strategy corpus (chosen from token math, not empirical); (b) semantic-embedding dedup to catch cross-lingual / heavily-reworded paraphrases the Jaccard signal misses (async/latency tradeoff vs the sync per-turn path); (c) the sibling recency-floor score-scale-mix ordering fix (backlog "Playbook recency-floor score-scale mix"). (fire 17 remainder, arXiv:2510.17940)
- ◦ **Plan near-dup collapse remainder** — (a) if a case-SENSITIVE-identifier write tool is ever added to plan-execute (e.g. write_file{path}), drop case-folding for that field (trim+numeric only) — today's write tools are all NL content so case-folding is safe; (b) the genuinely-semantic case (different words, same intent) → embedding cosine, a separate higher-floor-risk slice; (c) feed the near-dup collapse count into a plan-deduped stream event for eval:plan-quality. (fire 16 remainder, arXiv:2504.19413)
- ◦ **Council ordering remainder** — (a) live eval: does consensus-ordering improve gemma4's synthesis quality? (ordering is wired + order-only; the 8B quality delta is the paper's hypothesis, unmeasured here); (b) surface per-utterance support as a `[peerId|conf=0.82]` prompt annotation (richer signal, risk-bearing); (c) council-level "weak consensus" advisory when top support < floor. (fire 15 remainder, arXiv:2509.16839)
- ✓→Done **Self-consistency consensus for the grounding reverify judge** — the live default-on
  `verifyGroundingWithReverify` decided weak→grounded upgrades on a SINGLE high-variance judge sample
  (arXiv:2510.27106 Rating Roulette: LLM judges "almost arbitrary in the worst case"). [DONE 2026-06-13,
  cognition loop fire 38: `judgeConsensus` (unanimous fail-close, length>0 && every-YES) + `reverifySamples`
  (clamp 1–5, default 1) k-sample the judge in all 3 branches; CLI live sites pass k=3 (arXiv:2203.11171
  Self-Consistency). Strictly more conservative — can only convert a single-sample PASS→FAIL on disagreement,
  never admit a new grounded verdict (judge PASS, proven across all 3 branches via real revert). Fabrication=0
  strengthened; default-1 byte-identical back-compat.]
- ◦ **Reverify consensus remainder** — (a) CI-SC confidence-weighted early-exit consensus (arXiv:2511.12309)
  to cut samples once the outcome is decided; (b) extend k-sample consensus to the `--verify-claims` per-claim
  judge (`verifyGroundingPerClaim`, same single-sample shape); (c) adaptive k by band width (wider weak margin
  ⇒ more samples). (fire 38 remainder, arXiv:2510.27106 / 2203.11171)
- ⏳ **Council question-relevance gate — DEFERRED on lexical-signal unfitness (fire 39)** — the MECHANISM
  is sound (screenOffTopicUtterances inside synthesizeCouncilAnswer, deny-only, majority-cap, fail-open,
  cross-script guard, non-inert + judge-confirmed live on the synthesis prompt path; MAST FM-2.3/FM-3.2,
  arXiv:2503.13657). The BLOCKER is the SIGNAL: a lexical question↔reasoning token-overlap false-drops honest
  SAME-SCRIPT paraphrase/synonym peers (judge: 5/5 realistic on-topic KO+EN peers dropped; the damning case —
  a correct paraphrase "임대료 125만원" dropped while a literal-echo peer with the WRONG number "월세 130만원"
  kept, because it mimicked surface tokens). Korean agglutinative tokenization makes synonyms share 0 tokens by
  construction. Dropping an honest/dissenting voice is a real harm even though downstream gates protect
  fabrication=0. The cross-SCRIPT case is already guarded (dominantScriptFamily) but same-script paraphrase is not.
- ✓→PARTIAL **ROOT-CAUSE semantic-similarity primitive for the council path** — [DONE peer↔peer half,
  2026-06-13 cognition loop fire 40: `councilMemberSupportsSemantic` (mean pairwise embedding cosine) replaces
  Jaccard token-overlap in `screenCouncilOutliers` when an embedder is injected (arXiv:2507.14649 Cleanse);
  embedder wired into the live `muse swarm council` synthesis path; COSINE_ABS_FLOOR=0.4; fail-open to Jaccard.
  This UNBLOCKS the two deferred council screens — the embed seam + cosine-support primitive now exist on the path.]
  REMAINING follow-ons (now thin, reuse the primitive):
  - ✓→Done **fire-39 question-relevance gate, semantic version** — [DONE 2026-06-13 cognition loop fire 41:
    `screenOffTopicUtterancesSemantic` (cosine question↔reasoning < QUESTION_RELEVANCE_FLOOR=0.3) in
    synthesizeCouncilAnswer; semantic cosine keeps KO-paraphrase + cross-lingual on-topic peers (fixes the
    fire-39 lexical false-drop), drops genuine off-topic; deny-only, fail-open, no lexical fallback. Judge PASS
    via real revert. Backlog: tune floor on live KO/EN battery; strengthen the CLI assembled-path test (vacuous
    on revert — masked by downstream consensus-outlier; the agent-core reason==='off-topic' test is the clean proof).]
  - ◦ **fire-36 injection-quarantine, re-scoped** — semantic-divergence signal or a council-local prose-safe detector
    instead of the chat-guard lexical patterns.
  - ◦ **semantic hasCouncilConsensus (fire 31)** — fire 40 left consensus on Jaccard; give it cosine support too (cosine-calibrated agreeAt).
  - ✓ **discriminating cross-lingual fix test** — DONE fire 59: a 5-peer mixed EN/KO panel (3 EN + legit KO + deceptive KO) with a multilingual-embedder stub proves screenCouncilOutliers' semantic precomputedSupports KEEP the legit ko-peer that lexical Jaccard excludes, while still quarantining the deceptive one; revert-proof reds exactly this test. — agent-core-cognition fire 59
  - ◦ **tune COSINE_ABS_FLOOR on a live KO/EN council battery** — 0.4 is a best-guess default (smoke:live stalls; unvalidated on real nomic distributions). (fire 40)
- ◦ **Reflection-schedule guard** — one test enumerating retry/reflection call-sites, asserting
  each is verifier-backed (85.36% same-mistake repetition without one, arXiv 2510.18254). (T1-10)
- (queued behind fuel/prereqs: sleep-time compute · Mem0 UPDATE op · AWM workflow mining ·
  conformal factuality back-off · Bayesian-surprise digest ranking (SDT half SHIPPED — see Done))
- ✗ blocked, recorded: SEPs / DoLa / contrastive decoding (need hidden states / decode-time
  intervention; Ollama logprobs are observational only).

## Open — agent-performance levers (ranked research pass 2026-06-10)

Full ranked list + sources: [`docs/strategy/agent-performance-levers.md`](../strategy/agent-performance-levers.md).
Levers #1 (multilingual embedder, SHIPPED — KO hit@1 50%→100%), #3 (KV posture + prefix
ordering, SHIPPED) and #2's mechanism+measurement are in Done below. Next from the list:

- ◦ **Tool-exemplar production wiring — gated on real-trace failures** — the mechanism
  (`selectToolExemplars`/`renderToolExemplarSection`) + the eval:tools A/B arm shipped; the
  golden set is near-saturated, so the lift must be demonstrated on REAL failing prompts.
  When labeled traces accumulate misses, extract an exemplar bank from successful traces and
  wire injection into the runtime tool path; promote on a measured eval:tools + replay win.
- ◦ **Local reranker on recall top-8** (lever #4) — Ollama has no rerank API; yes/no-logit
  workaround, flag-gated, A/B on the embedder-ab corpus + grounding battery.
- ◦ **`format` constraint on the non-reverify judge paths** — reverify judge DONE (see Done);
  remaining: llmJudge (eval-harness), correction-polarity, preference-inference.
- ◦ **source-trust live battery** — the marker + trusted bit shipped (see Done); remaining: a
  live `--with-tools` battery asserting the external-provenance heading appears on a
  web-grounded answer and NOT on a notes-grounded one.
- ✗ rejected this refill: "expose `muse notes graph/links`" (ALREADY exist — the -rag split
  trap again); "desktop lazy index load" (FALSIFIED — no startup parse); "REPL query-embedding
  cache" (near-zero hit rate; the real latency lever was prefix reuse, now shipped).

## Open — grounding edge (the maintained floor → frontier)

- ◦ **(follow-up) SQuAD drift arm — STABILIZE before optimizing** — a fire (2026-06-09)
  TRIED the obvious sharpen (pick drift answers with NO lexical overlap so coverage fully
  fails) and it made Δ WORSE: +0.63 → +0.13 (gate-ON catch 5/8 → 1/8). Reverted. The real
  finding: the SQuAD drift catch is HIGH-VARIANCE — the gate-ON path runs verifyGroundingWithReverify
  (a stochastic gemma reverify), so a single-run Δ on 8 cases is not stable, and the lexical-coverage
  hypothesis does not dominate the catch. So the right next step is STABILITY first: run the SQuAD
  arm at MUSE_EVAL_REPEAT≥3 (pass^k) and/or grow to 20-30 cases to get a stable number, THEN optimize.
  (Rejected: the disjoint-drift sharpen, as an unverified — in fact negative — win.)
- ⏳→✓ **Source-trust segregation — DECIDED 2026-06-10 (option B, per the standing
  decide-and-do directive) and the core shipped** (see Done): tool-derived citations live on the
  VerifiedSource/response-filters path, so the provenance marker went THERE (the sources block
  heading now names itself external/tool-fetched), plus `trusted:false` on the ask path's tool
  evidence so `groundedOnUntrustedOnly` has real input. Remaining: the live battery (Open above).
  Original framing kept below for context:
  `KnowledgeMatch.trusted` provenance bit + the pure detector `groundedOnUntrustedOnly` (flags a
  grounded answer resting ONLY on untrusted sources), agent-core, 4 tests. REMAINING — RE-SCOPED
  2026-06-09 (a fire found the naive wiring target wrong): tool-output does NOT become a
  `KnowledgeMatch` — it produces `VerifiedSource` (tool-output-evidence.ts) consumed by the
  response-filters path, SEPARATE from the grounding evidence set (`KnowledgeMatch` today comes only
  from the user's own notes, i.e. always trusted). So `groundedOnUntrustedOnly` has no untrusted input
  in the CURRENT graph — it is a forward-looking guard. Correct sub-slices: (1) DECIDE the design —
  merge tool-output INTO the grounding set with `trusted:false` (architectural), OR mark trust on the
  VerifiedSource/response-filters path where tool-derived citations actually live; (2) surface a marker
  when a cited claim rests only on untrusted provenance; (3) a live battery. Start with (1)'s decision.
  Below is the original framing (kept for context):
  NAMED (see Done: grounded-not-true.test.ts locks that a false-but-source-supported answer
  is "grounded", while a fabricated citation is still caught). The user's OWN false note is
  unfixable by design ("it's yours"), but an UNTRUSTED source (hostile/allowlisted MCP
  tool-output, per architecture.md) being treated as ground-truth IS fixable. Slice: tag
  evidence provenance (user-note vs tool-output) through the recall→gate path and surface a
  distinct verdict/marker when a grounded answer rests ONLY on untrusted tool-output, so the
  user knows the citation is not their own data. Source-veracity is impossible on a fixed 12B;
  source-TRUST segregation is not. (tool-output-evidence.ts already treats tool output as
  untrusted — thread that signal into verifyGrounding's evidence set.)
- ◦ **(follow-up) measure --best-of's answered-rate lift on a drift-prone corpus** —
  the mechanism shipped (see Done 2026-06-10) but its LIVE adoption path never fired in 3
  adversarial attempts (gemma4 + the gate are robust enough that a natural first-draft
  verdict failure is rare on a clean corpus — itself a positive finding). When labeled
  `ungrounded` traces accumulate from real usage, replay those queries with --best-of 3
  and report the adoption rate; promote the flag to default-on only with that number.

## Open — dev-loop fuel & measurement (makes the loop compound)

- ◦ **(follow-up) outcome labels for the remaining cli.local surfaces** — `muse ask` now
  labels every trace (see Done 2026-06-10); still `grounded:null`: ask `--json` mode and
  `--image` (the verdict doesn't run there by design), and `muse chat --local` (the chat
  gate is the sync NUMBER-only check, a different verdict shape). Label chat-local when
  the error-analysis fuel from ask proves insufficient — don't build ahead of need.
- ⏳ **`error-analysis.mjs` — cluster `.muse/runs` failures into a ranked taxonomy**
  — the missing ANALYZE half. BLOCKED on the instrumentation above (no labels = no
  Pareto; clustering a passing-looking corpus with the same 8B is maker=judge theater).
  Defer until ~20-30 real labeled failures exist. Source: eval-driven-dev research
  (Husain/Yan; Google "every user report → permanent test case").
- ◦ **Split the eval scoreboard into TRAJECTORY vs FINAL-RESPONSE axes** (Google ADK:
  EXACT/IN_ORDER/ANY_ORDER match modes + separate final-response score) so a regression
  localizes to path-vs-answer. Pure refactor of `scripts/eval-harness.mjs`.
- ✓→Done **`hallucinations_v1`-style per-sentence groundedness** — finer than the answer-level
  gate: labels each sentence supported/unsupported so the fuel names WHICH sentence was
  un-groundable. Source: Google ADK eval criteria.
  [DONE 2026-06-12, cognition loop fire 5+6: labeler + LIVE-wired into the ask grounding-gap
  fuel HINT. fire 6 added `worstUnsupportedSentence` + wired it so a grounding-gap weakness
  records the worst un-groundable sentence as its ledger `hint`. LIVE-PROVEN on the assembled
  CLI: "광합성 화학 반응식" → hint named the exact ungrounded formula sentence; abstains →
  hint named the refusal sentence. Realized via the real-usage weakness-fuel path (better than
  the originally-imagined eval:self-improving surface); "contradictory" label (NLI) stays deferred.]
  — [fire 5] the LABELER shipped:
  `reportSentenceGroundedness(answer, evidence, floor?)` in `@muse/agent-core`
  (`sentence-groundedness.ts`) — pure, reuses the gate's `lexicalTokens` + the
  `splitPreservingSentencePunctuation` splitter; per-sentence supported/unsupported by
  token-coverage ≥ floor (0.5), reports unsupportedCount + unsupportedFraction. Diagnostic
  only (no gate verdict changed). 9-case battery. NEXT: WIRE into eval:self-improving's
  report so a miss names the sentence; "contradictory" label needs NLI (non-deterministic,
  deferred — supported/unsupported is the deterministic core).

## Open — dev-loop hardening (from the 2026-06-08 will-it-work review)

- ◦ **Extend `groundedCases` to ALL battery corpora** — the `groundedCases` ratchet
  SHIPPED for the grounding corpus (see Done: a dropped case there now fails self-eval).
  Remaining: extend the count to the other golden sets (eval:tools, adversarial, plan-quality)
  whose cases live in their own files, so a dropped case in ANY battery regresses. Source: must-fix #3.
- ◦ **Backlog refill is the autonomy ceiling** — write-back records the provenance of
  the consumed item but does NOT mint net-new actionable work, so autonomy lasts ~the
  seed length (~7 fires) then degrades to gap-scout. The durable refill is error-analysis,
  which is BLOCKED on trace outcome-logging (the fuel accrues from Jinan USING Muse, not
  from dev fires). Not a single slice — a standing truth: when ★ OPEN runs low, a refill
  fire (gap-scout or a human direction) is itself the work. Source: review honest-ceiling.

## Open — agent core

- ✓→Done **Council consensus-outlier screen (MoA deception robustness, arXiv:2503.05856)** — [2026-06-13,
  cognition loop fire 28, PAPER-GROUNDED, Fable scout+judge] An A2A council peer is an EXTERNAL untrusted
  agent; a deceptive/off-topic peer's reasoning flowed straight into `synthesizeCouncilAnswer`'s synthesis
  prompt and the reverify judge then PASSED it (the lie IS the cited evidence — GROUNDED≠TRUE at the
  council hand-off). Added pure `screenCouncilOutliers` (per-member mean pairwise Jaccard support over
  CJK-aware `lexicalTokens`; quarantine below absFloor AND relFloor×median, panel≥3, majority-preserving
  cap floor((n-1)/2)), run inside `synthesizeCouncilAnswer` after dedupe (prompt + validPeerIds from `kept`;
  `CouncilAnswer.excludedPeers`). Subtractive on untrusted input; reverify/id-gate/floor unchanged.
  Scout avoided the DEAD `orchestrateAnswer` seam (zero prod callers) → wired the LIVE council. Fable judge
  FAILed v1 (inline `\w+` tokenizer ASCII-only → broken for Korean, Muse's primary language: deceptive
  Korean peer never screened) → fixed to CJK-aware `lexicalTokens` + jaccard(∅)→0 + Korean tests
  (counterfactual: 9 tests fail on the old tokenizer). agent-core 1815 green.
- ◦ **Council screen: cross-lingual similarity** — the fire-28 outlier screen uses lexical Jaccard, so a
  legitimate minority-LANGUAGE peer among a different-language majority has structurally-0 token overlap and
  is wrongly quarantined (documented limitation). Homogeneous-language panels (the common case) + the
  security-critical deceptive-peer case work. FIX needs an embedding-based cross-lingual similarity fallback
  (or a script-disjoint exception) — deferred (needs the embedder at the council seam).

- ✓→Done **Evidence-tallied playbook lifecycle (Memp, arXiv:2508.06433)** — [2026-06-13, cognition
  loop fire 27, PAPER-GROUNDED, Fable scout+judge] Playbook reward was a clamped NET scalar that
  conflated "never used" with "used 10× / 5↑5↓"; deprecation needed a near-pure losing streak;
  probation graduated on a single net-positive bump. Applied Memp's update regimen (public preprint;
  reimplemented): per-entry outcome TALLIES (`reinforcements`/`decays`) + `wilsonInterval` +
  `effectiveStrategyReward` (evidence-damped; legacy-identical without a tally) + `planStrategyLifecycle`
  (deprecate when wilsonUpper<0.4 & n≥5; graduate when probation & wilsonLower>0.5 & n≥3). Wired
  END-TO-END: `adjustPlaybookReward` (store) writes the tallies; the 4 production projections
  (`buildPlaybookProvider` + 3 commands-ask mappers) now CARRY them; `scoreStrategy`/`isAvoidedStrategy`/
  `isInjectableStrategy` consume them on the live `applyPlaybook` ranking path. Fable judge FAILed v1
  (the lifecycle was INERT — projections stripped the tallies) → completed the wiring + an assembled-path
  test (confident-bad {0,8} excluded THROUGH the real provider; counterfactual proves the stripped
  projection let it through). Playbook = prompt-ranking only (floor untouched). agent-core 1805 + autoconfigure 509 + cli 2528 green.

- ✓→Done **Multi-aspect verifier vote on the MoA fallback (BoN-MAV, arXiv:2502.20379)** — [2026-06-13,
  cognition loop fire 26, PAPER-GROUNDED, Fable scout+judge] When the MoA aggregator threw/returned empty,
  `orchestrateAnswer` blindly picked the `"thorough"` proposal — even if off-topic while another was on-point;
  no candidate was ever verified ("Bo-n" without "MAV"). Applied BoN-MAV (public CC-BY; reimplemented): NEW
  `verifier-vote.ts` — `aggregateVerifierVotes` (binary aspect votes, AggScore=approvals/count, argmax,
  deterministic tie-break, NaN-guarded) + `DEFAULT_ASPECT_VERIFIERS` (on-topic/substantive/non-hedging —
  relative ranking, NEVER abstains). Wired into the aggregator-failure fallback only (happy path byte-identical;
  no grounding/citation/abstention semantics touched). Fable judge PASS — reverted-to-HEAD proved the delta
  non-vacuous (off-topic thorough vs on-topic skeptic → skeptic). agent-core 1786 green.

- ✓→Done **Associative recall via Personalized PageRank (HippoRAG 2, arXiv:2502.14802)** — [2026-06-13,
  cognition loop fire 25, PAPER-GROUNDED, Fable scout+judge] Muse recall was isolated (cosine+BM25+ACT-R)
  with zero graph/spreading-activation structure. Applied HippoRAG 2 (public ICML 2025 preprint;
  reimplemented, no code copied): NEW `packages/agent-core/src/associative-recall.ts` — `buildNoteLinkGraph`
  (undirected weighted note graph, edge weight Σ 1/df(sharedToken), df===N excluded) + `personalizedPageRank`
  (deterministic power iteration, damping 0.5, dangling→teleport, mass-conserving). Wired opt-in into
  `rankKnowledgeChunksWithHop` (`associative?` flag): seed PPR with primaries, append top **PPR>0**
  graph-reachable bridges via the fire-22 query-relative-cosine fail-safe path (max-2, primaries
  byte-identical, flag-off no-op). Floor-safe (no verdict change). Fable judge FAILed v1 (missing PPR>0
  floor → appended unrelated PPR-0 notes; vacuous integration test) → remediated (PPR>0 floor + a
  non-vacuous test: bridge absent flag-off / present flag-on via the token chain / unrelated excluded,
  counterfactual-verified). agent-core 1772 green. NEXT: synonym edges + wire into CLI ask after a live multi-hop battery.

- ✓→Done **No needless judge escalation on sentence-opener connectives** — [2026-06-13, cognition loop
  fire 24, Fable-scout runner-up] `answerAssertsUnsupportedValue` flagged sentence-initial capitalized
  connectives ("However"/"Based"/"Therefore"/"Additionally", all absent from LEXICAL_STOPWORDS) as
  named entities → a needless value-escalation judge pass (wasted local inference) whenever an answer
  opened a sentence that way. Added `SENTENCE_OPENER_STOPLIST` to the named-entity filter; genuine
  wrong-entity/number/email drift detection is structurally untouched (preserved). Fable judge FAILed
  the first attempt (positive tests were vacuous — used a THROWING judge that the fail-open escalation
  swallowed); remediated to `async () => false` so the verdict differs, and counterfactual-verified
  (revert src → the 3 opener tests now FAIL). agent-core 1760 green.

- ✓→Done **Second-hop retrieval no longer inflates CRAG confidence** — [2026-06-13, cognition loop
  fire 22, Fable-scout-found] `rankKnowledgeChunksWithHop` appended hop "bridge" matches carrying a
  SEED-relative cosine, but `KnowledgeMatch.cosine` is contractually "cosine to the QUERY" (the CRAG
  confidence signal). An inflated bridge (a near-duplicate note ~0.95 to the seed but ~0.48 to the
  query) flipped a weak retrieval to "confident" → suppressed the LOW-confidence warning + defeated
  the proactive stay-quiet gate + could fire phantom clarifications. FIX: recompute each appended
  bridge's cosine against the ORIGINAL query (embed query once via options.embed — cache hit in
  prod; prefer the chunk's embedText for the consistent space); FAIL-SAFE to cosine:0 on any embed
  error (a bridge must never RAISE confidence). Verdict logic untouched (input repair, IMMUTABLE-CORE
  safe). Fable judge reverted-to-HEAD to PROVE the regression bites (0.9997→"confident" pre-fix,
  0.48→"ambiguous" post). agent-core 1753 green.

- ✓ **Wrong-case enum arg repair (one-shot tool-calling reliability)** — agent-hardening fire 9
  (`686d76b4`, @muse/tools, tool-calling-reliability/arg-correctness): a small local model emits a
  closed-vocabulary (enum/const) value with the right MEANING but the wrong surface form ("HEX" for
  ["binary","octal","decimal","hex"], "  octal  ", "Turn_Off"); strict-equality `validateEnumArguments`
  then rejected it, burning a retry round or failing the call (Structured Reflection arXiv:2509.18847 —
  a right value in the wrong surface form invalidates an otherwise-correct call). `coerceToolArguments`
  already repairs right-value/wrong-TYPE args; this adds the missing enum counterpart `coerceEnumArguments`
  — rewrites a STRING enum/const arg to the schema's canonical spelling ONLY when, after trim(), it
  matches an allowed string choice case-insensitively AND matches EXACTLY ONE such choice. Wired into
  BOTH gates that run `validateEnumArguments` (ReAct agent-runtime + plan-execute, sibling-audit 2/2).
  Conservative/subtractive: ambiguous case-fold match, already-canonical, non-string value/choice, and
  unconstrained free-text props are never rewritten (21-value STABLE-0 FP corpus). Selection unperturbed
  (no tool name/desc/schema changed). MUTATION-FIRST RED on ambiguity guard + match logic + the
  agent-runtime wiring; @muse/tools 275 + agent-core 2512 green; eval:tools all visible cases PASS live
  on gemma4:12b; independent Opus ④b judge PASS (3 mutations RED→GREEN, FP-safe, never invents a value).
  Diversifies cleanly off f5/f6 (recall-dedup), f7 (orchestration), f8 (memory) — a DIFFERENT pkg×kind.

- ✓ **Engine-path near-duplicate bridge dedup** — agent-hardening fire 6 (`96cf6933`, agent-core,
  recall-quality): closed the deferred `◦ 1d-sibling-audit` from fire 5. `rankKnowledgeChunksWithHop`
  (secondHop) and `appendAssociativeBridges` (associative) appended up to 2 hop/PPR bridges to the
  primary ranking with NO near-duplicate check, so a chunk near-identical to a primary (same fact
  across two notes, or a bridge adjacent to a seed) padded the small model's grounding window. Fire 5
  fixed only the CLI/recall ask path (`dedupNearDuplicateChunks`, @muse/recall); the ENGINE had the
  same class gap. New `dropNearDuplicateAdditions` drops a bridge whose cosine to an already-kept
  chunk ≥ 0.985, wired into BOTH callsites (sibling-audit 2/2). AUGMENT-never-displace (primary
  untouched) + FAIL-OPEN (degenerate vec / embed failure → kept; dropped only on a CONFIRMED match).
  Mutation-first RED confirmed (no-op → drop test fails); one inflation-suite fixture loosened
  0.99974→0.970 to keep A′ a real bridge (query-relative-cosine invariant preserved), the ≥0.985 drop
  covered by a dedicated new test. eval:multihop hit@4 60%→80% (no regression). Independent Opus ④b
  judge PASS (7/7, re-ran the mutation itself). agent-core 2494 green.

- ✓→Done **MoA orchestrator: honest contributor attribution** — [2026-06-12, cognition loop fire 7,
  multi-agent #3] the MoA aggregate path set `contributors = all proposers`, but the field is
  documented as "ids the synthesized answer ACTUALLY drew on" and the aggregator discards off-topic
  proposals — a MAST reasoning-action-mismatch (the audit trail over-claimed). Added
  `attributeContributors(merged, proposals, floor=0.4)` (a proposer counts only when the merge
  lexically covers ≥floor of its tokens; fallback to all if none clear it) wired into the multi-merge
  return only. Other return paths (single / single-survivor / aggregator-empty) were already correct.
  agent-core 1708 green incl. a non-vacuous regression (3 proposers, merge echoes 2 → exactly 2 credited).

- ✓→Done **A2A council: typed + length-bounded response boundary** — [2026-06-12, cognition loop
  fire 8, multi-agent #3] the council REQUEST hand-off had a typed `parseCouncilRequest`, but the
  RESPONSE (the direction that flows into the initiator's LOCAL synthesis) was an inline ad-hoc check
  with NO length bound — a buggy/compromised allowlisted peer could flood local synthesis context
  (the wire's "bounded compute" goal wasn't enforced on the accepting side). Added a symmetric
  `parseCouncilResponse` + `MAX_COUNCIL_REASONING_CHARS` (truncate over-long reasoning at the trust
  seam) wired into `requestCouncilReasoning`. fromPeerId is carried-through (NOT a rejection reason —
  the judge caught + relaxed an over-strict draft that would have dropped legitimate reasoning when a
  peer's selfPeerId is unset, which handler.ts emits as ""). a2a 141 green.

- ✓→Done **Council synthesis: one member, one voice (per-peer dedup)** — [2026-06-12, cognition loop
  fire 9, multi-agent #3] `synthesizeCouncilAnswer` fed raw utterances into the synthesis without
  deduping by peer — a duplicate peerId (dup registry entry, or the initiator's selfId colliding with
  a peer id, both reachable via `gatherCouncil`) double-weighted that member (MAST duplicated-work,
  skews a deliberation). Added pure `dedupeUtterancesByPeer` (last-wins, order-preserving) applied at
  the synthesis boundary. agent-core 1712 green incl. a prompt-capture integration (dup peer → the
  synthesis prompt shows the LAST reasoning once, 2 members not 3).

- ✓→Done **Background memory consolidation (sleep daemon)** — [DONE 2026-06-13, cognition loop
  fires 10-12+16, background #5] `consolidationPlan` (recall promote/fade) only ran on the manual `muse
  memory consolidate` CLI — the daemon consolidates the PLAYBOOK but never MEMORY. fire 10 shipped
  the brake-first gate `shouldConsolidateMemory({nowMs,lastRunMs,newHitsSinceLastRun,…})` in
  `@muse/memory` (run only when ≥minNewHits material AND ≥minIntervalMs since last run — non-straining;
  10-case battery). fire 11: `planMemoryConsolidationTick(records, state, options)` — the pure
  decide-and-run unit: counts recall records re-engaged since lastRunMs (the new material), gates on
  the brake, and only then DELEGATES to consolidationPlan, returning {ran, plan?, nextState} (lastRunMs
  advanced only when it ran). 7-case battery (incl. plan==consolidationPlan delegation + both brakes).
  fire 12: WIRED into the daemon — `runMemoryConsolidationTick` (sibling fn, testable) reads recall
  hits → planMemoryConsolidationTick → logs promote/fade, registered as a daemon tick next to
  playbookConsolidateTick (MUSE_SELFLEARN_ENABLED-gated, fail-soft, in-closure lastRunMs). Background
  memory consolidation now RUNS on the daemon schedule (brake-gated). fire 16: promotion-PERSISTENCE
  — `runMemoryConsolidationTick` gains an optional `persist` dep; the daemon binds it to the existing
  `promoteRecalledMemories` (idempotent: clears prior PROMOTED_FACT_ + writes the current top-N into
  the persona; non-destructive, never touches real user facts, never outbound) behind a DEDICATED
  opt-in flag `MUSE_SLEEP_PROMOTE` (default OFF ⇒ report-only preserved). So with the flag on, the
  daemon graduates the most recall-useful memories into the always-on persona in the background,
  brake-gated. cli 2520 green (persist-on-brake-pass, not-on-fail/disabled, fail-soft on throw).
  (ACT-R ranking from T2-1 feeds the selection via useActrRanking.) #5 thread COMPLETE.

- ✓→Done **MoA fan-out: no duplicated sub-agent work (dedupe roles by id)** — [2026-06-12, cognition
  loop fire 13, sub-agents #4] `orchestrateAnswer` ran every role as a parallel proposer without
  deduping by id — duplicate-id roles ran a redundant sub-agent (wasted inference) AND yielded dup-id
  proposals that corrupt fire-7's `attributeContributors`/`contributors`. Added pure `dedupeRolesById`
  (first-wins, order-preserving) at the roleList resolution. MAST "no duplicated sub-agent work".
  agent-core 1718 green incl. an integration (2 dup-id roles + 1 → exactly 2 proposals, unique ids).
  DEFAULT_ROLES path unaffected (distinct ids → no-op).

- ✓→Done **MoA fan-out: empty proposer output → failedRoles (failure surfacing)** — [2026-06-12,
  cognition loop fire 14, sub-agents #4] `orchestrateAnswer` kept EVERY fulfilled proposer as a
  proposal, even one returning empty/whitespace text (a degraded sub-agent that didn't throw) —
  polluting the aggregator candidate list + inflating proposals.length. Now a fulfilled-but-empty
  proposal falls into `failedRoles` like a throw (MAST "failure propagation surfaces"). One-condition
  change (`&& outcome.value.text.trim().length > 0`); fail-close/single-survivor/aggregate/onProposal
  unchanged. agent-core 1722 green (empty→failedRoles, whitespace, all-empty fail-close, regression).

- ✓→Done **MoA aggregator failure resilience** — [2026-06-13, cognition loop fire 15, sub-agents #4]
  the proposers run under allSettled (resilient) but the AGGREGATOR call was unguarded — a flaky
  local-model aggregator throw REJECTED the whole orchestration, discarding every successful
  proposer's work. Wrapped `aggregate()` in try/catch → a throw becomes an empty merge → the EXISTING
  fallback returns the best proposal (the "thorough" one). MAST graceful-degradation / don't-lose-
  sub-agent-work. agent-core 1725 green (throws→resolves-with-proposal, empty→fallback, success→merged).

- ✓→Done **Weakness-ledger bounded growth** — [2026-06-13, cognition loop fire 23, Fable-scout
  runner-up] `writeWeaknesses` wrote all rows uncapped (unlike recall-hits' 5000-trim) → the ledger
  grew without bound as novel topic rows accrued. Added `MAX_WEAKNESS_ENTRIES=2000` trim: on overflow
  keep what the selectors surface (count desc, then recency), evict stale one-offs; under the cap =
  verbatim/unreordered. mcp 1683 green; Fable-judge PASS (under-cap order-pin non-vacuous, evictions genuine).

## Blocked / deferred

- ⏳ **Grammar-constrained tool-call decoding** — INFEASIBLE on Ollama today: `format`
  (schema→grammar) and `tools` are NOT composable (Ollama #6002). Revisit when #6002
  lands or accept an inference-stack change. Existing `groundToolArguments` already
  covers the fabricated-value class.

## Rejected directions (do NOT re-derive these)

- ✗ **Chase general agentic leaderboards (SWE-bench Verified / τ²-bench / BFCL) as the
  "best" claim.** A fixed ~12B local model loses by construction (best open-weight
  SWE-bench ~80% on 200B+ MoE; BFCL 8-14B ~66% vs ~88% frontier). Own the architectural
  grounding-DELTA niche instead — the one claim a bigger model can't beat by swapping in.
  (2026-06-08 review, 3 adversarial critics concurred.)
- ✗ **Build the error-analysis analyzer before instrumenting outcome-logging.** No fuel
  (labels) exists yet; building the pipeline first is infrastructure for a flywheel with
  no gas. Instrument first (above), analyze later.

## Open — browser control (low-spec model drives Chrome; track started 2026-06-11)

- ✓→Done **ask --with-tools tool-set diet** — maxTools 10 default (MUSE_ASK_MAX_TOOLS, 0/off
  uncaps); relevance-sorted top-N. MEASURED side win: browse turn 93s → 42s (smaller tool
  schemas = less prompt eval). Found+fixed en route: 1-char CJK keyword containment ("비" ranked
  weather on 비밀번호 prompts → exact-only) and weather's calendar words (내일/주말) outranking
  reminders.add. Probes: browse→browser_open, recall→grounded cite, reminder plan→reminders.add
  first; eval:tools 125/125. Follow-up below.
- ✓→Done **muse.* loopback keywords** — recall family keyworded (notes×6, tasks.search,
  reminders.search/history, episode.search; calendar/tasks-CRUD/reminders-CRUD already had them
  in a different def position — the audit's "no keywords" claim was PARTIALLY wrong). Plan probes:
  노트→muse.notes.search 1st, 지난번 대화→episode.search 1st, 할일 검색→tasks.search 1st.
  Still bare (low-traffic tail, fine): context/messaging/followup/pattern/status/skills.
- ◦ **ask latency on the browser path** — ~90s/turn measured (10K-token prompt eval ≈ 40s × 2
  rounds on gemma4). Levers: prompt diet under --with-tools (skip notes blocks on clear
  browse intent?), KV prefix reuse across rounds, smaller tool list (above).
- ✓→Done **injection-pattern cross-span tightening** — the EN role_override family + 2 KO
  role_override + 1 KO extraction regexes used unbounded `.*`/`/s`, so three unrelated words from
  DIFFERENT sentences combined into a false hit (live repro: "disregard the noise … finally …
  assembly instructions" → role_override, with `all` matching the substring inside "fin**all**y").
  Bounded the inter-token spans to `.{0,50}` (EN) / `.{0,30}` (KO, denser script) and word-boundary-
  anchored `all`. TDD: 3 cross-span false-positive cases (EN + KO) + a true-positive-preserved case;
  all 127 policy tests green incl. the multilingual battery (true positives intact), agent-core
  guards 1622, byte-hygiene 30, precheck:grounding pass^2. Real injections keep trigger→target→noun
  within a clause, so detection is unchanged; only the cross-sentence false combinations are killed.

- ✓→Done **same-origin iframe piercing** — the snapshot walk descends into same-origin
  iframe `contentDocument` (like shadow roots); cross-origin throws on access and is
  honestly skipped. Ref resolution searches EVERY frame (`page.frames()`), so an
  iframe-embedded control is both visible AND clickable. Real-Chrome smoke (local http,
  same-origin iframe button): button appears in the snapshot + cross-frame click succeeds.
- ✓→Done **empirical real-web hardening (probe → fix → lock)** — a gap-probe of 7 real
  patterns on puppeteer-core 25.1.0 / Node 24 surfaced 3 bugs, all fixed + locked in
  smoke:browser (now 12 scenarios): ① a JS dialog (confirm/alert/prompt) BLOCKED the
  page → the next action hung to the timeout; now auto-accepted (the act was draft-first
  approved upstream) + reported in the snapshot `dialog` field. ② content inserted by
  setTimeout/fetch AFTER a click was missed (networkidle returns instantly with no
  network) → a MutationObserver-based `settleDom` waits for the DOM to go quiet (fast on
  static pages, capped). ③ disabled controls were listed (wasted clicks) → skipped in the
  walk. Verified: unit 36, smoke 12/12 exit 0, eval:browser-agent PASS.
- ✓→Done **new-tab following + autocomplete** (probe batch 2) — a target=_blank link /
  window.open popup spawned a tab the controller never followed (it kept observing the
  stale opener; window.open even hung 8s). Fix: arm a `targetcreated` listener BEFORE the
  click/submit (checking pages() after races and misses it) and adopt the new tab, within
  a 500ms window so a normal no-new-tab click isn't taxed (2943ms → 1446ms). Autocomplete
  (type → suggestion) already works via the DOM-stable settle. Locked: smoke 13 (new tab
  followed) + 14 (autocomplete observed); unit 36, eval:browser-agent PASS.
- ✓→Done **repeated-control targeting** (probe batch 3, click/select) — a per-row
  "Add to cart" / repeated "View" was DEDUPED to one entry, so the model could never
  target the 2nd (product lists, tables, search results — a huge real-web class). Fix:
  (a) dedup now collapses only TRULY redundant LINKS — same text AND same href (a
  responsive nav rendered twice); distinct buttons/actions are kept. (b) matcher gained
  ORDINAL targeting ("the second Add to cart", "2nd View", "last") that picks the Nth
  among equally-matched controls in DOM order — guarded so a literal label that starts
  with an ordinal word ("First name") is never mis-stripped (only applies when `rest`
  truly has >1 match). Custom (non-native) dropdowns + tabs already worked (settle).
  Locked: matcher unit +5, smoke 15 (repeated buttons distinct + ordinal→Banana), agent
  battery PASS.
- ✓→Done **browser_hover** (probe batch 4) — hover-triggered dropdown navs / tooltips were
  invisible (the submenu only renders on :hover/mouseover). New read-risk `browser_hover`
  tool grounds a target (the menu label) and moves the pointer over it, then re-observes —
  the pointer STAYS, so a nested submenu item stays clickable (moving to it keeps :hover).
  Also added `[aria-haspopup]` to the snapshot selector so explicit (possibly non-link)
  menu triggers are listed. Locked: unit +2, eval 10/10 STABLE 3/3 (hover→browser_hover,
  not click), smoke 16 (hover reveals Billing then clicks it), agent PASS. (Limit: a hover
  trigger that's a bare non-interactive `<div>` without aria-haspopup still isn't listed.)
- ✓→Done **form-control labels** (probe batch 5) — a radio/checkbox/labeled input was
  named by its `value`/`name` attr ("pro"), NOT its VISIBLE label ("Pro plan"), so the
  model — which refers to controls by their label — couldn't target them. Fix: a form
  control's name now resolves its accessible label (aria-labelledby → `<label for>` →
  wrapping `<label>`) before falling back to value/placeholder. Also added `[role=option]`
  / `[role=switch]` to the snapshot selector (custom listboxes/toggles with JS-delegated
  handlers, no inline onclick). Verified: radio→"Pro plan", input→"Email address",
  checkbox→"I agree to terms" all targetable + actionable; range sliders already settable
  via type/fill. Locked: smoke 17, unit 43, agent PASS.
- ✓→Done **browser_key** (probe batch 6) — no keyboard action meant a modal/dropdown with
  no visible close control could not be dismissed, and keyboard-driven UIs were unreachable.
  New read-risk `browser_key` tool presses Escape / Enter / Tab / arrows, then settles +
  re-observes (Enter wrapped in the new-tab follow). Verified: a modal opened by a button
  and closable only by Escape is dismissed; Tab fires its handler. Locked: smoke 18, eval
  11/11 STABLE 3/3 (Escape→browser_key, not click), unit 46, agent PASS.
- ✓→Done **multi-step agent reliability** (the frontier) — eval:browser-agent was a single
  1-2-step task; added a genuine multi-step scenario (open → search → CLICK the result →
  read the DETAIL page → answer the stock count that appears ONLY there). gemma4:12b carries
  the full chain STABLE 3/3 (terminal state = ended on the detail page; grounded answer = the
  "7 units" that's unreachable without clicking; fabricating or stopping at the results fails).
  Proves low-spec multi-step web autonomy is reliable, not just one-shot. The battery is now a
  scenarios[] array — add a scenario per new capability.
- ◦ **more real-web probes** — native file upload (`<input type=file>` → CDP uploadFile +
  path arg/tool), cross-origin iframe (per-frame contexts — scope honestly), drag-and-drop;
  and harder multi-step chains (3-4 clicks, a form fill across pages).
- ✓→Done **browser_scroll** — the snapshot only saw rendered DOM, so below-the-fold /
  lazy-loaded content (infinite feeds, long lists) was invisible. New read tool scrolls
  (down/up/top/bottom) + settles + re-observes. Unit (enum + reject-unknown + scrolls);
  eval 9/9 STABLE 3/3 (scroll EN+KO); real-Chrome smoke: a button lazy-appended on scroll
  is absent before and present after scroll('bottom'). Completes the observation-
  completeness trio with iframe + paging.
- ✓→Done **element paging past the 50 cap** — no more silent truncation. The controller
  collects up to BROWSER_ELEMENT_CEILING (200) so grounding matches the WHOLE set in code;
  every tool RESPONSE shows ≤BROWSER_MAX_ELEMENTS (50) and reports `total` +
  `hasMore`/`nextOffset`; `browser_read` gained an `offset` arg to page. Unit: 50-cap +
  total/nextOffset + offset-reads-the-rest; smoke: 61 elements returned (not capped at 50).
- ✓→Done **agent-level multi-step live battery** — `pnpm eval:browser-agent`: gemma4 drives
  open→type+submit on a local fixture shop (file://, no network) and answers from the rendered
  result; graded on TERMINAL STATE (the page records the query it actually received — a
  fabricated "I searched" cannot pass) + answer must carry the name+price that only render
  post-search. 3/3 STABLE. Built it the hard way: ① matcher bug — "search box" landed on the
  'Search' BUTTON (substring 60 > shared-words 35); type-intent now prefers ANY matching
  typeable element. ② harness initially omitted metadata.localMode → runtime hid the
  execute-risk type/click and gemma FABRICATED a result ("Wireless Mouse Pro $29.99") —
  recorded evidence that the gate-less raw model invents on tool failure; the ask path's
  verdict gate is the standing protection. ③ launchDetached probe window 10s→30s (a fresh
  profile's cold start exceeded 10s under load — "slow" misread as "missing").

## Done (recent — newest first)

- ✓ 2026-06-12 **file_read — "다운로드에 있는 PDF 요약해줘" 원샷** (tool-audit batch #4, the last):
  ONE read-risk tool, default under --with-tools. The model NAMES the file ("invoice pdf"); code
  grounds it — Downloads/Desktop/Documents walk (depth 3, no dotfiles), exact>prefix>contains>words
  ranking, newest-first ties; unmatched ⇒ recent-files list, never a guess; absolute path outside
  the roots ⇒ refused (muse.fs allowlist posture); >25MB refused; text capped 20K chars. PDF text
  via lazily-imported pdfjs-dist 6 (Apache-2.0; v6 dropped font-eval entirely). Proof: mcp 1606
  unit (10 new, TDD); NEW gate `pnpm eval:file-read` — headless Chrome GENERATES a real PDF →
  real pdfjs extraction → tool round-trip + fail-closed bounds, 6/6; eval:tools new file scenario
  5/5 STABLE 3/3 (spotlight/notes-recall/no-tool confusables); FULL eval:tools 130/130; LIVE e2e —
  a real contract PDF in ~/Downloads summarized with all three terms correct. Follow-ups: .docx/
  .hwp extraction · file kind by content-sniff not extension · file_read content into the
  grounding-evidence path with a [from FILE] cite.


- ✓ 2026-06-11 **mac_screen_read — "지금 화면에 뭐 떠있어?" 원샷** (tool-audit batch #2): screencapture →
  injected LOCAL vision callback (describeImage in agent-core: abstention-prompted free-text, fail-soft,
  never invents) → text; @muse/macos stays model-free (CLI binds gemma4 lazily via a holder ref since
  actuator tools build before the assembly). risk:read, behind MUSE_MACOS_ACTUATORS. mac_screenshot gained
  the not-when line (file vs describe). Proof: agent-core 1622 + macos 66 unit; eval:tools mac scenario
  28/28 STABLE 3/3 (2 new cases incl. the screenshot confusable); LIVE e2e described the real screen
  (Chrome+Example Domain+popup) accurately. ALSO from the audit: clipboard READ already existed
  (mac_app_read app='clipboard', eval-covered) — no duplicate tool built; live e2e returned pbcopy'd
  text verbatim.


- ✓ 2026-06-11 **browser: LIVE end-to-end — `muse ask`가 실제로 Chrome을 부린다** (4 commits):
  driving the REAL front door exposed a chain of four blockers, each fixed + verified live:
  ① injection input guard self-blocked every --with-tools ask (its own anti-injection guidance
  quotes attack strings; now scans USER messages only). ② browser_open/back were execute-risk →
  hidden without --actuators (now read; reads are free). ③ the ask prompt's "USING ONLY the
  notes" lock beat the armed tools (forked under --with-tools). ④ num_ctx 8192 vs 32K-budget
  mismatch → prompt truncated to done_reason:length, EMPTY answer (DEFAULT_OLLAMA_NUM_CTX=32768,
  live-verified the runner honours request num_ctx). PLUS: puppeteer.launch child pinned the
  event loop (ask answered then hung forever) → Chrome now spawns DETACHED and every invocation
  CONNECTs via DevToolsActivePort; ask disconnects post-run. Toolchain: Node 24.16 (nvm default),
  puppeteer-core 25.1 (clickCount→count), Locator API on click/type. PROOF: back-to-back live
  asks — ASK1 93s exit 0 (browser_open, grounded, external-source cite), ASK2 92s exit 0
  (reconnects, browser_read reads the SAME page). smoke:browser 13/13; pnpm check exit 0 on
  Node 24; precheck:grounding pass^2. LESSON: eval:tools 7/7 ≠ the surface works — only driving
  the assembled path catches exposure/prompt/window/process-lifecycle blockers.

- ✓ 2026-06-11 **browser: see the real web — SPA settle + shadow DOM + <select> grounding**:
  bounded settle-and-retry (`looksUnsettled`, 2×700ms) so late-rendering SPAs aren't a blank
  page; composed-tree walk + `pierce/` ref resolution so open shadow roots are observed AND
  actable; `browser_type` on a dropdown grounds the option in code (`matchOption`, fail-close —
  unmatchable option throws, page untouched); position:fixed controls no longer filtered
  (offsetParent check dropped); +combobox/searchbox/checkbox/radio/menuitem/tab roles.
  NEW standing gate `pnpm smoke:browser` (real headless Chrome, file:// fixtures, no network,
  skip-if-no-Chrome) 10/10. Tool-description fix: browser_open gained the "NOT for acting on
  the already-open page" line — the KO type case was 0/3 ON THIS MACHINE even at HEAD (the
  7/7 STABLE claim didn't reproduce — T=0 varies across machines); now 7/7 STABLE 3/3, full
  eval:tools 97/97. Also: removed a raw NUL byte committed into puppeteer-controller.ts
  (git saw the file as binary; byte-hygiene).

- ✓ 2026-06-11 **fresh-pass batch #2-#4**: README model-claim drift fixed (identity doc said
  qwen3:8b default — stale since 6/7; EN+KO). Duplicate date/time prompt line dropped on persona
  turns (~20 tokens/turn). **ask stage-latency instrumentation** (createStageTimer →
  trace `timings` + MUSE_TIMINGS=1 stderr): FIRST real breakdown = retrieval 0.2s (0.7%) ·
  generation 20.2s (75%) · verdict 6.5s (24%) of 26.8s — perf work should target generation
  (KV prefix env, sleep-compute) and reverify cost, NOT retrieval. Known-flake note: synthetic
  EN-weather case invents a tool name ~1/3 at temp 0 (pre-existing; REPEAT=3 surfaces it).
- ✓ 2026-06-11 **fresh-pass #1: --json carries the gate verdict** — the verdict now computes in
  json mode too (emissions stay non-json; best-of stays inert there); payload gains
  `groundedVerdict`; json traces now carry REAL labels instead of null (more error-analysis
  fuel). Live-verified. Closes half of audit CLI #8 (dead verdict under --json).
- ✓ 2026-06-11 **F9(half): SDT-adaptive proactivity criterion** — Green&Swets likelihood-ratio
  criterion as code: `sdtCriterion` (Laplace-smoothed, bounded β) + `adjustConfidenceFloor`
  (acceptance-region scaling) + `summarizeNoticeResponses` (done/snooze=acted, dismiss=noise,
  from the existing ↩-reply markers). WIRED live: the daemon's pattern tick now adapts the
  0.7 firing floor per the user's own response history (≥3 responses; fail-soft to default).
  A dismiss-heavy pattern category self-suppresses; an acted-on one fires more readily. 4/4.
- ✓ 2026-06-11 **Maturity-review do-next batch (#1-#5 ALL shipped)**: ① dead ACT-R wired (recall-hit
  ledger → Petrov-2006 approximation, hot episode outranks cold; 3fb1b95d). ② multi-hop measured
  REAL (joint@4 2/6) → deterministic second-hop ships 4/6 with single-hop hit@1 15/15 preserved
  via augment-never-displace (df9dc99b). ③ contextual chunk annotation (embedText, bare-value
  probe 5/6→6/6, both rank paths + persisted index; 4f237b95). ④ prompt-budget ENFORCEMENT
  (priority eviction, opt-in MUSE_PROMPT_TOKEN_BUDGET; 8b5a18ed). ⑤ multi-agent subtract-then-type:
  race PARKED (wire-compat → sequential, runRace deleted), parseWorkerResult typed boundary on all
  seams, and the FIRST live orchestration battery (eval:orchestration — injected failure
  propagates, bounded termination, fan-in survives; PASS on gemma4 in 2.3s).
  Remaining from the review: block-ablation arm (feeds/reflection) — queued.

- ✓ 2026-06-10 **AUDIT FIX (HIGH-adjacent): non-TTY fail-close unified across ALL actuator gates**
  — the stores/safety audit found web/email/home approval gates lacked the non-interactive deny
  the messaging gate had (outbound-safety rule 2: an undeliverable confirm must deny — a piped
  stdin byte must never act as the confirmation keypress). buildWebApprovalGate /
  buildEmailApprovalGate extracted with the shared contract; approvals re-run threads
  isInteractive (headless approve stays fail-close). 3 new gate tests; CLI 2455 green.
- ✓ 2026-06-10 **F7 semantic entropy: NEGATIVE result, recorded** — discrete SE (Nature 2024)
  AUROC 0.375 vs retrieval-confidence baseline 0.813 on answerable-vs-refuse: Muse's
  abstention-trained prompt makes refusals CONSISTENT ("NOT IN NOTES" × k), so sample
  scatter never appears — SE adds no signal here; do not adopt
  (docs/benchmarks/RESULTS-semantic-entropy.md, scripts/eval-semantic-entropy.mjs kept for re-runs).

- ✓ 2026-06-10 **Top-5 batch (Jinan-directed "do all 5")**: ① reverify judge now
  format-CONSTRAINED on all 4 call sites (REVERIFY_RESPONSE_FORMAT + parseGroundingReverifyJson,
  fail-close, legacy YES-parse fallback; precheck:grounding pass^3 live) — a verdict can no longer
  be lost to parse drift. ② source-trust DECIDED (option B) + shipped: the verified-sources block
  heading names itself external/tool-fetched (KO/EN), tool evidence carries trusted:false.
  ③ multi-turn query rewriting (needsContextualRewrite → one constrained inference → retrieval-only
  rewrite, fail-open): LIVE 2-turn proof — "그거 언제 바뀌었지?" resolved the anaphor and answered
  6월 2일 [from wifi.md]. ④ plan-cache reuse Jaccard→embedding blend
  (selectPlanExemplarByRelevance, cosine floor 0.75, fail-open lexical; wired via createGateEmbedder
  whose fallback also moved to the v2-moe default). ⑤ self-eval case ratchet extended to ALL golden
  sets (toolCases=84, adversarialCases=16, planCases=10). Gates: pnpm check exit 0 · CLI 2452 ·
  agent-core 1583 · autoconfigure 503 · lint 0/0 · precheck:grounding pass^3.
- ✓ 2026-06-10 **Lever #1 SHIPPED — multilingual embedder default + one-time legacy migration**
  (6caaa6ac): measured A/B (eval:embedder-ab, production ranking config, paraphrase queries) —
  v1 `nomic-embed-text` KO hit@1 **50%** vs `nomic-embed-text-v2-moe` **100%** (EN 100% too,
  no regression; embeddinggemma 92%). Default flipped (env `MUSE_EMBED_MODEL` overrides; leaf
  module `embed-model-default.ts`; 20 literals swept). `resolveIndexModel` migrates a
  LEGACY-default index once (live-verified on the real index); custom models preserved. All
  grounding batteries green ON THE NEW EMBEDDER (pass^3, Δ+0.94, chat 1.00/0.00).
  NOTE for the setup-language idea: one multilingual default serves KO+EN, so no setup
  language question is needed for the embedder; reply language remains a persona pref.
- ✓ 2026-06-10 **Lever #3 SHIPPED — ollama-perf doctor posture + stable-prefix prompt ordering**
  (c76ad9ba + part of 6caaa6ac): `muse doctor` advisory for OLLAMA_FLASH_ATTENTION/KV_CACHE_TYPE
  (reads process env + macOS launchd); ask's volatile prompt lines (time, retrieval guidance)
  moved BELOW the stable instruction block so Ollama's KV prefix reuse survives across turns.
  Residual: TTFT effect not isolated (needs control of the user's Ollama.app env — measure
  after Jinan sets the env vars).
- ✓ 2026-06-10 **Chat grounding parity — reverify escalation on the front-door surface**: the
  chat gate's borderline bands (weak retrieval, coverage-only failure, unsupported asserted
  value) now spend the SAME one-shot reverify judge ask uses (`gateChatAnswerWithReverify`,
  shared `chatGatePrecheck` keeps the deterministic number/email/quote checks identical; the
  judge fires ONLY on those bands — zero extra inference on a normal grounded turn; fail-close
  on judge error). Closes the recorded named-entity-drift-on-chat gap via the value-escalation
  band. TDD 6/6; CLI suite 2436 green; precheck:grounding pass^3; eval:chat-grounding
  faithfulness 1.00 / false-refusal 0.00; live chat round-trip cited. Sync `gateChatAnswer`
  stays (eval + no-provider fallback).
- ✓ 2026-06-10 **Multi-agent handoff fail-close (`validateWorkerHandoff`)**: a BLANK worker
  output no longer flows downstream as "completed" (MAST information-withholding) — sequential
  marks the step failed and tells the next worker, parallel reports failed, race never lets a
  blank answer win, supervisor excludes the worker and falls through. Typed `WorkerHandoff` +
  6/6 tests (incl. failure-propagation assertions); multi-agent suite 75/75.
- ✓ 2026-06-10 **Agent-performance levers research pass** → ranked 12-lever list with sources +
  feasibility-on-Ollama-today at `docs/strategy/agent-performance-levers.md`; top 3 promoted to
  the Open section above.
- ✓ 2026-06-10 **Best-of-N recall shipped — the gate is now a SELECTOR, not just a filter**
  (`muse ask --best-of <n>`, 2-5): when the first draft fails the grounding verdict, redraw n-1
  fresh drafts, `selectBestGroundedDraft` (agent-core, deterministic rubric-sum ranking, "weak"
  never accepted, TDD 5/5) picks the best grounded survivor, and the FULL reverify-backed gate
  confirms it before it replaces the answer — fail-close, so resampling can only raise the
  answered rate at the same fabrication=0. Orchestration extracted as `drawBestGroundedRedraft`
  (4/4 unit, composed with the REAL selector). Gates: pnpm check all-workspace green, lint 0/0,
  precheck:grounding pass^3 3/3, eval:grounding-delta Δ+0.94 unchanged, live happy-path ×4.
  HONEST LIMIT: the live adoption path (🎯) never fired in 3 adversarial forcing attempts —
  measured follow-up recorded above. Source: backlog ◦ (arXiv 2504.04718 — small models can't
  self-verify; Muse's owned verifier selects instead).
- ✓ 2026-06-10 **Trace outcome-logging COMPLETE for `muse ask` — cli.local traces carry real labels**
  (the standing ★ PREREQUISITE): the ask path now writes a run-log trace per answered run with the
  top-level `grounded` label the run already computed — `abstain` (refusal), `grounded`/`ungrounded`
  (rubric verdict), `null` only where the verdict doesn't run (`--json`/`--image`). Pure
  `askOutcomeLabel` (TDD, 3/3) + writeRunLog wiring before the output split; full CLI suite 210
  files/2426 green; LIVE both polarities on gemma4 (혈액형→abstain, notes question→grounded, source
  receipt shown). Error-analysis fuel now accrues from real usage; the analyzer stays deferred until
  ~20-30 labeled failures exist.
- ✓ 2026-06-10 **improve-muse restructured: finder/recommender, not full build loop** — a real
  invocation ended with "할 게 없다" (the ★ refill had all shipped; remaining = 1 medium-risk ★ +
  2 ⏳-on-Jinan), exactly the autonomy-ceiling failure dev-loop.md §5 predicted. Per Jinan's direction
  the skill now runs ORIENT+FIND only and MUST end with a ranked recommendation ("nothing to do" is a
  forbidden output — empty backlog ⇒ the refill scout IS the candidate; blocked item ⇒ the surfaced
  decision IS the recommendation). BUILD→COMMIT stays in dev-loop.md §3 after the pick. GREEN-verified:
  a fresh subagent following the new skill against the same repo state produced 3 ranked candidates +
  the source-trust ⏳ as an A/B question + a clear 내 추천, no build, no "nothing to do".

- ✓ 2026-06-09 **pre-push hook fix** — the hook ran `exec pnpm` and blocked the push with
  "pnpm: not found" from a GUI/IDE git client (which spawns hooks with a minimal PATH where an
  nvm/corepack-installed pnpm is absent). Now resolves pnpm (with common-path fallback) and SKIPs
  (exit 0) if still unfound — fail-open on a broken hook environment, never block a push because the
  tripwire couldn't start. LESSON: a pre-push convenience hook must degrade to skip, not block.
- ✓ 2026-06-09 eleventh `improve-muse` fire (20-min loop) — **`noWrite` over-invocation scorer**:
  `toolScorers.noWrite(writeToolNames)` in eval-harness.mjs — reads allowed, any write/execute
  (actuator) tool fails. The IrrelAcc primitive `noTool` couldn't express ("report yesterday" may
  call a recall read but must never fire calendar_add). 14/14. The refill's 3 ★ are now all shipped.
- ✓ 2026-06-09 tenth `improve-muse` fire (20-min loop) — **groundToolArguments substring-hardening**:
  isGrounded now matches a value token at a WORD START (prefix), not as a raw substring — so a fabricated
  "art" is no longer grounded by "start the meeting", while morphology (meeting→meetings) and Korean
  particle attachment (강남역→강남역에서) still ground. Strengthens the deterministic anti-fabrication edge
  at the tool boundary. unit 12/12; live eval:tool-arg-grounding 2/2 (강남역 kept, fabrication dropped).
- ✓ 2026-06-09 ninth `improve-muse` fire (20-min loop) — **REFILL + outbound-safety guard test**:
  the clean backlog had drained, so FIND WORK (c) ran a gap-finding scout → 3 fresh clean ★ slices
  added (contacts negative-invariant, groundToolArguments substring-hardening, noWrite scorer). Then
  built the top one: resolve-contact.test.ts now pins that relationship/about/connections NEVER resolve
  a recipient (outbound-safety rule 3) — 7/7. The loop un-stuck itself via the prescribed refill.
- ✓ 2026-06-09 eighth `improve-muse` fire (20-min loop) — **NEGATIVE result, recorded**: tried the
  disjoint-drift sharpen on the SQuAD arm; it dropped Δ +0.63→+0.13 (catch 5/8→1/8), so verify-before-claim
  REVERTED it. Real finding: the SQuAD drift catch is high-variance (stochastic gemma reverify) — the
  single-run +0.63 is not stable; stabilize with pass^k before optimizing. A failed experiment caught and
  recorded, not shipped — the discipline working on a metric regression.
- ✓ 2026-06-09 seventh `improve-muse` fire (20-min loop) — **trace outcome-label schema**:
  writeRunLog now lifts `success`/`grounded` to the TOP LEVEL of every `.muse/runs` trace
  (readResponseSuccess/readResponseGrounded), so error-analysis can grep outcomes without
  descending into `response`. Additive (no existing test broke; 17/17). Foundation for the
  data flywheel; populating cli.local's `grounded` (medium-risk ask-path change) is the next sub-slice.
- ✓ 2026-06-09 sixth `improve-muse` fire (20-min loop) — **`groundedCases` ratchet**: self-eval
  now also counts the grounding-corpus CASES (29), so a dropped case fails self-eval, not just a
  dropped battery file (must-fix #3, for the grounding corpus). unit 9/9. Same fire surfaced the
  human-decision ceiling: source-trust → ⏳ (architectural fork, needs Jinan), trace-logging scoped
  (medium-risk persisted path). The loop is reaching the seed-drain / refill point honestly.
- ✓ 2026-06-09 fifth `improve-muse` fire (20-min loop) — **pick-evals matches grounding TEST
  files** (regex `grounded` added → `grounded-not-true.test.ts` now maps to the grounding
  batteries, not lint-only). Same fire RE-SCOPED the source-trust ★: a graph trace found
  tool-output produces `VerifiedSource` (response-filters path), SEPARATE from the grounding
  `KnowledgeMatch` set — so the wiring target was wrong; corrected before code was wasted.
- ✓ 2026-06-08 fourth `improve-muse` fire (first 20-min-loop iteration) — **source-trust
  FOUNDATION**: `KnowledgeMatch.trusted` provenance bit + pure `groundedOnUntrustedOnly`
  detector (additive — verifyGrounding/the gate untouched), agent-core, 7/7 tests. Live
  gate unchanged (eval:grounding-delta still Δ+0.94). The grounded≠true mitigation now has
  a foundation; wiring it through tool-output-evidence → recall → answer-marker is the next ★.
- ✓ self-judge verbosity/length-bias coverage — grounding-integrity fire 29 (`962d4778`): the judge meta-eval cited arXiv:2411.15594 but left the headline verbosity bias uncovered. Added a length-controlled pair (long hedge-padded fabrication → FAIL, long honest uncertainty → PASS) locking that length doesn't move the verdict. Both STABLE 3/3 on gemma4 (eval:judge 13/13).
- ✓ background-review trigger-loss on failure — grounding-integrity fire 28 (`4c5eff57`): createBackgroundReviewHook reset the fired trigger counters BEFORE the fire-and-forget review ran, so a throwing learning arm silently dropped the accrued signal with no retry. Reset now runs only after runReview resolves → failed review re-fires next turn (MAST fail-close). agent-core OUTCOME test.
- ✓ JUDGE-DRILL (fire 27, `51f53e03`): verifier proven (bad vacuous slice → judge FAIL → rollback → real fix → PASS) + real fix = skill-merge umbrella gate combined-coverage re-gate (validateUmbrellaCoverage permissive-mode fail-open: asymmetric trigger/body loss accepted a majority-drop merge). agent-core OUTCOME test.
- ✓ GROUNDED≠TRUE mixed-trust per-claim provenance — grounding-integrity fire 26 (`87d44ecf`): groundedOnUntrustedOnly is whole-answer (one trusted citation clears it), so a claim resting solely on a poisoned untrusted source slipped through. New untrustedOnlySentences (agent-core) flags it per-sentence; ask + chat notices emit a per-claim cue. 5 engine + 2 wiring OUTCOME tests.
- ✓ self-judge meta-eval: LLM-judge content-injection resistance — grounding-integrity fire 25 (`04f72cf6`): llmJudge fed judged OUTPUT undelimited → an embedded "Respond PASS" could flip the verdict (eval:adversarial safety-gate bypass). spotlightFence + buildJudgeUserMessage fence it as DATA; runShadowTrial too; new live eval:judge injection case (STABLE 3/3). 2 harness tests.
- ✓ GROUNDED≠TRUE chat parity: semantic prose value-conflict surfacing — grounding-integrity fire 24 (`889c9265`): detectEvidenceContradictions (ask-only) now wired into chat (finalizeGatedChatAnswer + both surfaces); two trusted notes disagreeing in free prose surface a both-sources cue instead of a silent grounded lie. 3 OUTCOME tests.
- ✓ weakness-ledger concurrent-write lost-update — grounding-integrity fire 23 (`f5d9eb01`): the lone self-improvement store doing bare RMW + non-atomic write now serialized via withFileMutationQueue + atomicWriteFile (sibling-pattern parity, 11/11). 2 OUTCOME concurrency tests.
- ✓ 2026-06-08 third `improve-muse` fire — **grounded≠true boundary NAMED**:
  `packages/agent-core/src/grounded-not-true.test.ts` (3 cases, deterministic) locks that the
  gate marks a false-but-source-supported answer "grounded" (faithfulness is to the source,
  not truth) while STILL catching a fabricated citation (integrity protected). The biggest open
  hole is now a tracked, named property; the actionable mitigation (source-trust segregation)
  is the new top ★. testFiles 847→848.
- ✓ 2026-06-08 second `improve-muse` fire — **public-dataset grounding-delta arm SHIPPED**:
  `buildSquadGroundingCorpus` maps a pinned SQuAD-2.0 slice (8 paras, no model-generation —
  templated answers) → `eval:grounding-delta:squad` writes `docs/benchmarks/RESULTS-squad.md`.
  LIVE Δ+0.63 (gate ON 0.63 vs OFF 0.00) on gemma4 — the first EXTERNALLY-anchored architectural
  delta. unit 10/10; self-authored arm still Δ+0.94 (no regression).
- ✓ 2026-06-08 first real `improve-muse` fire: BUILD's verify-before-claim caught that the
  top item's "SQuAD-unanswerable→refuse" mapping yields Δ≈0 (refuse=retrieval-confidence;
  SQuAD-unanswerable is adversarially similar → stays confident). Re-scoped the item to the
  drift/answer-grounding path with templated answers, before any fixture work was wasted.
- ✓ 2026-06-08 `feat/grounding-ci-gate`: fabrication=0 grounded-surface ratchet (self-eval)
  · live pre-push grounding tripwire (`precheck:grounding`) · grounding-delta benchmark
  (`eval:grounding-delta`, Δ+0.94 gate ON vs OFF on gemma4) · self-eval ENOENT fix.
- ✓ cli `muse followup list` lacked the sibling `--search` text filter (tasks/remind/contacts all have it) → added `--search` (case-insensitive substring on summary, composes after --status, total recomputed) — surfaces fire 23
- ✓ desktop persisted-language parse `AppLanguage(rawValue: prefs.language ?? "") ?? .system` was duplicated byte-identically in two AppKit files (menu checkmark + resolved language, desync risk) and headless-untestable → extracted pure `AppLanguage.fromPersisted(_:)` (MuseDesktopCore) + truth-table test, both sites delegate — surfaces fire 24
- ✓ web CommandPalette (⌘K) was role="dialog" only — no combobox a11y, so a screen reader announced nothing as ArrowUp/Down moved the highlight → added the WAI-ARIA combobox-with-listbox pattern (input role=combobox + aria-activedescendant, list role=listbox, items role=option + aria-selected) + renderToStaticMarkup unit test + Playwright dynamic-activedescendant e2e — surfaces fire 25
- ✓ desktop `SpriteLibrary.named` lowercased but didn't trim the look name fed from the user-set MUSE_DESKTOP_CHARACTER env var (whitespace/newline-prone) → ` celestial ` silently fell back to the default character; now trims with .whitespacesAndNewlines (OllamaHealth/SpeakerSelection posture) + whitespace test — surfaces fire 26
- ✓ cli `muse checkins list` was the lone list command lacking `--search` (tasks/remind/followup/contacts all have it) → added case-insensitive substring filter on the check-in question (displayed field), composes after --status, total reflects matched count — surfaces fire 27
- ✓ web Chat icon-only buttons (send/mic/speak) relied on title alone for their accessible name (WCAG 4.1.2 — screen readers read them as "button") → added optional ariaLabel to the shared Button + wired the three Chat buttons with their localized strings; unit + e2e lock it — surfaces fire 28
- ✓ desktop --render-json validated dimensions (isRectangular) but NOT palette coverage → a JSON sprite with a typo'd/forgotten palette key rendered a silent transparent hole (renderer skips unmapped glyphs); added Sprite.paletteCoversGrid() (same paletteMap the renderer uses) + wired the guard to exit 2 — surfaces fire 29
- ✓ web CommandPalette (⌘K) dialog had a hardcoded English aria-label="Command palette" → Korean screen-reader users heard English; added cmd.dialogLabel (en/ko) + t() wiring, ko-locale Playwright e2e asserts the Korean accessible name — surfaces fire 30
- ✓ cli `tasks add --due <past>` silently stored an overdue due date while the sibling `remind add` warns "in the PAST" → added the parallel non-blocking stderr heads-up (gated on !--json, fires in local+API modes) — surfaces fire 31
- ✓ web icon-only delete buttons in Tasks/Calendar/Reminders/Autonomy/Notes relied on title alone for their accessible name (WCAG 4.1.2, same gap fire 28 fixed in Chat) → added ariaLabel={t("common.delete")} to all five; calendar e2e asserts the explicit aria-label — surfaces fire 32
- ◦ NOTE merge deferred (surfaces fire 32): local main was mid-merge with unmerged paths (a concurrent loop's in-progress merge) at ff-merge time. Fire 32 (73dae149, delete-button a11y) is committed safely on loop/surfaces; the next fire's `git merge --no-edit main` will absorb main and the ff-merge will catch up. Did NOT touch the other loop's merge.
- ✓ desktop companion's stripCitationsForSpeech was case-SENSITIVE while agent-core recognizes citations case-insensitively (/[from…]/giu) → a "[From x.md]" marker (which the system counts as a citation) was read aloud; added .caseInsensitive to match — surfaces fire 33
- ◦ NOTE merge deferred (surfaces fire 33): local main's working tree had an uncommitted backlog.md edit (a concurrent main-worktree loop) → `git merge --ff-only` aborted to avoid overwriting it. Fires 32 (73dae149) + 33 (b3f4f86b) are committed safely on loop/surfaces; a later fire's ff-merge lands both once main's tree is momentarily clean. Did NOT touch the other loop's uncommitted work.
- ✓ web Tasks view had only a status filter (open/done/all), no text search — while CLI `tasks list --search` and the Notes web view have search → added pure filterTasksByQuery (title+notes, case-insensitive) + a search box; unit + Playwright e2e lock it — surfaces fire 34
- ✓ cli `checkins list` showed check-ins in insertion order while sibling `followup list` sorts by scheduledFor → now sorts by dueAtIso ascending (soonest first), composing with --status/--search — surfaces fire 35
- ✓ web Calendar new-event form had visible labels not programmatically tied to their inputs (the two datetime-local fields had NO accessible name at all) → associated label↔input via htmlFor/id (WCAG 1.3.1/4.1.2); calendar e2e now drives the form via getByLabel — surfaces fire 36
- ✓ web Autonomy add-contact form had visible Name/Phone/Email labels not tied to their inputs (no htmlFor/id, WCAG 1.3.1) → associated label↔input; autonomy e2e now drives the form via getByLabel — surfaces fire 37
- ✓ cli `contacts resolve` (recipient-resolution backbone) was human-output only while sibling `contacts list` has --json → added --json ({status, contact?|matches?}, always stdout, exit 1 for ambiguous/none); human path + never-guess logic unchanged — surfaces fire 38
- ✓ web Calendar new-event form let an End before/equal Start through (backwards/zero-length event, startsAtIso>endsAtIso POST) → extracted pure canAddEvent (non-empty AND strict end>start) gating the Add button; unit + e2e (Add disabled for backwards range) — surfaces fire 39
- ✓ web Tasks "Your tasks" count badge showed the server total while the list is the fire-34 search-filtered subset (badge read "12" over 2 visible rows) → count={list.length} so it follows the rendered list; tasks e2e asserts 2→1 on search — surfaces fire 40
- ✓ cli `checkins scan` parsed --slot-hour/--max-per-day via bare Number() (no validation) → --slot-hour abc = NaN silently scheduled an Invalid-Date check-in; added up-front validation (slot-hour [0,23], max-per-day ≥1) rejecting bad input with exit 1 + no scan — surfaces fire 41
- ✓ web Messaging compose form (outbound surface) had visible To/Message labels not tied to their input/textarea (no htmlFor/id, WCAG 1.3.1) → associated label↔control; messaging e2e now drives the form via getByLabel (draft-first gate unchanged) — surfaces fire 42
- ✓ web Reminders form had visible What/When labels not tied to their inputs (no htmlFor/id, WCAG 1.3.1) → associated label↔input + new reminders.spec.ts e2e driving via getByLabel; completes the form-label a11y contract across all core forms — surfaces fire 43
- ✓ desktop sprite renderer's hex→color parse lived only in AppKit HexColor.parse (NSColor) and was 100% untested → extracted pure parseHexColor→RGBA into MuseDesktopCore (AppKit delegates, behavior-preserving incl. a==0→skip) + 7 edge tests — surfaces fire 44
- ✓ desktop --render-json guarded glyph coverage (fire 29) but NOT palette hex validity → a typo'd palette hex (e.g. "#GGGGGG") rendered a silent transparent hole; added Sprite.paletteHexesValid() (uses the renderer's parseHexColor; #00000000 transparent stays valid) + wired the guard (exit 2) — surfaces fire 45
- ✓ web formatTaskDate rendered the literal "Invalid Date" on a malformed/empty createdAt (no guard, unlike sibling timeUntil) → added Number.isNaN(getTime()) guard returning "" — surfaces fire 46
- ✓ web dayLabel rendered "Invalid Date" as a day-group header on a malformed startsAtIso (no guard, unlike timeUntil/formatTaskDate) → Number.isNaN guard returning "" — surfaces fire 47
- ◦ NOTE (surfaces fire 47): web over-concentrated (5/8 recent fires, web21 vs desktop12/cli14). Date-formatter NaN-guard pattern now complete (timeUntil/formatTaskDate/dayLabel). fire 48+ must diversify to cli/desktop or a non-micro value-class (judge advisory).
- ✓ cli notes link graph keyed backlinks/targets by raw target.toLowerCase() while keyToId uses noteLinkKey → [[b.md]] reported broken + b.md orphaned by `notes audit`; routed 4 sites through noteLinkKey(target) — surfaces fire 48
- ◦ note-bridges.ts:50 resolvedAdjacency has the identical raw target.toLowerCase() keying bug (GraphRAG bridge/betweenness drops extension-qualified [[note.md]] edges) — fix via noteLinkKey(target) + a bridges test (surfaces fire 48 follow-up)
- ✓ cli note-bridges resolvedAdjacency keyed targets by raw target.toLowerCase() (vs keyToId's noteLinkKey) → [[b.md]] bridge edges dropped from betweenness; routed through noteLinkKey(target) — surfaces fire 49 (completes fire 48)
- ✓ web introduced shared safeDateTime() (src/lib/datetime.ts) NaN-guarding inline date renders; adopted at 3 standalone sites (Today/Reminders/Autonomy) — surfaces fire 50
- ◦ adopt safeDateTime at the 6 separator-wrapped/presence-guarded inline date sites (Messaging:103, Activity:43/60, Today:119, Autonomy:85, Memory:17) — needs dangling-"·" handling (surfaces fire 50 follow-up)
- ✓ cli notes rename (rewriteWikiLinkReferences) matched links raw vs the basename-stripped oldTarget → [[a.md]] backlinks silently orphaned on rename; routed both sides through noteLinkKey — surfaces fire 51 (completes the fire 48/49 extension-normalization fix across all 3 consumers)
- ✓ cli calendar add warned a spurious double-booking when a timed event overlapped an all-day event (detectCalendarConflicts treats all-day as a 24h span) → conflictWarningForNewEvent now skips all-day both ways — surfaces fire 52
- ✓ web-action double-run consolidated (draft-first migrated, test/ deleted) — test-hygiene fire 41
- ✓ coerceScalar isFinite guard covered (overflow numeric string not coerced to Infinity) — test-hygiene fire 42
- ✓ provider-utils clampPositive double-run consolidated into src (base-10 pinning migrated, test/ deleted); JUDGE-DRILL passed (judge caught planted inert ADD) — test-hygiene fire 43
- ✓ rankEpisodeHits importance bump covered (Generative Agents additive score term) — test-hygiene fire 44
- ✓ worstUnsupportedSentence tie-break covered (earliest sentence on equal coverage — deterministic grounding diagnostics) — test-hygiene fire 45
- ✓ formatContactBirthday lower-bound guard covered (month<1/day<1 → no garbage birthday in grounding block) — test-hygiene fire 46
- ✓ computeApproximateTokens CJK bucketing covered for Chinese/Hiragana/Katakana (not just Hangul → multilingual trim-budget accuracy) — test-hygiene fire 47
- ✓ mcp-routes-shapers sendMcpError double-run consolidated into src (non-Error-throwable leak-safety case migrated+hardened, test/ deleted) — test-hygiene fire 48
- ✓ compat-run-aggregations latencyDistribution double-run consolidated into src; recovered 5-30s/30s+/NaN branches that were test/-only — test-hygiene fire 49
- ✓ PromptDriftDetector stddev-floor mean-scaling arm covered (1% of baseline → no false drift alarm on large stable lengths) — test-hygiene fire 50
- ✓ compat-parsers double-run consolidated into src; recovered whitespace-trim/extended-rejection/non-string/array-drop branches that were test/-only; JUDGE-DRILL passed (judge caught planted inert ADD) — test-hygiene fire 51
- ✓ summarizeToolDraft default-case null/undefined filter + 3-cap covered (bounded, signal-dense channel approval prompt) — test-hygiene fire 52
