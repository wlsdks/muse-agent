# Loop journal — self-improvement

**Theme:** hermes-style self-improvement machinery — Playbook (strategy memory,
RL-style reward↑/decay) · whetstone (weakness ledger) · Skill authoring ·
Reflection/dreaming · memory consolidation (Mem0-style). Strengthen + PROVE each,
keeping the grounding floor (fabrication=0) intact.

**Autonomy:** Tier1.5 — dedicated branch `loop/self-improvement` in a /tmp
worktree; each fire commits locally and syncs from LOCAL main (rebase) to stay
conflict-free; **every 3 fires FF-merges into LOCAL main** (진안 directive). Hard
floor: NO push, NO remote auto-merge, NO force, NO `--no-verify`.

**Cadence:** session cron `0b48bb96`, 20 min. **Stop:** `CronDelete 0b48bb96` or cmux.

**Surfaces & packages:** `@muse/mcp` (playbook/whetstone stores) · `@muse/agent-core`
(reflection, playbook ranking) · `@muse/memory` (consolidation/decay) · `@muse/skills`
(authoring/curate). Live battery: `pnpm eval:self-improving` (LLM merge/preference/pattern
paths) + `pnpm eval:agent` (judge/shadow-trial) when those are touched.

---

## fire 1 · 2026-06-20 · skill v2.0.0 · `1b9d31a7`
meta: value-class=micro-fix · pkg=@muse/mcp · kind=correctness/RL-ranking · verdict=PASS · firesSinceDrill=1
ratchet: testFiles=1057 (tests added to existing file) · fabrication 0 · gates: mcp 35/35 + check (saturation-only timeouts, clean in isolation) + self-eval ok + lint pass · eval:self-improving N/A (deterministic store, no LLM path)

- **무엇:** `retainPlaybookEntries` bank-overflow eviction을 raw point-estimate `reward`
  정렬 → PEVI Wilson-LCB `retentionUtility`(inline-replicated `rankingUtility`) 정렬로
  교체. no-tally는 `clampReward(reward)`로 byte-identical 폴백.
- **왜:** injection 경로(`rankingUtility`, Wilson LCB)와 생존 랭킹이 불일치 → thin-but-lucky
  전략이 battle-tested 전략을 파괴적으로 evict (PEVI arXiv:2012.15085 edge c). paper-grounded
  fire 3이 `effectiveStrategyReward`(shrinkage) 잘못 복제로 롤백된 그 항목의 corrected fix.
- **리뷰지점:** mcp는 의도적으로 agent-core 무의존(자체 REWARD_MIN/MAX) → import 아닌 inline-
  replicate가 정답. 판별 테스트(thin 1/0 reward=5 vs proven 11/9 reward=1, cap=1)는 old에서
  RED("thin" 생존) → new에서 GREEN("proven"). ④b 독립 Opus judge가 올바른 함수 복제(util
  proven −1.58 vs shrinkage +0.43로 구분)·산수·1870 통과 확인.
- **리스크:** 낮음 — 결정론적 store 로직, 공개 API 무변경, retentionUtility는 file-private,
  4개 레거시 retain 테스트 byte-identical. recency discount는 미적용(time-free, index tie-break
  유지 — `rankingUtility` nowMs-undefined 형태와 동일).
- **형제-감사:** raw-reward eviction sort는 이 한 곳뿐(injection 경로는 이미 rankingUtility) — clean.

## fire 2 · 2026-06-20 · skill v2.0.0 · `7b22ce7f`
meta: value-class=wiring · pkg=@muse/cli (+@muse/mcp) · kind=whetstone learn→apply / DRY-unify · verdict=PASS · firesSinceDrill=2
ratchet: testFiles=1057→1058 (new chat-weakness-nudge.test.ts) · fabrication 0 · gates: mcp 1872 + cli 2766 + check EXIT=0 ALL packages clean + self-eval ok + lint pass

- **무엇:** chat의 하드코딩 repeat-weakness nudge를 공유 `askTimeWeaknessNudge` + 추출한
  `renderAskTimeNudge`(단일 axis-aware KO/EN 문구)로 통일. ask는 byte-identical 리팩터,
  chat은 `chatRepeatWeaknessNudge`(ledger 읽기→선택→렌더)로 교체.
- **왜:** 기존 chat nudge는 이번-턴 refusal에서만·이번-턴 count로·grounding-gap "노트 추가"만
  하드코딩 → **source-conflict 재조정 힌트 불가 + mastery 억제 불가**. ask는 이미 공유 헬퍼 사용 →
  chat을 parity로 끌어올리고 두 표면 문구 drift 차단 (N1 follow-up).
- **리뷰지점:** ④b 독립 Opus judge가 **md5로 ask 4문구 byte-identity 확정** + 행동 델타(ledger
  기반 발화=ask와 동일 의도적 parity) 안전 + misgrounding 제외 보존 + lazy-import 불변식 + mutation
  RED 재현. chat은 @muse/mcp를 runtime `await import`(bun 바이너리), 타입만 `import type`.
- **리스크:** 낮음 — 결정론적, recordChatWeaknessForTurn 양 분기 불변(부작용 동일), fail-close(throw→
  no nudge). nit: chat이 grounded 성공 시 recordWeaknessResolved 안 함(ask는 함) → 닫힌 gap이 BKT
  mastery까지 계속 nudge (backlog ◦ NEXT로 등록, 범위 밖·기존 공유-ledger 속성).
- **형제-감사:** ask/chat 두 point-of-use 표면 모두 이번에 공유 헬퍼로 수렴 — recap은 별도 selectVolatileBeliefs 경로(무관).

## fire 3 · 2026-06-20 · skill v2.0.0 · `b801ab88`
meta: value-class=new-capability · pkg=@muse/memory · kind=consolidation/decay · verdict=PASS · firesSinceDrill=3
ratchet: testFiles=1058 (tests added to existing recall-promotion.test.ts) · fabrication 0 · gates: memory 456 + check EXIT=0 ALL clean + self-eval ok + lint pass

- **무엇:** `selectForgettable`에 `importanceHitsFloor`(default 8) 추가 — 평생 recall hit이 floor
  이상인 기억은 idle+decayed여도 fade 후보에서 제외. AND-결합(후보 제거만, 더 공격적 망각 불가).
- **왜:** fade가 recency-DECAYED score(hits×2^(-age/half))만 봐서, 평생 자주 recall됐지만 최근 idle한
  기억이 거의 안 쓰인 기억처럼 fade됨 — lifetime frequency(importance) 무시. MemoryBank(arXiv:2305.10250)의
  frequency-consolidation = 자주 쓰인 기억은 strength가 굳어 Ebbinghaus decay 저항.
- **리뷰지점:** ④b 독립 Opus judge가 **배선 end-to-end 확인**(manual `memory consolidate` + daemon tick
  → consolidationPlan → selectForgettable, persistFade 사이드카까지) · 산수 RED-before/GREEN-after(established
  hits10 score0.19≤0.25라 구코드선 fade됐음) · 비순환(raw hits는 decayed score와 다른 새 정보) · 무회귀(기존
  hits8 케이스는 score 필터에서 이미 제외). 다양성: fire1 mcp/RL · fire2 cli/wiring → fire3 memory/consolidation.
- **리스크:** 낮음 — non-destructive(fade는 report), AND-결합 안전, default 8은 reasoning-set(튜닝 ◦는 다른
  consolidation 상수들과 함께 미해결). 형제-감사: selectPromotableMemories는 minHits+minScore+score랭킹이라
  "lifetime frequency 무시" 결함 없음 → fade-only가 옳음(half-fix 아님).
## fire 4 · 2026-06-20 · skill v2.0.0 · `9f2f484b`
meta: value-class=wiring · pkg=@muse/cli · kind=whetstone resolve-parity · verdict=PASS · firesSinceDrill=4
ratchet: testFiles=1061→1062 (new chat-weakness-resolve.test.ts) · fabrication 0 · gates: cli 2771 + check EXIT=0 ALL clean + self-eval ok + lint pass · merge-to-main: n/a (fire 4 ≠ ×3; next at fire 6)

