# Loop journal — `paper-grounded`

Theme: 논문-근거 차별화 기능 강화 — Muse의 고유 엣지(deterministic grounding/citation 게이트 ·
RGV rubric verifier · Playbook/RL-flavored strategy memory · whetstone metacognition)를 한 fire에
하나씩 STRENGTHEN하고 라이브/결정론 배터리로 PROVE한다. grounded-surface 카운트는 절대 안 떨어진다.

Worktree `/tmp/muse-paper-grounded` · branch `loop/paper-grounded-features` (Tier2: push, 사람이 머지) ·
cron `f969ae76` (15m, session-only). 매 fire ⓪에서 `git fetch origin && git rebase origin/main`로
작업 전 main 최신을 땡긴다. 규약: [README](README.md).

---

## fire 1 · 2026-06-20 · skill v1.14.0 · b415f08f
meta: value-class=wiring · pkg=@muse/agent-core,@muse/recall,@muse/cli · kind=grounding-gate-calibration · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1054→1056 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · precheck:grounding recall-citation-gate 2/2 + rubric-reverify 2/2 PASS, faithfulness-rate SKIPPED(box >150s 타임아웃 — pass 아님)
- 무엇: RGV recall 게이트(verifyGrounding / classifyRetrievalConfidence)가 하드코딩 DEFAULT_CONFIDENT_AT=0.55에 묶여 conformal-캘리브레이션 임계값 `MUSE_GROUNDING_MIN_COSINE`를 무시하던 것을 — chat 게이트와 동일한 순수 resolver를 추가하고 recall 진입점(commands-ask 단일홉/--repair/--why · @muse/recall verdict+chunks)에 threading. 옵트인·fail-safe(누락/무효 env면 무변화).
- 왜: muse doctor --calibration이 emit하는 캘리브레이션 임계값을 chat은 존중하는데 recall은 무시 → monitor(conformal)→remediate(gate) 루프가 주 grounded 표면에서 끊겨 있었음. KnowNo conformal coverage(arXiv:2307.01928) 출력을 게이트에 배선해 닫음. 차별화 엣지 (a)fabrication=0 floor + (b)RGV verifier STRENGTHEN, 가법적(표면 카운트 불변).
- 리뷰지점: resolver parse가 chat-grounding.ts와 정확히 일치(분기 없음, fallback 상수만 0.55 vs 0.5). 독립 judge가 chunks.ts threading revert→ent 테스트 RED로 mutation faithfulness 실증. verdict.ts threading은 동일 resolver 재사용이나 전용 mutation 테스트는 없음(기존 recall 328 그린이 가드).
- 리스크: 낮음 — 캘리브레이션 값을 낮게 set하면 cosine 확신-프레이밍 바가 내려갈 수 있으나 chat 게이트와 동일 계약이고 결정론 citation 게이트가 하드 백스톱이라 fabrication 유입 불가.

## fire 2 · 2026-06-20 · skill v1.14.0 · 1ee899bf
meta: value-class=new-capability · pkg=@muse/cli · kind=whetstone-misgrounding-chat-parity · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1056 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · eval:self-improving 28/28 PASS (라이브 misgrounding 배터리 포함) · precheck:grounding recall-citation-gate 2/2 + rubric-reverify 2/2 PASS, faithfulness-rate SKIPPED(box >150s 타임아웃 — pass 아님)
- 무엇: whetstone misgrounding 축(GROUNDED≠TRUE)을 CHAT 표면에 기록. chat은 신호를 계산만(유저 cue 렌더)하고 weakness ledger에 안 쓰던 것을 — ASK의 동일 primitive(stripCitationMarkers→reportSentenceGroundedness→assertiveUnsupportedFraction→misgroundedOutcome [0.5,1) band)를 재사용한 순수 helper(chatMisgroundingFraction·chatWeaknessAxis)로 분류해 chat-repl이 non-refusal 답의 misgrounding row를 기록. precedence unbacked-action>misgrounding>grounding-gap.
- 왜: misgrounding 루프가 ASK에만 닫혀 있고 가장 많이 쓰는 chat 표면엔 blind였음 — 차별화 엣지 (d)whetstone metacognition을 새 표면으로 확장. 가법적(기존 WeaknessAxis·DEV_FIXABLE_AXES·muse doctor 파이프라인이 이미 소비, 새 sink 없음). ALCE 인용정밀도(arXiv:2305.14627) + Memp 증거-게이트 ledger(arXiv:2508.06433).
- 리뷰지점: 독립 judge가 misgrounding 분기 비활성→positive 2 테스트 RED, `<1` 상한 widen→cross-lingual negative RED로 mutation faithfulness 실증. ledger STATE(weaknesses.json) 직접 검증, spy 아님. fraction==1.0(cross-lingual)은 grounded 유지.
- 리스크: 낮음 — chat misgrounding 신호는 lexical-only(cross-lingual semantic re-judge 없음)라 heavily-paraphrased-but-faithful EN 답이 token coverage [0.5,1)면 false misgrounding 로깅 가능. 단 fuel-only(유저 비노출·verdict 불변)이고, 이를 스트레스할 faithfulness-rate 배터리는 box env-stall로 skip이라 박스에선 미검증.

