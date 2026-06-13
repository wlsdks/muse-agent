# Loop journal — GROUNDING INTEGRITY & SELF-IMPROVEMENT RELIABILITY

> Theme: ① grounded≠true ceiling (poisoned/untrusted source → confident "grounded" lie) redteam + deterministic defense · ② self-improvement subsystem (playbook/reflection/weakness-ledger/background-review) reliability+coverage · ③ self-judge meta-eval (maker=judge compensating control) hardening.
> Worktree `/tmp/muse-grounding-integrity` (branch `loop/grounding-integrity`). Tier1.5 — local commit + merge to LOCAL main when green, NEVER push. Convention: [README](README.md).

## fire 1 · 2026-06-13 · skill v1.14.0 · c09f3465
meta: value-class=redteam-defense · pkg=@muse/agent-core+@muse/cli · kind=A · verdict=PASS · firesSinceDrill=1
ratchet: cli tests +3 cases (2558 pass) · agent-core suite pass · lint 0/0 · fabrication 0 · grounding floor intact (additive warning only)
- 무엇: dead `groundedOnUntrustedOnly` 완화를 `muse ask` verdict 경로에 wiring — faithful이지만 untrusted-only(MCP/web tool output, `trusted:false`) 출처에만 근거한 답에 provenance 경고를 surface. 함수는 agent-core index에 re-export조차 안 돼 있던 죽은 코드(프로덕션 호출자 0).
- 왜: grounded≠true 천장의 한 벡터를 닫음 — source veracity는 고정 로컬모델로 알 수 없으나 source TRUST(provenance bit)는 알 수 있고, 그걸 사용자에게 노출해 추가 검증을 유도.
- 리뷰지점: `commands-ask.ts` verdict 경로 — 라벨은 "grounded" 유지(답은 faithful), stderr 경고만 추가. `!verdictNotice && imageAttachments===0` 가드로 already-ungrounded/vision 경로 불변. 독립 Opus judge가 5개 적대 체크 전부 PASS.
- 리스크: tool 출처 citation 형식(`[from tool: X]`)이 실제 모델 출력과 어긋나면 프로덕션 발화율이 낮을 수 있음 — 단위테스트는 함수 계약을 고정하지만 e2e 발화율은 후속 `eval:grounding-delta`로 측정 필요(backlog 후보로 기록).

## fire 2 · 2026-06-13 · skill v1.14.0 · 0a38b477
meta: value-class=reliability-coverage · pkg=@muse/autoconfigure · kind=B · verdict=PASS · firesSinceDrill=2
ratchet: autoconfigure distill-queue +2 tests (4 pass) · lint 0/0 · fabrication 0 · mutation-verified non-vacuous (RATCHET: fire1=redteam-defense/agent-core+cli → fire2=reliability-coverage/autoconfigure, diversified)
- 무엇: 무인 distill-consumer(`distillQueuedCorrections`)의 두 안전 불변식을 OUTCOME 테스트로 고정 — dud(빈 correction)·fail-soft(distiller undefined) 둘 다 큐에서 drain(잼 방지) + zero 전략 기록(비-corrective 신호는 교훈 날조 안 함). 소스는 이미 정확(`doneIds.push`가 두 가드보다 앞), 무방비였던 보장을 보호.
- 왜: 매 idle tick 도는 무인 소비자라 잼이면 같은 dud를 영원히 재처리, fence가 뚫리면 비-correction에서 가짜 lesson 생성 — Muse edge가 의존하는 류의 불변식인데 테스트 0이었음.
- 리뷰지점: 실제 파일-백드 큐/playbook 스토어(enqueueLearnEvent/readPendingLearnEvents/readPlaybook) 위 OUTCOME; test1의 distill은 throw 주입(빈 이벤트가 distill 전에 fence됨을 증명). mutation(drain을 가드 뒤로 이동)→test red→revert로 비-공허성 증명, 독립 Opus judge가 자체 mutation 2종으로 재확인 PASS.
- 리스크: 테스트-only 슬라이스(소스 무변경) — 회귀 가드 가치이지 신규 동작 아님. pnpm check 전체는 단일 테스트파일 변경엔 불비례라 패키지 빌드+테스트+lint로 대체.