- **무엇:** chat의 grounded-success 경로에 weakness RESOLVE 배선 — 새 순수 `isChatGroundedSuccess`(matches>0 ∧ axis null) + `chatResolveWeakness`(lazy, best-effort) → `recordWeaknessResolved`(BKT mastery). ask의 `recordAskWeaknessResolvedLive`와 패리티.
- **왜:** ask는 grounded 성공 시 약점을 resolve해 nudge를 멈추는데 chat은 record만 하고 resolve를 안 해서, 한 번 막혔던 토픽이 이후 성공해도 계속 nudge. fire-2 ④b judge nit를 닫음.
- **리뷰지점:** ④b 독립 Opus judge가 **no-false-resolve 견고**(refusal/misgrounding/unbacked/무-evidence 전부 제외, mutation으로 matches 가드 load-bearing 확인) + ask 패리티 충실+더 엄격(matches>0 추가 → 오탐 더 적음) + record/resolve 상호배타(axis null vs non-null) + 동일 raw message 키 + BKT 단일스텝은 0.95 mastery에 못 미쳐 안전. 다양성: fires=(mcp,RL)·(cli,wiring)·(memory,consolidation)·(cli,wiring) — (cli,wiring) 2/4, 임계(6/8) 미만 OK.
- **리스크:** 낮음 — 결정론적 술어, ledger-only 쓰기(finalResponse 불변), fail-close(throw→무동작). nit(judge): isChatGroundedSuccess의 unbackedAction 인자는 호출부서 항상 false(무해, 술어 self-contained 유지).
- **defer 기록:** validateSkillToolReferences(애초 fire-4 후보)는 Skill에 구조화된 tool 필드가 없어 휴리스틱 추출이 shell명령/식별자를 오탐→유효스킬 거부하는 UNSOUND. 선결=skill contract에 tool-참조 관례 추가. 배선 site(autoconfigure:850, toolRegistry 보유)는 준비됨. backlog에 블로커 기록.

## fire 5 · 2026-06-20 · skill v2.0.0 · `1bde1536`
meta: value-class=micro-fix · pkg=@muse/cli · kind=whetstone doctor-UX · verdict=PASS · firesSinceDrill=5
ratchet: testFiles→1064 (new doctor-weakness-labels.test.ts) · fabrication 0 · gates: cli 2773 + check EXIT=0 ALL clean + self-eval ok + lint pass · merge-to-main: n/a (fire 5 ≠ ×3; next at fire 6)

- **무엇:** user-facing `muse doctor --weaknesses`(`formatWeaknesses`)가 source-conflict·misgrounding을
  raw 키로 노출하던 걸 친화 라벨 추가로 해소 (WEAKNESS_AXIS_LABEL에 2개 엔트리). G1 RESIDUAL 닫음.
- **왜:** 두 축은 ledger에 실제 WRITTEN인데 라벨 맵에 없어 `?? axis` fallback으로 "misgrounding" 원시
  키가 사용자에게 그대로 보임 — 자기-보고 UX 흠.
- **리뷰지점:** ④b 독립 Opus judge PASS — purely additive(기존 라벨/fallback 불변), 두 축 모두 실제
  WeaknessAxis member·WRITTEN 확인, OUTCOME 테스트(친화 라벨 렌더+raw 키 누출 없음)·mutation RED 검증.
  형제-감사: formatDevFixableWeaknesses는 dev-facing이라 raw axis 의도적 유지(half-fix 아님, judge 동의).
- **리스크:** 매우 낮음 — display-only, 데이터/게이트 불변, fabrication 무관.
- **vein 신호:** self-dev 쉬운 결정론 vein이 thinning — 남은 고가치는 대형/블록드(T2-c memory-promotion
  recall-count 선결, T3-d self-fork review, reflection-dedup corpus 튜닝). 다음 fire는 다른 (pkg,kind)
  또는 그 대형 항목 decompose 권장. 다양성: fires=(mcp,RL)·(cli,wiring)·(memory,consolidation)·(cli,wiring)·(cli,micro-fix).

## fire 6 · 2026-06-20 · skill v2.0.0 · `8b12d589`
meta: value-class=new-capability · pkg=@muse/memory · kind=consolidation/promote-spacing · verdict=PASS · firesSinceDrill=6
ratchet: testFiles=1064 (tests added to existing recall-promotion.test.ts) · fabrication 0 · gates: memory 473 + check EXIT=0 ALL clean + self-eval ok + lint pass · merge-to-main: fires 4-6 (this fire, ×3)

- **무엇:** `selectPromotableMemories`에 ACT-R spacing 가드(`minDistinctAccessDays`, default 2) — per-access 이력 있는 레코드는 ≥2 distinct 날에 recall돼야 always-on 페르소나로 승급. legacy(recentAccessMs 없음)는 skip.
- **왜:** 기존 promote 필터는 hits+score만 봐서 한 세션 burst(같은 날 5회)가 durable 입증 없이 페르소나 오염. ACT-R 분산학습(Anderson & Schooler 1991): massed ≠ durable. fire-3 fade frequency-floor의 PROMOTE-side 형제(쌍 완성: fade는 established 보호, promote는 burst 배제).
- **리뷰지점:** ④b 독립 Opus judge PASS — 무회귀(전 ACT-R 테스트 레코드 ≥2 distinct days, NOW=UTC자정이라 off-by-one 없음, mutation으로 spacedOk load-bearing 검증) · false-negative은 영구차단 아닌 DEFER(judge가 store FIFO cap=20 edge까지 시뮬: 후일 접근이 eligibility 복원) · 양 caller(daemon tick + commands-memory promote)로 default 도달 · 확장/재정렬 없음 · PromotedMemory shape 불변.
- **리스크:** 낮음 — only removes burst candidates(non-destructive), legacy short-circuit 보장. nit(judge): personal-recall-hits-store cap=20과의 좁은 edge(1 early-day + 20 same-later-day → distinct 1로 collapse)는 그 자체가 massed라 spacing 신호 약함 — 허용.

## fire 7 · 2026-06-20 · skill v2.0.0 · (scout — no code)
meta: value-class=scout · pkg=n/a · kind=exhaustion-assessment · verdict=SCOUT · firesSinceDrill=6
ratchet: testFiles=1064 · fabrication 0 · gates: self-eval ok (no code change) · merge-to-main: n/a (fire 7 ≠ ×3)

- **무엇:** 실패 연료 0(.muse/runs 없음) + 쉬운 결정론 self-dev vein thinning 판단 → 3번째 스카웃으로
  토큰 안 태우고(EXHAUSTION 규칙) 최고가치 대형 항목 T3-d를 정밀 평가 → **MISFIT/STALE로 reassess**(backlog ⊘).
- **왜(발견):** T3-d "제안 memory/skill 쓰기 verifyGrounding" — (a)SKILL 절반: 스킬 드래프트는 의도적
  일반화라 faithfulness-judge가 유효 일반화 오탐(validateSkillToolReferences와 동일 unsound 클래스),
  이미 constraint+risk-scan 게이트됨. (b)MEMORY 절반: background-review에 memory-제안 arm 자체가 없음
  (skill arm + commitments arm뿐, commitments는 이미 draft-first/사람-확인). hermes 패턴 가치가 Muse엔
  이미 구조적으로 충족 → as-written 클린 윈 아님.
- **리뷰지점:** 6 fire 동안 self-dev 4표면 중 Playbook(1)·whetstone/cli(2,4,5)·memory-consolidation(3,6)
  생산적이나 thinning; reflection/dreaming은 성숙(코드 읽음, 깨끗한 결정론 슬라이스 적음, 나머지 corpus-튜닝);
  skill-authoring은 구조화 tool-필드 prerequisite. 남은 고가치는 design-heavy/corpus/blocked.
