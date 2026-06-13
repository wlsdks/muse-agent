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