## fire 3 · 2026-06-13 · skill v1.14.0 · 7401e84c
meta: value-class=redteam-defense · pkg=@muse/cli · kind=A · verdict=PASS · firesSinceDrill=3
ratchet: cli +4 tests (80 pass; full suite 2570 pass) · lint 0/0 · fabrication 0 · mutation-verified non-vacuous (RATCHET: fire1=redteam-defense/agent-core+cli, fire2=reliability-coverage/autoconfigure, fire3=redteam-defense/cli — value diverse, every-surface parity)
- 무엇: fire 1의 untrusted-only provenance 경고를 CHAT 표면으로 확장. `finalizeGatedChatAnswer`(모든 대화 표면의 공유 post-stream 파이프라인)가 tool 출력을 trust 표시 없이 evidence로 접었던 blind spot을 닫음 — toolEvidence에 `trusted:false` 태깅 + `untrustedOnlyChatNotice`(ask의 untrustedOnlyGroundingNotice의 chat parity) 추가/wiring.
- 왜: wedge가 "every surface gated"인데 ask만 방어돼 있었음 — chat이 오염된 MCP/web 출처에만 근거한 답을 plain "grounded"로 넘기던 정확히 그 벡터. `trusted:false` 태깅은 발화 여부와 무관한 상시 provenance 정확성 개선.
- 리뷰지점: 순수 additive — gate 결정/receipt/fabrication=0 floor 불변(judge가 .trusted를 gate가 안 읽음 확인), abstention/no-info는 경고 안 함. mutation(헬퍼 무력화)→경고케이스 red→revert로 비-공허 증명, 독립 Opus judge PASS(full suite 2570 pass).
- 리스크: cue 발화는 답이 tool 출처를 `[from <src>]`로 인용해야 함 — ask와 동일 caveat이라 prod 발화율은 제한적(judge가 honest하게 지적). 표면 parity + 상시 provenance 태깅은 실가치. e2e 발화율은 기존 backlog ◦(fire 1)에 chat도 포함해 추적.

## fire 4 · 2026-06-13 · skill v1.14.0 · 0b77bfe8
meta: value-class=redteam-defense · pkg=@muse/agent-core · kind=C · verdict=PASS · firesSinceDrill=4
ratchet: agent-core +2 tests (14 pass; full suite 1954 pass) · lint 0/0 · fabrication 0 · red-without-fix verified (RATCHET: A·B·A·C — 4축 모두 커버, value diverse)
- 무엇: judge-게이트 두 표면(`verifyCouncilGrounding`·`verifyReflectionsGrounding`)의 **fail-OPEN 버그 수정** — evidence가 빈 문자열인데도 judge를 호출하고 YES면 claim을 KEEP하던 것을, 빈 evidence면 judge 호출 없이 결정론적 fail-close(council→null, reflection→skip).
- 왜: 이 두 표면은 `verifyGroundingWithReverify`와 달리 결정론적 rubric 사전-게이트가 없어 judge가 유일 게이트 — "" evidence에 YES는 직접 fabrication-floor 누수(근거 0인 synthesis/dream이 검증 통과). 둘 다 프로덕션 도달 가능(contributor reasoning 공백 / cited sourceId 미해결).
- 리뷰지점: 순수 강화 — 이전에 keep 가능하던 claim만 drop, 더 keep 안 함; judge-NO/error fail-close 경로 불변. red-without-fix(main에서 2테스트 실패)로 실재 버그 증명, `expect(judge).not.toHaveBeenCalled()`로 no-call 계약까지 고정. 독립 Opus judge 5/5 PASS.
- 리스크: 없음 수준(strictly 강화). 후속: council/reflection은 recall과 달리 k-sample self-consistency 없음(단일 judge 호출) — ENHANCEMENT로 별도 fire 후보(backlog).