- **리스크/권고:** 가짜 일감 만들지 않고 정직 종료. 진안 옵션: (1)테마 repoint(예: orchestration/recall
  -quality 같은 다른 축) (2)corpus-튜닝 슬라이스 허용(reflection-dedup/episodic-threshold를 real-embed
  측정으로) (3)cron 그대로 두고 저수율 수용. 루프 자체는 건강(6 fire PASS·2 머지·회귀0).
- **lesson:** self-improvement 테마의 쉬운 결정론 vein은 ~6 fire에서 thinning; "스킬에 grounding/faithfulness
  게이트"는 반복 misfit(스킬=일반화≠grounded claim) — 다음 루프가 같은 함정 피하도록 증류.

## fire 8 · 2026-06-20 · skill v2.0.0 · `b467b9c3`
meta: value-class=new-capability · pkg=@muse/agent-core (+@muse/cli wiring) · kind=research-grounded/self-consistency-write-gate · verdict=PASS · firesSinceDrill=7
ratchet: testFiles=1064 (tests added to existing correction-distiller.test.ts) · fabrication 0 · gates: agent-core 2512 + cli(격리 통과, check 단일실패=chat-ink-render 포화-timeout 40/40 격리 GREEN) + self-eval ok + lint pass · eval:self-improving=라이브 배터리(결정론 코어는 unit-proven; LOCAL OLLAMA skip≠pass)

- **무엇(연구-기반, 진안 "우리만의 방법 연구"):** `distillConsistentStrategy` — 전략을 ONE 생성이 아니라 k=3 드래프트로 뽑아 **AGREE할 때만**(mean Jaccard ≥0.5) medoid를 bank. 불안정(불일치=환각성) 자기개선은 안 씀. `distillSessionCorrections`에 default-on 배선.
- **왜:** 기존 distill은 단일 생성이라 support/verbatim 게이트를 통과해도 one-off 추측일 수 있음. self-consistency(conformal abstention arXiv:2405.01563 + ReasoningBank MaTTS 2509.25140)를 **WRITE 경로**에 적용 — fabrication=0 floor를 read→learning-write로 확장(우리만의 적용; selfConsistency 0 hits였음).
- **리뷰지점:** ④b 독립 Opus judge PASS — end-to-end 게이팅 실측(reject→recordPlaybookStrategy 스킵), false-reject 위험 측정(동일프롬프트 T=0.3 진짜 패러프레이즈 ≈0.78 admit vs 발산 ≈0.0 reject; 드롭돼도 재증류+reward-decay 발화=영구손실0), majority/medoid/agreement math 정확, 무사이클(playbook↛correction-distiller), mutation 진짜(floor 비활성화→reject case RED). 다양성: agent-core/research-grounded(이전 6 fire와 다른 pkg+kind).
- **리스크:** 낮음 — only blocks unstable writes(non-destructive), k=1 비활성 백-호환, 오프라인 distill 경로라 3× model-call 비용 허용. nit→backlog ◦: rejected-agreement 텔레메트리로 0.5 floor false-reject율 실측 후 조정.
- **lesson:** 쉬운 backlog vein 마르면 멈추지 말고 연구-기반(open arXiv + 우리만의 적용)으로 새 메커니즘을 빌드 — fire 7 EXHAUSTION-종료는 과했음; 연구 경로가 정답(진안 피드백 [[feedback-self-improvement-loop-autonomy]]).

## fire 9 · 2026-06-20 · skill v2.0.0 · (reconcile + merge)
meta: value-class=infra · pkg=n/a · kind=divergence-reconcile+merge · verdict=MERGE · firesSinceDrill=8
ratchet: testFiles ↑ · fabrication 0 · gates: check EXIT=0 (agent-core 2515 · cli 2780 · memory 473, 타임아웃 0)

- **무엇:** 동시-루프가 LOCAL main을 갈라(내 fire-6 FF가 밀려남, fires 4-8이 main에서 이탈) → 브랜치를 현재 main(f3b33736)에 reconcile. rebase가 docs(INDEX) 반복충돌이라 더 깨끗한 경로 선택: `reset --hard main` + 4 feat 커밋 cherry-pick(코드 파일이 main 변경셋과 무겹침=무충돌) + check 재검증(전부 green) + docs 재적용. fires 4-8을 main에 재안착.
- **왜:** Tier1.5 3-fire 머지 지점(fire 9, ×3). 동시 루프들이 같은 LOCAL main에 머지하며 서로의 FF를 밀어내는 알려진 해저드 — 내 작업은 브랜치에 안전했고 cherry-pick으로 손실 0 재landing.
- **리뷰지점:** cherry-pick 후 `pnpm check` EXIT=0(시맨틱 통합 확인 — correction-distiller가 main이 바꾼 knowledge-recall import해도 무탈). 코드 무충돌, 결정론.
- **lesson:** 다중 루프 공유 LOCAL main에서 FF가 밀리면 rebase 반복충돌 대신 reset+cherry-pick(코드 무겹침일 때)이 빠르고 안전; 작업은 항상 브랜치가 source-of-truth. 머지 전 cherry-pick된 코드 check 재검증 필수.
## fire 10 · 2026-06-20 · skill v2.0.0 · `af25e7c2` (JUDGE-DRILL)
meta: value-class=new-capability · pkg=@muse/agent-core · kind=judge-drill+telemetry · verdict=PASS · firesSinceDrill=0 (drill done, reset)
ratchet: testFiles=1065 · fabrication 0 · gates: agent-core 2515 + check(model 단일 timeout=포화, 격리 325 GREEN) + self-eval ok + lint pass

- **무엇(JUDGE-DRILL, firesSinceDrill≥10 트리거):** 고의 INERT 슬라이스 주입 — `onReject` 옵션 선언+"reject시 발화" 문서화하되 **본문에서 안 호출** + config-only 테스트(옵션 받아도 안터짐만 확인). ④b 독립 Opus judge가 **FAIL 판정**(죽은 옵션·OUTCOME없는 테스트·미전달 가치 file:line 적시 + 올바른 minimal fix 제시) → 검증자 작동 입증 → forward-fix.
- **왜:** maker≠judge 보상통제(고정 천장이라 same-model judge일 때 drill이 유일한 보상통제) — verifier가 inert/선언-only를 실제로 잡는지 주기적 증명. 소재는 fire-8 telemetry follow-up(rejected-agreement 노출)이라 드릴이 진짜 가치도 남김.
- **리뷰지점:** 진짜 fix = `options.onReject?.(agreement)`를 disagreement-reject 경로에서만 발화(read-only, 게이트 결정 불변). spy OUTCOME 테스트(reject시 agreement<0.5로 1회 호출, admit시 미호출) + mutation RED→GREEN. 2차 ④b judge PASS(발화 위치·read-only·early-reject/admit 제외·mutation-sensitive 확인).
- **리스크:** 매우 낮음 — 선택적 동기 콜백, 반환값/게이트 불변. ◦ NEXT: production sink 배선(caller가 onReject로 카운트/로그).
- **lesson:** ④b 적응형 judge가 inert("declared but never invoked")를 신뢰성있게 FAIL → maker≠judge 보상통제 健全. 드릴은 미루지 말 것(firesSinceDrill≥10 하드카운터). 드릴 소재는 실제 backlog follow-up을 inert-then-real로 쓰면 검증+가치 동시 확보.

## fire 11 · 2026-06-21 · skill v2.0.0 · `c9e7fe4b`
meta: value-class=new-capability · pkg=@muse/mcp · kind=research-grounded/reflection-retention · verdict=PASS · firesSinceDrill=1
ratchet: testFiles=1065 (tests added to existing reflections-store.test.ts) · fabrication 0 · gates: mcp 1879 + check EXIT=0 (타임아웃 0) + self-eval ok + lint pass