## fire 3 · 2026-06-20 · skill v2.0.0 · (rolled back — no code commit)
meta: value-class=bug-fix-with-capability · pkg=@muse/mcp · kind=playbook-eviction-PEVI-parity · verdict=FAIL(rolled back) · firesSinceDrill=3
ratchet: testFiles 1055 · fabrication 0 · groundedSurfaces=28 (no drop) · 게이트(build/check/self-eval/lint) 전부 green이었으나 ④b 적응형 judge가 의미 결함 적발
- 무엇: Playbook eviction(bank 오버플로 생존 결정)이 raw point-estimate reward로 정렬 → 검증된 전략을 thin-lucky 전략이 파괴적으로 evict하는 버그를 고치려 inline `evictionUtility` 추가. 빌드/테스트/mutation-first(정렬키 revert→새 테스트 RED) 모두 통과했으나 — ④b 독립 Opus judge가 FAIL.
- 왜(FAIL): inline `evictionUtility`가 `effectiveStrategyReward`(shrinkage 점추정 `(2·pHat−1)·MAX·n/(n+3)`)를 복제했는데, 실제 injection/ranking 경로(`rankPlaybookStrategies`/`rankPlaybookStrategiesByRelevance`)는 `rankingUtility`(Wilson LCB `(2·lower−1)·MAX`)를 씀. 두 함수가 다름 → eviction↔injection이 여전히 불일치(judge가 3085쌍 불일치 + thin 1/0이 proven 11/9를 evict하는 구체 사례 실증). 슬라이스가 *틀린 parity 함수*를 복제해 주장한 버그를 못 고침. 게이트는 green인데 의미가 틀린 "green-but-wrong".
- 리뷰지점: ④b 적응형 적대 judge가 결정적 게이트가 못 잡는 의미 결함을 잡음 — maker≠judge + adaptive judge의 정확한 작동 사례. 기존 테스트(thin 5/1 vs proven 4/40)는 두 parity 함수 모두에서 통과해 구별 불가였던 게 근본 원인.
- 리스크: 롤백으로 main/브랜치에 결함 미반입(녹색이지만 틀린 코드 차단). 
- lesson: Playbook eviction parity는 `effectiveStrategyReward`(shrinkage)가 아니라 `rankingUtility`(Wilson LCB, playbook.ts:383)를 복제해야 한다 — injection이 *실제로* 랭킹하는 함수와 맞춰라. parity 슬라이스엔 두 후보 함수를 구별하는 판별 테스트(thin 1/0 vs proven 11/9: shrinkage면 thin 생존, Wilson이면 proven 생존)를 반드시 포함. "green 게이트 ≠ 옳음" — 의미 parity는 적응형 judge로만 잡힘.

## fire 4 · 2026-06-20 · skill v2.0.0 · 65a12bc9
meta: value-class=bug-fix-with-capability · pkg=@muse/mcp · kind=playbook-eviction-PEVI-parity · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1057 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · mcp 1869 PASS(+Wilson 판별 테스트) · check apps/cli 2762 PASS · mutation-first RED 확인 · eval:self-improving SKIPPED(박스 stall, 미완료 — pass 아님; 단 deterministic eviction의 진짜 게이트는 mcp 유닛 스위트라 충분)
- 무엇: Playbook bank-overflow eviction(retainPlaybookEntries)이 raw point-estimate reward로 생존 결정하던 것을 — injection 경로(rankPlaybookStrategies)가 쓰는 것과 동일한 Wilson-LCB(PEVI)로 정렬. inline wilsonLower+(2·lower−1)·MAX가 agent-core wilsonInterval+rankingUtility와 byte-faithful(mcp는 agent-core 의존 불가). no-tally는 clampReward(reward)로 fallback(레거시 불변).
- 왜: thin-but-lucky 전략(1승/0패, wide CI)이 검증된 전략(11/9, tight CI)을 파괴적으로 evict하던 eviction↔injection 불일치를 닫음. fire 3이 틀린 함수(effectiveStrategyReward shrinkage) 복제로 롤백된 것을 올바른 함수로 교정. PEVI 비관주의 arXiv:2012.15085.
- 리뷰지점: 독립 적응형 judge가 9개 (r,d) 삼중쌍으로 evictionUtility vs rankingUtility 6자리까지 동일·순서 동일 실증, fire-3 shrinkage 공식 주입→판별 테스트 RED 확인(이번 테스트는 fire 3이 빠뜨린 판별력 보유). raw-reward mutation도 RED. fire 3과 같은 (mcp, playbook-eviction-PEVI-parity)지만 fire 3은 롤백(미출하)이라 모노컬처 아님.
- 리스크: 낮음 — parity가 패키지 경계 hand-mirror라 agent-core rankingUtility 변경 시 silent drift 가능. 후속 backlog ◦: cross-package parity 테스트(같은 r,d → 양쪽 동일 utility)로 drift 차단.