## fire 5 · 2026-06-13 · skill v1.14.0 · d7326a29
meta: value-class=reliability-coverage · pkg=@muse/mcp · kind=B · verdict=PASS · firesSinceDrill=5
ratchet: mcp +1 test (6 pass; full mcp 1812 pass) · lint 0/0 · fabrication 0 · red-without-fix verified (RATCHET: A·B·A·C·B — value/pkg diverse, mcp 첫 진입)
- 무엇: learn-queue의 **lost-update 버그 수정** — `markLearnEventsDone`(read-modify-write 전체 파일 재작성)과 `enqueueLearnEvent`(appendFile)이 둘 다 mutex 없이 동작 → drain 중 append된 correction이 clobber. 둘 다 공유 `withFileMutationQueue`(file-키)로 감싸 직렬화.
- 왜: learn-queue는 사용자 correction을 백그라운드 distill로 나르는 substrate — 유실 = 진짜 교훈이 무인 경로에서 조용히 영영 학습 안 됨(에러도 없이). peer 스토어(playbook/action-log)는 이미 이 primitive 사용, learn-queue만 누락돼 있었음.
- 리뷰지점: **markDone만 wrap하면 불완전**(enqueue의 appendFile이 mutex 우회) — 둘 다 같은 file-키로 감싸야 직렬화. judge가 partial fix가 여전히 red임을 경험적으로 재확인. 테스트는 promise-chain 순서로 결정론적(fs 타이밍 의존 아님), red-without-fix 증명, 독립 Opus judge 5/5 PASS(mcp 1812/autoconfigure 548/api 668 무충돌).
- 리스크: 없음 수준(외부 계약 불변, 데드락 없음 — 중첩 mutex 호출 없음).

## fire 6 · 2026-06-13 · skill v1.14.0 · e373114c
meta: value-class=reliability-coverage · pkg=@muse/agent-core · kind=C · verdict=PASS · firesSinceDrill=6
ratchet: agent-core +4 tests (18 pass; full suite green) · lint 0/0 · fabrication 0 · red-without-fix verified · floor strictly stronger (RATCHET: A·B·A·C·B·C — 3축 균형, 패키지 4종)
- 무엇: council/reflection judge 게이트에 **k-sample self-consistency** 추가 — recall(verifyGroundingWithReverify)은 이미 단일-judge variance를 k-샘플 만장일치로 방어하는데 이 두 self-improvement 표면만 단일 호출이었음. opt-in `reverifySamples?`([1,5], 기본 1=불변) + judgeConsensus 재사용, synthesize* options에서 threading.
- 왜: 단일-judge intra-rater variance(arXiv:2510.27106 "Rating Roulette") — borderline synthesis/reflection이 flaky YES 한 번에 장기 메모리로 승격. recall이 막던 그 구멍의 미방어 sibling. backlog ◦(fire 4 scouted) 해소.
- 리뷰지점: recall 패턴 byte-exact 미러(clamp [1,5], first-NO short-circuit, judgeConsensus empty→false). 기본 1이면 동작 불변(14 기존 테스트 green), fire-4 empty-evidence fail-close가 샘플 루프 앞에 보존. floor는 STRICTER만(k>1이 k=1보다 더 keep하는 경로 없음). 독립 Opus judge 5/5 PASS.
- 리스크: 없음 수준(opt-in, 기본 불변). 후속: 실제 호출자가 reverifySamples>1을 켜는 wiring은 별도(현재는 capability만 노출, recall처럼 호출부가 정책으로 켬).