- **무엇(연구-기반, 미접촉 reflection 표면):** reflection 스토어 cap-overflow eviction을 **pure recency → recency+salience 가중**으로 교체. `scoreReflectionRetention`(0.5^(age/30d) + min(1,support/5)) + `selectRetainedReflections`. 이미 저장하던 `supportCount`를 처음으로 retention에 사용.
- **왜:** `writeReflections`가 recency만 봐서, 여러 에피소드에 grounded된 고-support 재발 insight가 one-off 신규보다 먼저 evict됨 — Generative Agents(arXiv:2304.03442) retention=recency+importance. memory 스토어엔 ACT-R/Ebbinghaus 있는데 reflection 스토어엔 둘 다 없던 갭.
- **리뷰지점:** ④b 독립 Opus judge PASS — legacy 무회귀(동일 support→salience 상수→recency 환원, 기존 1970-epoch cap 테스트 tie→createdAtMs로 동일 결과, 계산+mutation으로 격리 확인) · 균형 sound(saturation+weight 방어가능, NaN/음수/거대 support 가드) · degenerate 안전. 다양성: fires 8/10 agent-core 후 fire11 @muse/mcp(다른 pkg). research-grounded kind.
- **리스크:** 낮음 — equal-support면 legacy-identical, dedup/atomic-write 무변경, fabrication 무관(어느 grounded insight가 cap을 살아남나만 결정). nit→backlog ◦: listReflections 표시 순서는 여전히 newest-first(retention≠display; 단 기존엔 evict돼 영영 안 보였으니 strictly better).

## fire 12 · 2026-06-21 · skill v2.0.0 · `66d153e4`
meta: value-class=wiring · pkg=@muse/cli · kind=telemetry-consumption · verdict=PASS · firesSinceDrill=2
ratchet: testFiles=1065 · fabrication 0 · gates: agent-core 2516 + cli 2781 + check EXIT=0 (타임아웃 0) + self-eval ok + lint pass · merge-to-main: fires 10-12 (this fire, ×3)

