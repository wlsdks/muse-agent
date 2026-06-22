# Loop journal — recall-spine

Theme: 개인 기억/회상 비서(golden path) 강화. 진안이 척추로 선택 (2026-06-22).
Two tracks: 능력 C↑ (회상이 맞는 기억을 꺼내 정확히 인용 + GROUNDED≠TRUE 메모리 방어 + 충돌/멀티홉) · 응집도 C+↑ (golden-path 명령만 남기고 루프-생성 명령 감사 · god-file commands-ask.ts 해체).
Cron `ffe5773d` (every 20m, session-only, Tier1 no-push). Worktree `/tmp/muse-recall-spine`, branch `loop/recall-spine`.

---

## fire 1 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=new-capability · pkg=scripts(eval-harness) · kind=eval-new · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +1 (eval-recall-quality.test.mjs, picked up by `self-eval:test`) · fabrication 0 · NEW gate `eval:recall-quality` (live baseline **3/7 = 43%**, pass^3)

- **무엇**: 측정-먼저 슬라이스 — `scripts/eval-recall-quality.mjs` (개인 USER-MEMORY 회상 golden-set) + zero-dep `scripts/eval-recall-quality.test.mjs` (scorer teeth) + `package.json` `eval:recall-quality` 등록. 노트 배터리(verify-cited-recall/verify-multihop)가 안 다루는 두 차원을 새로 측정: (1) 한국어 USER-memory(사실/선호/목표) (2) 교정-인지 temporal(stale 과거값 vs 현재값 → 현재값이 이겨야, 정체성 "교정하면 잊음"). production `rankKnowledgeChunks→classifyRetrievalConfidence`를 실제 로컬 임베딩으로 구동, Ollama-down 시 loud skip.
- **왜**: 척추의 회상 능력 숫자를 아무도 몰랐다(스코어보드는 케이스 개수만 래칫). 이제 숫자가 있다.
- **리뷰 지점 (핵심 발견)**: 라이브 baseline = **3/7**. 직접 사실 회상 4건이 전부 `"ambiguous"`로 **under-recall** — 갖고 있는 사실인데 confidence bar(cosine 0.55, 노트용 calibration)를 못 넘어 "잘 모르겠어"로 회피. correction(현재값 승리) + abstain ×2는 PASS. 냉정 진단의 "거짓말 대신 거절로 faithfulness를 산다"의 하드 데이터. **fire 2 후보**: 짧은 개인-기억 항목용 confidence bar 재보정(또는 hit@1을 confidence와 분리 측정).
- **리스크**: eval이 positive를 `confident` 요구로 채점 → "맞게 검색했지만 abstain"도 miss로 잡힘(의도된 보수성; under-recall은 유저가 체감하는 실패). fire 2에서 hit@1(top이 맞았나)을 confidence와 분리하면 갭의 원인(검색 실패 vs 확신 실패)을 더 정밀히 가를 수 있음.
- 검증: `node --test` 8/8 GREEN + MUTATION 3분기 RED 확인(독립 ④b judge가 재현) · live pass^3 3/7 · scripts/*.mjs는 eslint ignore라 lint 게이트 영향 없음 · 독립 Opus ④b judge PASS(비중복·teeth·정직한 측정 확인).

## fire 2 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=new-capability(diagnostic) · pkg=scripts(eval-harness) · kind=eval-new · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +0 (same file, +5 tests = 13 total) · fabrication 0 · eval:recall-quality diagnostic NEW — retrieval hit@1 **5/5**, triad under-confidence **4/5**

- **무엇**: fire 1의 43% 원인을 귀속(attribute)하는 진단을 eval에 추가 — 순수 헬퍼 `scoreRecallHit1`(retrieval hit@1, confidence 무시) + `classifyRecallOutcome`(positive를 confident-correct/under-confidence/wrong-entry/confident-wrong 4갈래) + main 진단 출력. production 코드 무수정(eval/test only). 게이트 suite 불변(headline 3/7 유지, 진단은 non-gating).
- **왜**: 확신 바를 건드리기 전에 "검색 실패 vs 확신 부족"을 가려야 fire 3가 엉뚱한 곳을 안 고친다(측정-먼저).
- **리뷰 지점 (결정적 발견)**: 라이브 진단 = **retrieval hit@1 5/5**, triad = confident-correct 1 · **under-confidence 4** · wrong-entry 0 · confident-wrong 0. → 43%는 **100% under-confidence**: 랭커는 맞는 기억을 매번 top-1로 찾는데, cosine 0.55 바(노트용 calibration)가 짧은 KO 기억엔 너무 높아 게이트가 abstain. **fire 3 타겟**: @muse/agent-core `recall-confidence.ts` 바를 짧은 메모리용으로 재보정(단 absent 케이스 abstain 유지 = fabrication 플로어 검증 필수).
- **리스크**: 재보정은 fabrication-floor-sensitive — 바를 낮추면 absent 케이스가 confident-wrong로 샐 수 있음. fire 3는 반드시 absent abstain을 pass^k로 동시 검증. ④b judge 비차단 메모: diversify 경로 top-1=최고 cosine, fallback 경로 top-1=최고 fused-RRF — hit@1 ≠ (confident-correct+under-confidence) 어긋나면 이 경로 차이부터 확인.
- 검증: `node --test` 13/13 GREEN + MUTATION 4분기 RED(독립 ④b judge가 재현) · live gate 3/7 불변 + 진단 hit@1 5/5 · production 무수정(git diff = +60 .mjs / +32 .test only) · 독립 Opus ④b judge PASS.
- **다양성 메모**: fire 1·2 모두 (scripts, eval-new) — ratchet(6/8) 미발동이나 fire 3는 반드시 다른 (pkg,kind)로: @muse/agent-core recall-confidence 재보정(kind=calibration/memory-defense).

## fire 3 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=planning(decompose) · pkg=docs(backlog) · kind=decompose · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +0 · fabrication 0 (untouched — refused to guess the floor) · finding-only fire

- **무엇**: fire 2가 가리킨 confidence-바 재보정을 착수하기 전, cosine 분포를 측정(일회성 probe). DECOMPOSE-ON-DEFER로 fabrication-sensitive·>1-fire 항목을 안전 슬라이스 3a/3b/3c로 쪼개 backlog 기록. 코드 행동 변경 없음(docs/backlog only).
- **왜**: 바(`DEFAULT_CONFIDENT_AT=0.55`)는 곧 fabrication=0 플로어. 7개 데이터로 상수를 낮추면 absent 1건만 새도 거짓말 → 도박 금지. 측정-먼저 + 안전 우선.
- **리뷰 지점 (결정적 발견)**: max-cosine(게이트가 쓰는 값) positives **0.34–0.56** vs absents **0.20–0.28** — 분리되나 margin ~0.06로 얇음. 진짜 원인: clear-match가 0.34–0.47인데 주석은 "~0.61"로 calibrated → **0.55 바는 옛 임베더(nomic-embed-text)용이고 디폴트가 v2-moe로 바뀌며 cosine 스케일이 낮아졌는데 바가 안 따라감**(stale·too-high). 부수 관찰: correction 케이스는 matches[0](부산 0.466)≠max-cosine(서울_old 0.556) — 게이트 confident는 max-cosine(stale 엔트리) 때문, 제시는 current. ④b judge의 diversify top-1 메모가 실재 확인됨 — 3b에서 "confidence가 제시 엔트리 기준인가"도 점검할 것.
- **리스크**: 3b(바 변경)는 반드시 absent abstain을 pass^k로 동시 검증. 큰 N(3a) 없이 상수 변경 금지.
- lesson: fabrication-critical 임계값(confidence 바 등)은 작은 N(여기 7)으로 재보정하지 말 것 — 먼저 calibration-grade 데이터셋을 키우고(3a), 변경 시 negative(abstain) 케이스 전수가 pass^k로 유지되는지 동반 검증. 작은 측정이 "바가 틀렸다"는 입증엔 충분해도 "새 바가 안전하다"는 입증엔 불충분.
- **다양성 메모**: fire 1·2는 (scripts, eval-new), fire 3은 (docs, decompose) — kind 전환 완료. fire 4(3a)는 scripts/eval로 복귀하나 3b는 반드시 agent-core/calibration로.

## fire 4 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=new-capability(dataset) · pkg=scripts(eval-harness) · kind=eval-new · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +0 (same files, +3 tests = 15) · fabrication 0 · eval:recall-quality 7→24 cases (live 43%→63%; hit@1 14/16)

- **무엇**: 슬라이스 3a — golden set을 7→24 케이스로 확장(positive 16 KO+EN facts/prefs/goals + correction 2쌍, absent 8), corpus 8→22. calibration-grade 분포 확보(3b 안전 보정의 전제). scorer 무변경(fires 1-2에서 이미 judged). dataset-integrity 테스트 +3(size floor ≥16 pos/≥8 absent, 두 correction쌍 stale 유지).
- **왜**: fire 3 lesson — fabrication-critical 바는 작은 N으로 못 고친다. 3b 전에 분포를 키워야 안전.
- **리뷰 지점 (새 실패 모드)**: live 15/24(63%), hit@1 14/16, triad = confident-correct 7 · under-confidence 7 · **confident-wrong 2**. 7케이스에선 confident-wrong=0이었는데 24케이스가 **숨은 confident-wrong 2를 노출** — Muse가 틀린 기억(stale `_old`)을 자신만만하게 회상(abstain보다 나쁨). → 보정은 단순 "바 낮추기"가 아니라 precision/recall 양면. **fire 3의 안전 판단 확증**: 7케이스로 바 낮췄으면 confident-wrong 늘려 거짓말 출하. 3b는 under-confidence(7)를 줄이되 confident-wrong(2)를 안 늘리는 보정이어야(아마 margin 기반 + correction recency).
- **리스크**: confident-wrong 2건은 correction 케이스(stale가 current 압도) 의심 — 3b/충돌회상(슬라이스 3) 둘 다와 연결. eval:recall-quality는 standalone(CI 게이트 아님)이라 63%가 다른 게이트를 깨지 않음.
- 검증: `node --test` 15/15 GREEN + MUTATION(size guard) RED · live 15/24 + 진단 · production 무수정(데이터/테스트만) · 독립 Opus ④b judge PASS(8 absent 전부 unanswerable·16 positive resolve·correction teeth·confident-wrong 진짜 측정 확인).

## fire 5 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=finding(no-ship) · pkg=@muse/agent-core · kind=calibration · verdict=NO-SHIP(rolled back) · firesSinceDrill=5
ratchet: testFiles +0 · fabrication 0 (floor untouched — change reverted) · finding: 24-case max-cosine distribution + blast-radius

- **무엇**: 슬라이스 3b 시도 — `classifyRetrievalConfidence`에 margin-based PROMOTION(바 아래라도 강한 margin top은 confident). 측정: 24-case max-cosine positives 0.32–0.70 vs absents 0.20–0.35가 OVERLAP(min-pos 0.318 < max-absent 0.346) → 단일 임계값 분리 불가, 그러나 margin은 분리(absents ≤0.113). 구현+테스트했으나 **롤백**.
- **왜 롤백**: blanket 변경이 `classifyRetrievalConfidence`(공유 게이트)를 건드려 **기존 테스트 10개 깨짐**(proactive-recall/council/notes가 옛 임계값 의존). ④b 정신상 "무관 state 손상" → 안전 규약대로 git restore 롤백(main 추적 파일도 복원+재빌드). fabrication 플로어 무손상.
- **리뷰 지점**: 좋은 자체-발견 2건 — (1) caller가 바를 RAISE한 경우 promotion이 undercut하는 fail-safe 위반을 테스트가 잡아 `mayPromote = confidentAt <= DEFAULT` 가드 추가; (2) 결정적 게이트(vitest 10 fail)가 blast-radius를 잡음 = 게이트가 작동. 분포/margin 데이터는 backlog 3b에 영구 기록.
- **리스크/다음**: 3b는 OPT-IN으로 재스코프 — memory-recall 경로만 `promoteOnMargin` 옵션 전달, proactive/council/notes 불변. 다음 fire가 그 버전.
- lesson: 공유 게이트(classifyRetrievalConfidence 등)의 행동 변경은 절대 blanket로 하지 말 것 — 먼저 caller를 sibling-audit(grep)해 blast-radius를 보고, 신호 변경은 OPT-IN 옵션으로 호출 경로별 격리. measure-first가 "값"은 줬지만 "공유 함수라는 사실"을 sibling-audit로 먼저 확인했어야 구현 전에 OPT-IN 설계를 했을 것(구현→10 fail→롤백 토큰 낭비 회피).

## fire 6 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=new-capability · pkg=@muse/agent-core · kind=calibration · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +1 (recall-confidence.test.ts, 11 cases) · fabrication 0 · eval:recall-quality 63%→75% (under-confidence 7→4)

- **무엇**: 슬라이스 3b OPT-IN 재구현 — `classifyRetrievalConfidence`에 `promoteOnMargin?: boolean`(기본 off). on이면 바 아래 top이라도 floor(0.45)+margin(0.15) 충족 시 confident로 승격, 단 caller가 바를 RAISE했으면 억제(fail-safe). memory-recall 경로만 opt-in(eval solve가 켬), proactive/council/notes는 기본 off로 불변.
- **왜**: fire 5 blast-radius(공유 게이트 blanket 변경이 10 테스트 깨뜨림)를 opt-in으로 격리 해소. under-confidence(맞는 기억인데 abstain)를 fabrication 안 늘리고 rescue.
- **리뷰 지점**: live 63%→75%(+3 rescue), triad confident-correct 7→10·under-confidence 7→4·confident-wrong 2(불변)·absents 전부 abstain. 게이트는 아직 75%<85%: 남은 4 under-confidence는 0.45 floor 아래(더 어려움), confident-wrong 2는 correction 케이스(stale가 current 압도 — 슬라이스 3/conflict 영역). 다음: production memory-recall 호출부에 promoteOnMargin 배선(eval이 값 증명, 배선이 남은 슬라이스).
- **리스크**: 상수(0.45/0.15)는 이 골든셋 분포 기반 — 더 큰 calibration 셋(3c, muse doctor --calibration)으로 재확인 권장. confident-wrong은 promotion이 바 위에서만 안 건드려 불변(논리적으로 보장).
- 검증: agent-core 전체 **2621 passed/0 failed**(기본 off가 fire 5의 10 깨짐 포함 전부 보존) · `node --test`/vitest 11 cases + MUTATION 4분기 RED · live 18/24 + absents 전수 abstain · 독립 Opus ④b judge PASS(300k-case fuzz로 default-off 바이트 등가 증명, 두 가드 독립 차단, fail-safe 올림/내림 바 정확).

## fire 7 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=planning(audit+decompose) · pkg=docs(backlog) · kind=command-consolidation · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0 · fabrication 0 · 응집도 트랙(C+) 첫 진입(이전 6 fire는 전부 능력 트랙)

- **무엇**: 두 발견 + 트랙-2 감사. (a) fire 6의 `promoteOnMargin` production 배선 대상 조사 → `classifyRetrievalConfidence` 호출부가 전부 notes/knowledge/council/proactive로, **별도 개인-memory recall 호출부 없음**(user-fact는 cosine 게이트 아닌 build-memory-context-block 경로). (b) 응집도 트랙 감사: **102개 command 모듈**, 골든패스 온전, 정리 후보(benford/diversity/keywords/trend/latency/analytics — 테스트 0) 식별. backlog에 C+a/C+b 슬라이스 기록.
- **왜**: 6 fire 동안 능력 트랙만 돌아 트랙-2(응집도) 진척 0 → 다양성 RATCHET상 다른 (pkg,kind)로 전환 필요. 측정-먼저로 정리 worklist를 결정론적으로 확보.
- **리뷰 지점**: 트랙-2 실작업(명령 hide·god-file 분해)은 behavior-preserving 검증에 cli 테스트(deps)가 필요해 격리 worktree에서 싸게 검증 불가 — **메인-레포 검증 fire**여야 한다(이 박스 worktree는 per-package node_modules 없음). promoteOnMargin 배선도 깨끗한 memory 타겟 없어 공유 knowledge-recall 경로 변경 = notes 검증 필요(별도 슬라이스).
- **리스크**: commands-ask.ts는 동시 루프도 만져 merge 충돌 위험 → 추출 전 main churn 확인. 인라인 fire가 worktree-deps 한계로 수확체감 — 트랙-2/배선은 cron 자율(full 검증 가능 컨텍스트)에 적합.
- lesson: worktree-격리 루프는 zero-dep(node:test) 또는 단일-패키지(agent-core) 슬라이스에 강하고, cross-package/cli/Ollama 검증이 필요한 슬라이스엔 약하다 — 테마 슬라이스 풀을 짤 때 검증 가능성(worktree vs 메인-레포 vs Ollama)을 (pkg,kind)와 함께 분류해 고르면 헛스핀을 줄인다.

## fire 8 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=new-capability · pkg=@muse/recall · kind=recall-conflict · verdict=PASS · firesSinceDrill=8
ratchet: testFiles +0 (conflict.test.ts +5) · fabrication 0 · confident-wrong 대응(stale 데모션)

- **무엇**: `detectStaleMarker` + `demoteStaleHits` (@muse/recall conflict.ts) — 명시적 과거/철회 마커(예전에/지금은 아니/used to/no longer/not anymore/formerly)가 붙은 기억을 현재값 아래로 안정-정렬. correction 케이스(stale `_old`가 current 압도 = fire 4/6의 confident-wrong)에서 현재값이 top-1이 되게. 순수·무손실(데모션, 드롭 아님).
- **왜**: confident-wrong 2가 남은 회상 품질 최악 갭(abstain보다 나쁜 자신만만한 틀린 회상). detectSourceConflict는 `label: value`만 파싱해 prose형 correction을 못 잡음 → 직교적 lexical 신호로 보완.
- **리뷰 지점**: ④b judge가 5개 false positive 적발(더 이상="no further"·previously=중립·었었=구어 이중과거) → 약한 마커 제거해 conservative high-precision으로 좁히고 그 입력들을 negative 테스트로 고정. 내 correction 케이스는 강한 마커(예전에+지금은 아니/used to+not anymore)로 여전히 잡힘. **UNWIRED** — production 회상 경로 배선은 후속(promoteOnMargin과 동일 패턴).
- **리스크**: 미배선이라 라이브 영향 0. 배선 시 conservative 마커라 false-positive 데모션 위험 낮음(놓침=데모션 안 함, 항목은 그대로 노출). cross-package 검증은 main이 동시 루프發 transient build 깨짐이라 narrow vitest(conflict.test만)로 검증 — 32/32.
- lesson: maker가 "high-precision"이라 주장해도 ④b가 실제 false-positive 입력을 뽑아 검증 — 주장 라벨이 아니라 적대적 입력으로 정밀도를 강제하고, 그 입력을 negative 테스트로 박아 회귀 방지.