## fire 7 · 2026-06-13 · skill v1.14.0 · 075bbc2d
meta: value-class=redteam-defense · pkg=@muse/recall · kind=A · verdict=PASS · firesSinceDrill=7
ratchet: recall +10 tests (full recall 111+ pass) · lint 0/0 · fabrication 0 · mutation-verified + judge-flagged FP hardened in-fire (RATCHET: A·B·A·C·B·C·A — pkg 5종, recall 첫 진입)
- 무엇: **evidence↔evidence 모순 감지 primitive** 신규 — 전 스택이 claim↔evidence만 보고 두 출처가 같은 필드에 다른 값을 줘도(옛/새 wifi 비번 등) 하나를 깔끔한 receipt로 자신만만하게 인용. `detectSourceConflict`+`formatSourceConflictWarning`(@muse/recall, pure, no-model, hot-path 가능).
- 왜: grounded≠true의 미커버 벡터 — 기존 `muse notes conflicts`는 batch+model 의존(라이브 경로 아님). 결정론적 hot-path 감지가 빈 자리.
- 리뷰지점: `label: value` 추출 + cross-hit 다른 값 flag(같은-hit 내 중복은 제외, case/whitespace 정규화로 일치는 안 flag). **judge가 흔한 prose 접두사(Note/TODO/Summary)·시각(9:30) 오발 지적 → 같은 fire에서 denylist+숫자-끝 label 제외로 hardening**(오발 테스트 2개 추가). mutation(stub→[])로 비-공허 증명, 독립 Opus judge PASS.
- 리스크: primitive-first(detector+formatter만, receipt site 호출은 미연결). v1 regex는 comma/period에서 값 절단(부분 false-negative, 허용). 후속: receipt site wiring + e2e CLI 테스트(backlog ◦).

## fire 8 · 2026-06-13 · skill v1.14.0 · 7d6f0071
meta: value-class=redteam-defense · pkg=@muse/recall+@muse/cli · kind=A · verdict=PASS · firesSinceDrill=8
ratchet: recall +3 tests (13 pass) · cli 2584 pass · lint 0/0 · fabrication 0 · NEXT FIRE = JUDGE-DRILL (연속 allPASS 8 도달) (RATCHET: A·B·A·C·B·C·A·A — pkg 5종 유지)
- 무엇: fire 7 conflict detector를 **라이브 ask 경로에 wiring 완성** — `groundingConflictCue(notes,episodes)`(recall, pure, 답을 뒷받침한 grounding을 합성) 추가 + commands-ask 비-JSON 분기에서 `scored`+`episodeHits`로 cue 계산해 stderr emit. primitive→실제 사용자 surface(진짜 OUTCOME)로 fire 7 가치 완결.
- 왜: detector가 존재·테스트됐지만 호출이 0이라 모순 출처가 여전히 사용자에게 하나의 깔끔한 receipt로 도달했음 — wiring이 그 갭을 닫음.
- 리뷰지점: `--connect` 무관(안전 cue), conflict 있을 때만 발화(fire 7 hardening이 prose/시각 오발 차단), stdout/--json 불변. 합성은 recall에서 단위테스트(note-note + note-vs-episode cross-source), CLI glue는 thin emit. 독립 Opus judge 5/5 PASS(cli 2584 green).
- 리스크: 없음 수준(conflict 없으면 무출력). chat 표면 동일 wiring은 후속(현재 ask만).

## fire 9 · 2026-06-13 · skill v1.14.0 · 70814c0a (JUDGE-DRILL + real fix)
meta: value-class=redteam-defense · pkg=@muse/recall+@muse/cli · kind=A · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: recall +2 tests (15 pass) · cli 2591 pass · lint 0/0 · fabrication 0 · JUDGE-DRILL 통과 (RATCHET: A·B·A·C·B·C·A·A·A — pkg 5종)
- JUDGE-DRILL(연속 allPASS 8 도달): 고의 나쁜 슬라이스 주입 — detectSourceConflict를 `return []`로 무력화(capability 제거/floor 회귀) + 그걸 못 잡는 inert 테스트(`toBeDefined()`만, 빈 배열도 통과). inert 테스트는 무력화된 detector에도 green 통과(위험 상태 재현). 독립 Opus judge가 **VERDICT: FAIL** — inert 테스트 vacuous + detector 무력화 + 실제 테스트 red 될 것까지 정확히 적발. → verifier가 8연속 green에 무뎌지지 않았음 증명(maker≠judge 보상통제 작동). 드릴 아티팩트 git restore 롤백(clean 확인).
- 진짜 fix: fire 8의 conflict cue를 **chat 표면으로 확장**(every-surface parity) — `conflictCueFromMatches(matches)`(recall, KnowledgeMatch형→hits) + finalizeGatedChatAnswer에서 사용자 자신의 grounding(args.matches)에 적용해 모순 시 답에 append. ask(fire8)+chat 둘 다 이제 모순 표면화.
- 리뷰지점: conflict 있을 때만 append(fire7 hardening이 오발 차단), gate 결정/untrusted cue/receipt 불변. 합성은 recall 단위테스트, CLI glue는 thin append. 독립 Opus judge 5/5 PASS(cli 2591 green).
- 리스크: 없음 수준. v1 regex comma-truncation false-negative는 여전(허용). chat도 ask와 동일 caveat.