- **무엇:** fire-10의 `onReject` telemetry seam을 production에서 **소비** — `distillSessionCorrections`가 low-consistency(disagreement) 거부를 카운트해 `DistillResult.lowConsistencyRejected`로 노출. 이전엔 seam만 있고 consumer 없었음(inert seam → 실측 소비).
- **왜:** self-consistency 게이트의 0.5 floor false-reject율을 실제 세션에서 관측 가능해야 튜닝 가능(fire-8/10 follow-up). read-only(게이트 결정·뱅킹·decay/reinforce 불변).
- **리뷰지점:** ④b 독립 Opus judge PASS — 실제 소비(counter 노출·OUTCOME 테스트: disagreeing 3 same-script 드래프트→count 1·status skipped·playbook 0) · disagreement-reject만 카운트(정직 semantic) · 무회귀(identical-stub admit 경로 무변경·양 consumer read-only) · 6 return 전부 필드 설정 · mutation(+=1 제거→RED). 다양성: fire11 mcp 후 fire12 cli/wiring.
- **리스크:** 낮음 — read-only telemetry, DistillResult union 양 branch+이른 return 4개 0으로 일관. embed 없으면 cross-script support-gate fail-closed로 early-reject(onReject 미발화)되는 게 정상 — 테스트는 same-script+embed로 disagreement 경로 정조준.
- **lesson:** telemetry seam은 production consumer까지 배선해야 "inert seam" 면함; distill 테스트는 cross-script support-gate 때문에 same-script 드래프트+embed로 disagreement 경로를 정확히 타게 해야 함.
## fire 13 · 2026-06-21 · skill v2.0.0 · `e7656eb8`
meta: value-class=micro-fix · pkg=@muse/cli · kind=whetstone doctor-consistency · verdict=PASS · firesSinceDrill=3
ratchet: testFiles=1065 · fabrication 0 · gates: cli 2789 + check(api messaging-webhooks 단일 timeout=backlog#545 알려진 동시-부하 env flake, 격리해도 포화>20s, 무관) + self-eval ok + lint pass

- **무엇:** `muse doctor --weaknesses`의 `formatWeaknesses`가 MASTERED(BKT pKnown≥0.95) 약점도 "weak at"으로 나열하던 걸 `!isMasteredWeakness` 필터로 제외(+ "· N mastered" 노트 + all-mastered "resolved" 라인). 런타임 nudge의 mastery 억제와 일관.
- **왜:** 사용자가 반복해 해결한(mastered) 토픽을 doctor가 계속 "약점"으로 나열 → stale·nag. 런타임 nudge(selectRemediableWeaknesses)는 이미 !isMasteredWeakness로 억제하는데 doctor 인벤토리만 안 해서 불일치(judge fire-32 flag).
- **리뷰지점:** ④b 독립 Opus judge PASS — OUTCOME(렌더 리스트서 제외·mutation 진짜) · no-pKnown/low-pKnown는 active 유지(미입증) · 무입력변형([...].filter 새 배열) · 재실패는 bktUpdate가 pKnown 낮춰 self-correct · sibling formatDevFixableWeaknesses는 다른 axis class라 범위 외. 다양성: fire-5 형제(whetstone-doctor)지만 kind=consistency.
- **리스크:** 매우 낮음 — display-only, mastered 노트로 honest(숨김 없음), legacy 빈-ledger 경로 보존.

## fire 14 · 2026-06-21 · skill v2.0.0 · `fd2a3516`
meta: value-class=new-capability · pkg=@muse/agent-core (+@muse/cli wiring) · kind=research-grounded/episodic-write-novelty · verdict=PASS · firesSinceDrill=4
ratchet: testFiles=1066 (novelty tests in existing episodic-summariser.test.ts) · fabrication 0 · gates: agent-core 2521 + cli 2789(program 236/236) + check(api messaging-webhooks 단일 timeout=backlog#545 env flake, 무관) + self-eval ok + lint pass

- **무엇:** `captureEndOfSessionEpisode`에 write-time NOVELTY gate(`isEpisodeNovelVsRecent`, token Jaccard ≥0.8 vs 최근 10 저장 summary→reject) 추가. salience/ownerId 후·upsert 전 배선. embedder-free·fail-open(빈 summary/read err→admit)·subtractive.
- **왜:** 기존 write gate(outcome-quality·grounding·salience)는 전부 세션을 ISOLATION으로 판정 → 매주 반복 토픽이 near-identically 재-summary돼 또 다른 near-dup `[session:…]` 소스로 저장돼 recall 희석(read-time consolidateNearDuplicates는 write 後 정리뿐). Mem0 write-side NOOP(arXiv:2504.19413)+SAGE(arXiv:2605.30711).
- **리뷰지점:** ④b 독립 Opus judge PASS — outcome-genuine(upsert 전 차단·mutation 증명) · **false-drop 실측**(near-dup 1.0/0.75 drop, same-topic-different-decision 0.46/short 0.5 admit → 0.8 보수적) · fail-open 완전 · 기존 truthy-spelling 테스트가 동일세션 재-capture라 내 gate가 정상 skip→격리 episodesFile(index-keyed, case-insensitive FS 회피)로 적응(env-intent 보존, 약화 아님) · 형제-감사 clean(prod 1 call site). 다양성: agent-core/episodic(fires 8/10 correction과 다른 kind).
- **리스크:** 낮음 — subtractive(저장 거부만, fabrication 무관), fail-open으로 세션 손실 없음. 0.8/10 reasoning-set이나 false-drop 마진 측정상 안전.
- **lesson:** "값싼 후보 다 stale/blocked"는 vein-고갈이 아니라 **연구-스카웃 신호** — 진안 교정대로 멈추지 말고 더 알아보면 됨(fire 7/14 초기 오판 정정). cheap-scan 후보 연속 기각 시 곧장 research scout로.

## fire 15 · 2026-06-21 · skill v2.0.0 · `1f86f39c`
meta: value-class=new-capability · pkg=@muse/skills · kind=research-grounded/skill-eviction · verdict=PASS · firesSinceDrill=5
ratchet: testFiles=1067 (eviction tests in existing authored-skill-store.test.ts) · fabrication 0 · gates: skills 66 + agent-core 2521 + cli 통과 + check(api 2 timeout=박스 포화 env flake, 무관) + self-eval ok + lint pass · merge-to-main: fires 13-15 (this fire, ×3)

- **무엇:** `AuthoredSkillStore.enforceCap`의 cap-overflow eviction을 FIFO-by-authoredAt → **utility-aware**로 교체. 새 순수 `rankSkillsForEviction`(never-used 먼저, ties LRU) + `hasUsage`; enforceCap이 이걸로 evict-set 선정.
- **왜:** 스토어가 이미 usage(recordUsage→lastUsedAt)를 기록하는데 enforceCap만 무시 → 자주 쓴 old 스킬이 never-used 신규보다 먼저 archive되는 결함(SkillOps arXiv:2605.13716 utility-retire; TinyLFU arXiv:1512.00727 value-aware eviction). usage 없으면 lastActiveAt=authoredAt라 FIFO로 정확히 degrade(strict superset).
- **리뷰지점:** ④b 독립 Opus judge PASS — OUTCOME+mutation 진짜(end-to-end가 FIFO와 discriminating: USED old alpha 생존) · **no-regression EXACT**(all-unused→authoredAt asc=옛 FIFO, 기존 cap 테스트 통과) · eviction count/name-Set 정확(writeOrPatch가 authored-name 유일성 강제) · used는 never-used보다 먼저 evict 불가 · non-destructive(archive). 다양성: @muse/skills(이 루프 첫 접촉, fresh 표면).
- **리스크:** 낮음 — archive(삭제 아님), bundled 스킬 무관(listAuthored만), usage 없으면 옛 동작과 동일. nit(judge): hasUsage가 metadata.muse를 lastActiveAt와 따로 재파싱(무해).

## fire 16 · 2026-06-21 · skill v2.0.0 · (scout + DECOMPOSE-ON-DEFER)
meta: value-class=decompose · pkg=@muse/memory(scouted) · kind=verify-before-build/decompose · verdict=SCOUT · firesSinceDrill=6
ratchet: testFiles=1068 · fabrication 0 · gates: self-eval ok (no code) · merge-to-main: n/a (fire 16 ≠ ×3, next at 18)

- **무엇:** Opus 스카웃 top pick(memory UPDATE refine-vs-contradict)을 verify-before-build로 검증 → **핵심이 mostly-stale**: contested/volatility 신호는 `refinementAwareDistinctValueCount`(token-subset)로 *이미* refinement-aware(스카웃이 distinctValueCount 경로를 collectFactSupersessions와 혼동). 남은 건 factHistory 타임라인 labeling뿐인데, refinement를 그냥 드롭하면 elaboration history 손실이라 debatable + LABEL 방식은 >1-fire(memory interface+2 store persist+cli renderer). → 가짜/debatable 슬라이스 빌드 거부, 진짜 남은 항목 2개를 loop-sized ◦로 decompose해 backlog 기록(factHistory-kind-labeling a/b · playbook-injected-id-credit a/b/c).
- **왜:** DECOMPOSE-ON-DEFER + verify-before-build. green 게이트≠옳음 — 스카웃 arXiv가 진짜여도 seam이 이미 채워졌을 수 있어 코드 확인이 필수(fire 14에서도 stale 2건). 빌드 안 한 게 옳음(debatable factHistory 제거는 ④b judge가 FAIL할 변경).
- **리뷰지점:** maker≠judge 정신으로 스카웃 주장을 독립 코드-확인 — refinementAwareDistinctValueCount가 실제로 token-subset 제외하는지 sed로 확인. 다음 fire는 backlog의 decomposed ◦(factHistory-kind a 또는 playbook-credit a)부터, fresh-context cron fire가 적합.
- **리스크:** 없음(코드 무변경). 단 main이 inherit한 byte-hygiene RED(`commands-logo.test.ts`, 다른 루프 mascot 커밋)로 `pnpm check` 전체는 RED — 내 fires와 무관, 그 루프가 고칠 것(안 건드림: cross-loop 충돌 회피).
- **lesson:** 논문-스카웃 pick은 빌드 전 *그 seam이 이미 부분구현됐는지* 코드로 검증 — arXiv-real ≠ Muse-empty. 스카웃이 "X 신호가 갱신된다"고 주장하면 그 신호의 *실제 계산 경로*를 grep해 이미 처리됐는지 확인(distinctValueCount는 supersession-log이 아닌 별도 token-subset 경로).

## fire 17 · 2026-06-21 · skill v2.0.0 · `1fd3fb8b`
meta: value-class=new-capability · pkg=@muse/autoconfigure · kind=audit-driven/fabrication-guard sibling-parity · verdict=PASS · firesSinceDrill=7
ratchet: testFiles=1069 · fabrication 0 · gates: autoconfigure 611/611 + check(only failure=inherited commands-logo byte-hygiene from another loop's mascot commit, 무관; my files byte-clean) + self-eval ok + lint pass · merge-to-main: n/a (fire 17 ≠ ×3, next at 18)

- **무엇:** 진안 지시("정말 자기개선 되는지·메커니즘 옳은지 알아봐")로 **EFFICACY AUDIT**(3 병렬 Opus, maker≠judge, codegraph/grep 실증) 수행 후, 최우선 *검증된* 발견을 즉시 fix: self-consistency write 게이트가 sync distiller(off-by-default)에만 있고 **default-on idle/daemon 학습자(`distillQueuedCorrections`)엔 없어** 단일 draft를 뱅킹하던 걸, `distillConsistentStrategy`(k draws 합의)로 감싸 sibling-parity 확보(@muse/autoconfigure).
- **왜:** "선언≠작동" — 우리가 fires 8/10/12에 만든 fabrication-guard가 정작 *기본 자율 학습 경로*를 안 덮고 있었음(형제-감사 누락). 이제 양 경로 모두 불안정(=confabulated) 증류를 auto-write 안 함.
- **리뷰지점:** ④b 독립 Opus PASS(7/7: outcome-genuine·mutation RED·queue-drain 불변·무회귀·invariant·diversity); cost-honesty nit(k=3× LLM/event)는 헤더 주석에 명시. **verify-before-build이 감사 Finding 2를 REJECT**: Agent A가 없는 파일(`context-engineering-builders.ts:426`)을 cite하며 "buildPlaybookProvider가 origin 드롭"이라 했으나, 실제 CLI 주입은 `toPlaybookStrategy`로 origin carry + 런타임 playbookProvider는 CLI에서 미구성 → 가짜 발견.
- **리스크:** 낮음 — write를 엄격하게만(뱅킹 감소, fabricate 불가), idle write는 여전히 probation. cost k×는 tunable(`strategyConsistencySamples`).
- **lesson:** 감사 서브에이전트의 file:line cite는 반드시 독립검증 — Opus도 없는 경로를 confident하게 지어냄(Finding 2). 그리고 "메커니즘 출하"≠"기본 경로 적용": 새 guard는 sync/idle/ASK/CHAT 모든 형제 경로 커버를 grep로 확인.
- **AUDIT 요약(진안 질문 답):** HEALTHY/실작동=whetstone(약점원장 record→BKT→resolve→nudge, ASK/CHAT parity, mastery suppression) · Mem0 auto-extract+belief-provenance(File store, default-on) · Playbook ranking(rankingUtility Wilson-LCB, 과거버그 미재발) · skill 선택+recordUsage+eviction. INERT/기본에선 死=episodic capture(MUSE_EPISODIC_MEMORY_ENABLED off — fire-14 novelty 게이트 포함 기본 미발화) · summary-recall(CLI InMemory store라 매 프로세스 empty) · fade/promote(daemon-only+MUSE_SELFLEARN_ENABLED off). UNMEASURED(최대 갭)=cross-turn "경험이 다음 턴을 돕는다"는 end-to-end 측정이 *전무*; 모든 eval이 single-turn 메커니즘 발화 확인일 뿐, self-eval은 count ratchet(bigger≠better). → backlog ◦로 등록.

## fire 18 · 2026-06-21 · skill v2.0.0 · `7b860f8e`
meta: value-class=micro-fix · pkg=@muse/autoconfigure + @muse/recall · kind=correctness/audit-fix · verdict=PASS · firesSinceDrill=8
ratchet: testFiles=1070 · fabrication 0 · gates: recall 366/366 + autoconfigure 612/612 + cli build clean + check(유일 실패=inherited commands-logo byte-hygiene, 다른 루프, 무관) + self-eval ok + lint · merge-to-main: fires 16-18 (this fire, ×3)

- **무엇:** fire-17 감사 Finding 2(`buildPlaybookProvider`가 origin 드롭)를 **재검증→REAL 확인→수정**. + ④b judge가 *같은 ranker를 먹이는 형제 2곳 추가 발견*(`selectPlaybookSection`·`topAppliedStrategy` @muse/recall, 기본 `muse ask` 경로) → 셋 다 origin carry로 패치(CLI `toPlaybookStrategy` sibling과 parity). 이제 모든 entry→PlaybookStrategy 투영이 provenance 보존.
- **왜:** origin이 REFLECTED_RANK_PENALTY + CBR low-support 게이트를 켜는 키 → 드롭되면 합성(reflected) 전략이 grounded와 동급 랭킹 = "evidence beats synthesis"가 **런타임+기본 ask 경로 모두에서 死**. 우리가 출하한 메커니즘이 정작 안 돌던 것(진안 "메커니즘이 옳은지" 질문의 직접 답).
- **리뷰지점:** ④b 독립 Opus PASS(bug real·outcome-discriminating: origin이 tie 결정 요인, mutation RED·diversity OK) + judge가 형제 2곳 적발 → *같은 fire에 함께 패치*(형제-완전성). 두 fix 모두 mutation-verified.
- **리스크:** 낮음 — 조건부 spread(origin 있을 때만), 8개 기존 필드 불변, 랭킹 페널티 복원만(fabrication 무관). input 타입 widening은 back-compat(optional).
- **lesson(정직성 정정):** fire-17에서 Finding 2를 "hallucination"이라 기각한 건 **내 오류** — `context-engineering-builders.ts`를 @muse/agent-core에서만 찾고 @muse/autoconfigure를 안 봄. 교훈: 감사 cite가 "없는 파일"로 보여도 *전 패키지 grep*으로 확인 후 기각(잘못된 패키지에서 못 찾은 것일 수 있음). 그리고 형제-감사는 grep 범위를 @muse/recall까지 — selector를 먹이는 모든 패키지를 봐야 함(judge가 내 누락을 잡음).

## fire 19 · 2026-06-21 · skill v2.0.0 · `932c3020`
meta: value-class=new-capability · pkg=@muse/memory + @muse/autoconfigure · kind=audit-fix/store-persistence · verdict=PASS · firesSinceDrill=9
ratchet: testFiles=1071 · fabrication 0 · gates: memory 482 + autoconfigure 615 + cli build clean + check(잔여 실패=flaky model property-fuzz[격리시 16/16 통과]+1 saturation api timeout, 무관; byte-hygiene 0=다른 루프가 commands-logo 수정) + self-eval ok + lint · merge-to-main: n/a (fire 19 ≠ ×3, next at 21)

- **무엇:** 감사 #3(가장 명백한 inert) 수정 — CLI의 ConversationSummaryStore가 InMemory(DB 없음)라 매 프로세스 empty여서, 런타임 save 경로가 쓴 summary가 소실 + default-on cross-session recall이 항상 empty + fade/promotion 연료 고갈. `FileConversationSummaryStore`(JSON·atomic·0o600·ISO date round-trip·missing/corrupt→empty) 추가 + no-DB factory 기본을 File로(PERSIST=false면 InMemory). FileUserMemoryStore 패턴 미러.
- **왜:** "default-on cross-session 기억"이 CLI에선 신기루였음(감사 Agent B #1). 이제 한 세션이 쓴 summary를 다음 세션이 실제로 recall → 진짜 cross-session 자기개선 + consolidation 연료 복구. 진안 "자기개선이 진짜 되는지"의 직접 답: inert를 실재로.
- **리뷰지점:** ④b 독립 Opus PASS — outcome genuine(fresh instance가 prev write를 recall, InMemory는 불가, mutation: rename 무력화→RED)·dates+nested fact dates round-trip·InMemory와 semantics parity·robust(missing/corrupt→empty, atomic)·factory flip 안전(API서버 db→Kysely 불변, store-factories 테스트 갱신=계약변경 반영). 다양성: @muse/memory(fresh pkg) store-backend. nit 수정: 테스트 category를 유효 FactCategory(GENERAL)로.
- **리스크:** 낮음 — 순수 storage backend(claim 생성 없음, fabrication 무관), 로컬 파일 no-egress(local-by-construction), read-modify-write race는 single-user CLI라 수용가능(기존 매-프로세스-소실보다 엄격히 개선). 형제 createTaskMemoryStore는 backlog 기록(judge 적발).
- **lesson:** "default-on" 플래그가 켜져도 백엔드가 비영속(InMemory)이면 기능은 死 — 메커니즘 검증 시 *플래그뿐 아니라 store 백엔드가 프로세스 간 살아남는지*까지 확인. 형제-감사는 같은 factory의 다른 store(taskMemory)도 enumerate.

## fire 20 · 2026-06-21 · skill v2.0.0 · (JUDGE-DRILL — no code, verifier proven)
meta: value-class=drill · pkg=@muse/agent-core(drill target) · kind=judge-drill/verifier-proof · verdict=DRILL-PASS · firesSinceDrill=0 (reset)
ratchet: testFiles=1071 (unchanged — drill rolled back) · fabrication 0 · gates: self-eval ok · merge-to-main: n/a (fire 20 ≠ ×3, next at 21)

- **무엇:** firesSinceDrill=10 트리거 → JUDGE-DRILL 강제 수행. 고의 나쁜-슬라이스 주입: `isEpisodeNovelVsRecent`에 `caseSensitive?` 옵션을 *선언만 하고 본문 미read*(config-only/declared-unused) + "옵션을 수용한다"만 단언하는 non-discriminating 테스트(빈 recents라 옵션 무관하게 true). 빌드·테스트 green으로 "통과"처럼 보이게 함정 설치.
- **왜:** Opus가 maker=judge 천장이라, 검증자가 여전히 나쁜 슬라이스를 잡는지 주기적 증명 필요(JUDGE-DRILL 하드-카운터). 검증자가 rubber-stamp로 퇴화하면 루프 전체 품질게이트가 무력화.
- **리뷰지점:** ④b 독립 Opus judge(drill임을 모른 채 정상 검증)가 **정확히 FAIL** — 구체적 위반 명시: "caseSensitive는 line 221 선언만·본문 222-238 미read; lexicalTokenList가 knowledge-recall:109에서 이미 lowercase라 case-sensitivity moot; 테스트는 빈 recents에 양 옵션 모두 true 단언=옵션 삭제해도 green인 non-discriminating 가짜 테스트". 올바른 버전이 뭘 해야 하는지까지 제시. → 검증자 신뢰성 입증, 즉시 `git restore` 롤백(워크트리 clean).
- **리스크:** 없음(드릴 롤백, 코드 무변경). 진짜-fix는 taskMemory File-backing이 적합하나(judge-flagged 형제) nested-dated 배열 3종 직렬화+purge maintenance로 >1-fire라 backlog ◦로 decompose(post-drill add-on 아닌 fresh fire 권장).
- **lesson:** JUDGE-DRILL이 작동함 — config-only/declared-unused + non-discriminating 테스트(빈 입력에 옵션 무관 동일 결과)는 검증자가 mutation-관점("옵션 삭제해도 green이면 가짜")으로 잡는다. 같은 함정 패턴(선언만 한 옵션, 빈-입력 단언)을 진짜 슬라이스에서도 self-check.

## fire 21 · 2026-06-21 · skill v2.0.0 · `4926fce8`
meta: value-class=new-capability · pkg=@muse/memory + @muse/autoconfigure · kind=store-persistence/audit-fix-sibling · verdict=PASS · firesSinceDrill=1
ratchet: testFiles=1071 · fabrication 0 · gates: memory 484 + autoconfigure 618 + pnpm check EXIT=0 (model property-fuzz flaky 이번엔 통과; byte-hygiene 0) + self-eval ok + lint · merge-to-main: fires 19-21 (this fire, ×3)

- **무엇:** fire-19 형제(④b-flagged) 완성 — `createTaskMemoryStore`가 no-DB에서 InMemory 기본이라 in-progress 작업상태(goal/plan/decisions/blockers)가 매 CLI 프로세스 소실되던 걸 `FileTaskMemoryStore`로 영속. **wrap-delegate-persist** 설계(파일→InMemory rehydrate[active-index 재구축+retention/trim, normalize가 timestamp 보존]→위임→entries() 영속). nested Dates(plan/decisions/blockers + top-level) ISO round-trip, atomic·0o600·missing/corrupt→empty. factory no-DB 기본 File(PERSIST=false escape).
- **왜:** fire-19가 conversation-summary를 영속시킨 것과 같은 갭이 task-memory에도 있었음(judge가 fire-19에서 적발). 이제 진행 중 작업이 세션 간 살아남음 = 진짜 cross-session 자기개선.
- **리뷰지점:** ④b 독립 Opus PASS — **retention-trap 반박**(normalizeTaskState가 `updatedAt ?? createdAt ?? now`로 보존 → rehydrate가 expiry 안 리셋; purge 테스트가 직접 증명) · outcome+mutation 진짜(fresh instance가 findById/findActiveBySession로 회수, 4개 nested Date exact getTime, rename 무력화→RED) · assembly 테스트 갱신 정당(PERSIST=false로 wiring만 검증·real ~/.muse 회피). 다양성: @muse/memory store-persistence(fire-19와 same kind·다른 store).
- **리스크:** 낮음 — 순수 storage(fabrication 무관), 로컬 파일 no-egress, wrap이 InMemory 로직 100% 재사용(재구현 최소). nit(judge, 비차단): RMW race(single-user CLI 수용)·read시 expiry-clear 영속 위해 write-back.
- **lesson:** wrap-delegate-persist = 복잡한 in-memory store(dual-index+retention+trim)를 File-back하는 안전 패턴 — 로직 재구현 대신 rehydrate→delegate→persist(단 normalize가 timestamp 보존하는지 먼저 확인, 안 그러면 retention 리셋 버그). 같은 factory의 형제 store(user/summary/task) 모두 File-default로 수렴.

## fire 22 · 2026-06-21 · skill v2.0.0 · `6a99f621`
meta: value-class=new-capability · pkg=@muse/autoconfigure (test) · kind=cross-turn-measurement/verification · verdict=PASS · firesSinceDrill=2
ratchet: testFiles=1072 · fabrication 0 · gates: autoconfigure 620/620 isolated (full check SIGTERM on apps/cli = 박스 포화, AssertionError 0·crash-marker 0; test-only라 cli 무영향) + self-eval ok + lint · merge-to-main: n/a (fire 22 ≠ ×3, next at 24)

- **무엇:** 감사 #1(최대 갭: "자기개선이 실제로 돕는다는 end-to-end 증거 전무")의 **landable 절반** — `experience-recall-cross-session.test.ts`: session1이 FileConversationSummaryStore에 경험 저장 → session2(fresh instance, 파일만이 연결) `StoreBackedEpisodicRecallProvider`(주입 stub embed)가 **실제로 recall**; empty-store/unrelated-query는 recall 안 함. deterministic(Ollama 없음)·CI-gated.
- **왜:** fires 19/21로 store가 영속하게 됐으니, 이제 "이전 세션 경험이 다음 세션에서 회수된다"는 cross-turn 메커니즘을 model 없이 증명 가능. 고정 모델에서 자기개선=experience-indexed retrieval이므로 retrieval-level 증명이 정당한 측정(answer-text 단언은 brittle anti-pattern). 진안 "자기개선이 진짜 되는지"의 결정론적 답.
- **리뷰지점:** ④b 독립 Opus PASS — not-a-tautology(두 store가 in-memory state 공유 0·파일만 연결, mutation: 영속 무력화→양성 RED) · stub embed discriminating(cosine 0.577 vs 0, minScore 0.1 non-cheating) · framing honest(retrieval 증명이지 answer-quality 아님 명시) · no vacuous green(양성 `.some(Dana Kim)`이 load-bearing). 다양성: cross-cutting verification(fresh kind).
- **리스크:** 낮음 — test-only(src 무변경, fabrication/grounding 무관), 로컬 파일. LIVE answer-quality delta는 backlog ◦로 남김(smoke:live가 이 박스서 stall). nit(judge): similarity 핀·userId-isolation 케이스=다음.
- **lesson:** LIVE eval이 박스 stall로 막힐 때, 그 측정의 *결정론적 핵심*(여기선 persist→retrieve chain)을 주입식 의존성(embed)으로 model 없이 증명하면 landable + CI-gated로 더 강한 게이트가 됨. "skip은 pass 아님"을 deterministic로 우회.

## fire 23 · 2026-06-21 · skill v2.0.0 · `602b675b`
meta: value-class=wiring · pkg=@muse/mcp (+@muse/cli) · kind=reflection-store recall-ordering · verdict=PASS · firesSinceDrill=3
ratchet: testFiles=1071 · fabrication 0 · gates: mcp 1884 + cli build clean + check(유일 실패=1 api timeout saturation, AssertionError 0·model-fuzz 0·내 패키지 FAIL 0) + self-eval ok + lint · merge-to-main: n/a (fire 23 ≠ ×3, next at 24)

- **무엇:** fire-11 retention(salience-aware)의 follow-up 갭 닫음 — ask-grounding RECALL이 `listReflections`(newest-first) `.slice(0,5)`라 retain된 high-support old insight가 묻혀 프롬프트에 못 닿던 걸, `selectReflectionsForRecall`(scoreReflectionRetention=recency+salience 재사용) 정렬로 교체. listReflections는 `muse reflections` 디스플레이용 newest-first 유지.
- **왜:** retention≠display 갭 — 보존은 salience-aware인데 표면화는 recency-only라 보존의 의도(고-support insight 살림)가 grounding 표면에 반영 안 됨. 동일 score로 retention과 display 신호를 일치시켜 닫음. fire-19/21/22(영속+증명)에 이은 reflection 표면 정합.
- **리뷰지점:** ④b 독립 Opus PASS — outcome real(현실값 21d/sup3=1.216 > 1d/sup1=1.177도 flip, mutation: recency-only→RED) · salience-vs-relevance 정직(old도 query-filter 없는 top-5였으니 새 off-topic 리스크 없음, new가 retention과 정합·salience는 +1로 saturate해 ancient가 무한 우세 못함) · sibling-complete(ask=유일 recall; commands-brief는 자체 supportCount selector·display/synthesis 경로 정확). 다양성: @muse/mcp reflection(fresh pkg).
- **리스크:** 낮음 — 이미 RGV-grounded reflection 재정렬만(fabrication 무관), listReflections 불변(디스플레이 무영향), Date.now()는 정상 런타임. nit(judge): selectRetained와 sort 식 중복(무해, 독립가변 유지).
- **lesson:** 메커니즘을 표면별로 형제-감사 — RETENTION을 salience-aware로 고치면 그 결과를 *소비하는* RECALL/DISPLAY 표면도 같은 신호를 쓰는지 확인(retain≠surface). 보존정책과 표면화정책의 신호 일치가 핵심.

## fire 24 · 2026-06-21 · skill v2.0.0 · `35bd3dd9`
meta: value-class=new-capability · pkg=@muse/skills · kind=skill-authoring dedup (research-grounded) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles=1071 · fabrication 0 · gates: skills 70/70 + cli build clean + check(유일 실패=model web-search-policy property-fuzz=fires 19/21 동일 flaky, 격리 16/16 통과; +1 api timeout saturation; skills 무관) + self-eval ok + lint · merge-to-main: fires 22-24 (this fire, ×3)

- **무엇:** Skill 작성 write-time SUBSUMPTION dedup — `writeOrPatch`가 name+description Jaccard만 보고 **body 미비교**라, fresh name이지만 procedure-body가 기존 스킬의 부분집합인 draft가 near-dup으로 author되던 걸(curator가 나중 idle비용 정리), `skillBodyIsSubsumed`(directional containment |draft∩existing|/|draft| ≥0.85)로 write 시점 skip.
- **왜:** Voyager skill-library novelty gate(arXiv:2305.16291) — 스킬 추가를 라이브러리 novelty로 게이트. directional이라 richer SUPERSET 신규는 절대 억제 안 함, fail-open(빈 body→write 허용), non-destructive(skip, mutate 없음).
- **리뷰지점:** verify-before-build이 seam 비어있음 확인(writeOrPatch가 정말 body 무시). ④b 독립 Opus PASS — outcome real(테스트의 name+desc Jaccard=0.0 확인→새 body 경로 진짜 행사, mutation: gate 제거→skip 테스트 RED) · false-skip bounded(짧은 draft 꼬리만, 0.85 보수적, recoverable·non-destructive) · sibling-complete(writeOrPatch 단일 write seam·consolidate는 post-hoc). 다양성: @muse/skills authoring-dedup(fire15는 eviction, 다른 kind).
- **리스크:** 낮음 — subtractive(redundant write 보류만, fabrication 무관), risk-scan quarantine 먼저 실행 불변, enforceCap 우회 없음. nit(judge): consolidate umbrella write의 저확률 subsumption-skip 상호작용 → backlog ◦.
- **lesson:** 연구-스카웃 pick은 빌드 전 seam 비어있음을 코드로 확인(fires 14/16 stale 교훈) — 이번엔 reflection-synthesis "≥2 source" 후보가 *이미 빌드됨*(DEFAULT_MIN_SUPPORT=2)이라 스카웃이 그 표면 기각하고 빈 seam(skill body dedup)으로 정확히 안내. 대칭 Jaccard match는 directional subset 관계를 표현 못 함 → containment가 별도 신호.

## fire 25 · 2026-06-21 · skill v2.0.0 · `04661584`
meta: value-class=new-capability · pkg=@muse/agent-core (+@muse/cli +@muse/autoconfigure) · kind=proactive cross-session discharge (research-grounded) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles=1074 · fabrication 0 · gates: agent-core 26 + autoconfigure 621 + cli e2e 2 + check(유일 실패=packages/auth flaky[격리 15/15 통과]+1 api timeout; 내 패키지 무관) + self-eval ok + lint · merge-to-main: n/a (fire 25 ≠ ×3, next at 27)

- **무엇:** 영속 check-in의 cross-session auto-discharge — `selectDischargedCommitments`(discharge-MARKER turn AND cosine ≥ 기존 COMMITMENT_DISCHARGE_COSINE)로, 유저가 다음 세션에 "done, 처리했어"라 하면 standing nudge를 cancel. in-session 필터(selectOpenCommitments)는 한 대화만 봐서 미래 세션 discharge를 못 봄. CLI `scanSessionCheckins` + daemon `scanCommitmentsFromTurns` **양 seam**에 배선.
- **왜:** π-Bench(arXiv:2605.14678) proactivity 실패 — done인 걸 계속 nag. 새 threshold 없음(기존 0.55+marker 재사용), conservative(marker AND cosine: 놓친 discharge는 한 번 nag, false-cancel은 reversible), fail-soft(embedder 에러→아무것도 discharge 안 함).
- **리뷰지점:** verify-before-build이 seam 비어있음 확인(cancelCheckin은 manual만). ④b 독립 Opus PASS(mechanism+CLI wiring) + **#5로 daemon twin 누락 적발**→같은 fire에 형제-완성. **end-to-end 테스트가 진짜 ordering 버그 잡음**(daemon twin의 `raw.length===0` early-return이 discharge 앞에 있어 discharge-only 세션 누락→discharge를 early-return 앞으로 이동). mutation: marker 필터 제거→no-marker 테스트 RED. 다양성: @muse/agent-core+cli+autoconfigure proactive(fresh kind).
- **리스크:** 낮음 — nudge cancel만(fabrication/grounding 무관), reversible, fail-soft. cosine은 instance-specificity 무시(judge nit, reversible nudge라 수용).
- **lesson:** 형제 wiring을 *같은 fire에* end-to-end 테스트하라 — daemon twin의 early-return-before-discharge 버그는 pure 테스트론 안 잡히고 end-to-end(discharge-only 세션→cancelled)가 잡았다. 같은 패턴을 두 seam에 배선할 때 각 seam의 *제어흐름 차이*(early-return 위치)를 개별 검증.

## fire 26 · 2026-06-21 · skill v2.0.0 · (scout + verify-before-build + ESCALATE)
meta: value-class=scout/escalate · pkg=n/a · kind=exhaustion-signal/escalation · verdict=SCOUT · firesSinceDrill=6
ratchet: testFiles=1072 · fabrication 0 · gates: self-eval ok (no code) · merge-to-main: n/a (fire 26 ≠ ×3, next at 27)

- **무엇:** 연구-스카웃 + verify-before-build로 후보 전부 기각/이미-됨 확인 → clean 결정론 vein 고갈 신호 + 고가치 잔여(playbook-credit) ESCALATE. (1) 스카웃 top pick BKT-Forget mastery-decay = **의미적 기각**(약점원장 mastery=Muse grounding 신뢰성, idle해도 안 쇠퇴 → time-decay는 근거없는 re-nag; regression은 새 실패로 이미 재표면화; fire 14 동일사유). (2) backlog의 factHistory labeling = **이미 출하됨**(agent-hardening fire 16 `0304823e`, 다른 루프) — stale. (3) playbook injected-id credit = 3× defer → **DECOMPOSE-ON-DEFER escalate**(고가치지만 genuine 3-seam multi-fire, seam-a 단독은 config-only라 incremental 불가).
- **왜:** fires 17-25에 9 검증 슬라이스 출하 후 self-improvement의 *값싼 1-fire 결정론* vein 실제 고갈. 남은 가치=playbook-credit(multi-fire)·LIVE experience-delta(Ollama 박스 stall). 가짜/dubious 슬라이스 강행 대신 정직히 escalate가 계약(EXHAUSTION + DECOMPOSE-ON-DEFER).
- **리뷰지점:** verify-before-build이 *세 번째로* 연속 stale/dubious 적발(fire 14 line100, fire 16 distinctValueCount, fire 24 reflection-≥2-source, 이번 factHistory+BKT-Forget) — 스카웃 arXiv-real ≠ Muse-empty ≠ domain-sound 3중 확인 필수. 코드 무변경(dubious 빌드 거부).
- **리스크:** 없음(코드 무변경). escalation은 PushNotification으로 진안에 전달.
- **lesson:** 스카웃 pick은 (1) seam-empty (2) domain-sound 둘 다 확인 — BKT-Forget은 seam은 비었으나 domain-unsound(약점원장≠쇠퇴스킬). "dead field(lastResolved)가 있다"≠"그 메커니즘이 옳다". 값싼 vein 고갈 시 marginal/dubious 강행보다 고가치 multi-fire를 정직히 escalate.