## fire 10 · 2026-06-13 · skill v1.14.0 · 9c7d9b0a
meta: value-class=reliability-coverage · pkg=@muse/mcp · kind=B · verdict=PASS · firesSinceDrill=1
ratchet: mcp +2 tests (9 pass; full mcp 1835 pass) · lint 0/0 · fabrication 0 · isolated-mutation verified (RATCHET: A·A·A→B 다양성 복귀, pkg mcp)
- 무엇: reflections 스토어(무인 dreaming) cap trim을 **insertion-order→createdAtMs(recency)**로 수정. `listReflections`는 newest-first by createdAtMs인데 trim은 `slice(length-MAX)`(삽입 순서)라 cap이 표시 순서와 불일치 — backfill/out-of-order 배치가 더 새로운 insight를 evict하고 stale 유지.
- 왜: 무인 학습-상태 위생 — 모순된 eviction은 grounded 자기지식을 조용히 잘못 버림. 단 현재 단일 호출자는 monotonic ts라 그 경로로는 오늘 미발현 → 공개 @muse/mcp 스토어에 monotonicity 계약 없어 ANY-writer hardening(judge가 정직히 caveat). floor 아님, learned-state hygiene.
- 리뷰지점: `[...].sort(desc by createdAtMs).slice(0,MAX)` newest N 유지, over-cap에서만 작동(under-cap 불변), listReflections 재정렬하므로 저장순서 무관. backfill 테스트가 isolated insertion-order mutation에서만 red(1/9)로 trim 로직 격리 증명, 독립 Opus judge 5/5 PASS(mcp 1835 green).
- 리스크: 없음 수준(persistence-only, 절대 fabricate 안 함). 단순 hardening(라이브 버그 아님)이라 가치는 중간.

## fire 11 · 2026-06-13 · skill v1.14.0 · ebdd8a7c
meta: value-class=redteam-defense · pkg=@muse/agent-core · kind=C · verdict=PASS · firesSinceDrill=2
ratchet: agent-core +2 tests (62 pass; full suite green) · lint 0/0 · fabrication 0 · isolated-removal verified · floor STRICTER (RATCHET: B→C 다양성, agent-core)
- 무엇: **주 grounding 게이트의 empty-evidence fail-OPEN 수정** — `verifyGroundingWithReverify`(recall/ask/chat 재검증)가 high-cosine+empty-text 매치(confidence>0, evidence="")에서 coverage 밴드가 judge를 ""로 호출, YES면 fabricated 답을 grounded로 승격. f4가 council/reflection에 닫은 구멍이 *메인 게이트*엔 열려 있었음. evidence 비면 base가 grounded 아닌 한 judge 호출 없이 ungrounded fail-close.
- 왜: classifyRetrievalConfidence는 confidence를 cosine로만 산정(text 무시) — 빈 텍스트 매치가 confidence=1을 받아 escalation 밴드 진입. wedge(주 게이트)의 fabrication-floor 직접 누수라 이번 세션 최고가치.
- 리뷰지점: `evidence.trim()===0 && base.verdict!=="grounded"`만 단축(grounded base는 value 밴드로 — demote만 가능, refusal 오강등 방지). non-empty 경로 byte-불변. guard 격리 제거 시 empty 테스트만 red(1/62), judge-not-called까지 고정. 독립 Opus judge 5/5 PASS(full suite green).
- 리스크: 없음 수준(strictly tighten, fail-close). council/reflection·recall 세 곳 모두 이제 empty-evidence fail-close 일관.

## fire 12 · 2026-06-13 · skill v1.14.0 · 6cb7ac7d
meta: value-class=redteam-defense · pkg=@muse/autoconfigure · kind=A · verdict=PASS · firesSinceDrill=3
ratchet: autoconfigure +6 tests (581 pass) · lint 0/0 · fabrication 0 · isolated-mutation verified · floor STRICTER (RATCHET: C→A, pkg autoconfigure 재방문이나 다른 표면)
- 무엇: ambient "Related:" brief enricher의 **CRAG margin 가드 fail-open 수정** — `createKnowledgeEnricher`가 `classifyRetrievalConfidence([top])`로 단일 매치만 넘겨 runnerUp=0 → flat-distribution(near-tie 모호성) 가드 영구 무력화. 0.57/0.56 near-tie도 confident로 daily brief에 surface. `selectEnricherLine` 순수 헬퍼로 추출해 full post-exclusion candidates를 classify.
- 왜: 형제 proactive 경로는 full matches로 margin 체크하는데 이 표면만 diverge — 라이브 brief에 모호한 recall이 confident처럼 올라타는 grounded≠true fail-open. createKnowledgeEnricher→daemon→situational-briefing 경로로 도달.
- 리뷰지점: 등가 리팩터(candidates[0]==기존 find, classify 내부 정렬로 순서 무관), confident/none 동일, near-tie만 추가 억제. `[top]` mutation 시 near-tie 테스트 2개만 red(2/6)로 격리 증명. 독립 Opus judge 5/5 PASS(581 green).
- 리스크: 없음 수준(strictly tighten — clear-lead/single은 영향 없음). over-reach 없음 확인.

## fire 13 · 2026-06-13 · skill v1.14.0 · 21de01e6
meta: value-class=redteam-defense · pkg=@muse/cli · kind=A · verdict=PASS · firesSinceDrill=4
ratchet: cli +5 tests (85; full cli 2598 pass) · lint 0/0 · fabrication 0 · isolated-mutation verified · floor STRICTER (vein thinning — scout 정직 보고)
- 무엇: chat sync 게이트에 **date-drift 가드 추가** — IP/number/email/identifier 가드는 있는데 date 무방비. `valueNumbers`가 월/일(1-2자리)을 버리고 year만 봐서 same-year drift(노트 2026-09-13 vs 답 2026-09-14)가 통과. `answerAssertsUnsupportedDate`(ISO만, leading-zero 정규화, citation strip)를 number 가드 앞에 wiring.
- 왜: 잘못된 일정/갱신/마감 날짜는 고위험 verbatim 값 클래스인데 유일하게 무방비였음(IP 가드와 동일 클래스). chat은 sync 설계라 결정론적 가드 필요.
- 리뷰지점: **false-refusal≈0 보수 설계** — evidence에 ISO 날짜가 있을 때만(like-for-like) drift 플래그, prose 날짜("September 14")는 건드리지 않음. ISO-only로 slash M/D vs D/M 모호성 회피. always-false mutation 시 drift 테스트만 red, always-true 시 14개 red(양방향+게이트레벨 faithfulness 고정). 독립 Opus judge hard-case false-refusal 안전성 검증 PASS.
- 리스크: 없음 수준(strictly tighten, prose-date false-negative는 의도적 허용). vein thinning — grounding fail-open 대부분 닫힘.

## fire 14 · 2026-06-13 · skill v1.14.0 · 46cde4ee
meta: value-class=new-capability(paper) · pkg=@muse/agent-core · kind=A · verdict=PASS · firesSinceDrill=5
ratchet: agent-core +5 tests (citation-precision; full suite 2054 pass) · lint 0/0 · fabrication 0 · existence-only mutation verified · vein-thin → 논문-피벗
- 무엇: **ALCE per-citation support precision**(arXiv:2305.14627) 신규 — Muse는 citation 존재(enforceAnswerCitations)와 union-evidence groundedness만 봤지 *그 문장이 인용한 그 출처가 그 문장을 지지하나*(right source/wrong claim)는 안 봤음. `reportCitationPrecision`(pure, [from src] 마스킹 후 문장별로 인용 출처에만 token-coverage). 진단 only.
- 왜: bug-hunting vein이 얇아져 loop의 "논문-근거 우선" 절로 피벗 — 공개 arXiv 메커니즘 중 Muse에 없는 것(per-citation support)을 자체 재구현. union-coverage가 놓치는 cross-source 오인용까지 잡음.
- 리뷰지점: U+E000 sentinel로 `vpn.md`의 "." 문장분리 버그 회피(이스케이프 \u{E000}로 byte-hygiene clean), sentinel 인덱스는 토큰화 전 strip(실수 1380 오인 안 됨). 진단 only로 게이트 불변. existence-only mutation 시 support 테스트 red로 기존 메커니즘과 구별 증명. 독립 Opus judge 5/5 PASS.
- 리스크: 없음(additive, pure, no gate change). 후속: reportCitationPrecision를 ask/chat 진단 또는 게이트에 wiring(backlog ◦).

## fire 15 · 2026-06-13 · skill v1.14.0 · bb2fafa9
meta: value-class=wiring(paper-OUTCOME) · pkg=@muse/cli · kind=A · verdict=PASS · firesSinceDrill=6
ratchet: cli +3 tests (commands-ask-grounding-verdict; full cli 2613 pass) · lint 0/0 · fabrication 0 · stub mutation verified
- 무엇: fire 14의 ALCE `reportCitationPrecision`를 **라이브 ask 경로에 wiring** — `citationPrecisionNotice`가 인용 출처가 resolve되지만 그 문장을 안 지지하는 "맞는 출처/틀린 주장"을 stderr cue로 표면화. verdictAnswer+scoredMatches로 계산, grounded일 때만(!verdictNotice), 기존 untrusted/conflict cue 옆.
- 왜: fire 14 진단을 실제 사용자 OUTCOME으로 완결(backlog ◦). per-citation support는 whole-answer verdict가 놓치는 클래스 — provenance-trust(untrusted)·evidence-vs-evidence(conflict)와 구별되는 distinct 축.
- 리뷰지점: precision<1일 때만 발화(fire14 floor 체크), supported/uncited는 silent. gate 결정/floor/--json 불변, 순수 delegation. stub mutation 시 warn 테스트 red. 독립 Opus judge 5/5 PASS(cli 2613 green).
- 리스크: 없음(additive stderr cue). 발화는 답이 [from X] 인용을 달아야 함(ask/chat 공통 caveat). chat 표면 wiring은 후속 가능.

## fire 16 · 2026-06-13 · skill v1.14.0 · d4c92334
meta: value-class=new-capability(paper)+wiring · pkg=@muse/agent-core+@muse/cli · kind=A · verdict=PASS · firesSinceDrill=7
ratchet: agent-core +5, cli +3 tests (agent-core 2078, cli 2616 pass) · lint 0/0 · fabrication 0 · citable=false mutation verified
- 무엇: **ALCE citation RECALL**(arXiv:2305.14627) — fire15 precision의 보완. groundable한 주장(증거 union에 ≥floor 커버)인데 `[from]` 인용이 없는 "uncited-but-citable" 문장을 잡음. `reportCitationRecall` 순수 모듈 + `citationRecallNotice` ask 경로 wiring(grounded만, stderr, additive).
- 왜: precision="인용 출처 맞나", recall="groundable 주장이 다 인용 다나" — sentence-groundedness는 citation-agnostic이라 못 잡던 누락 attribution. precision/recall/groundedness triad 완성.
- 리뷰지점: U+E000 sentinel 마스킹(멀티닷 source·2자리 카운터 검증), citable 문장만 분모(일반 주장은 recall miss 아님). 높은-overlap recommendation 오발 위험 있으나 비-게이팅 stderr cue라 허용(judge 확인). citable=false mutation으로 recall 테스트 red 증명. 독립 Opus judge 5/5 PASS.
- 리스크: 없음(additive, 진단 only). **vein 상태: grounding triad 완성 → 결정론적 fail-open vein 사실상 고갈. 다음 fire는 value-class 피벗 권고**(예: precision/recall를 muse doctor 추적 메트릭으로, 또는 retrieval-quality/다른 축). backlog ◦에 기록.
