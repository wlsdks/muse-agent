# core-hardening — Muse 코어 엣지 강화 루프 journal

> Theme: Muse의 코어 엣지(결정론적 grounding+citation 게이트 + 4 표면 memory-integrity·self-development·orchestration·grounding-floor) 강화·하드닝.
> Worktree `/tmp/muse-core-hardening` · branch `loop/core-hardening` (Tier2 — pushes to its own branch each fire, periodic rebase from origin/main). **Every 3 fires: ff-merge the branch into origin/main, then keep working on the branch (진안 directive 2026-06-20).**
> Cron `d8c31fa3` (every 15m, session-only; was `cfe778e2` under skill v1.14.0, re-registered with loop-creator v2.0 at fire 6). Stop: `CronDelete d8c31fa3`. Convention: [README](README.md).

## fire 11 · 2026-06-20 · skill v2.0 · 14810a1f (honest EXHAUSTION, no code slice)
meta: value-class=refactor(work-list) · pkg=docs · kind=exhaustion-honest-exit · verdict=N/A · firesSinceDrill=1
ratchet: testFiles 1060→1060 · fabrication 0 · vein-status recorded
- 무엇: 전 표면(grounding-floor·local-tool·orchestration·anti-fab·memory-integrity·outbound·self-dev) 타깃 스카웃 — 이 세션의 **clean 1-fire core-edge 베인이 진정으로 마름**. 남은 항목은 전부 marginal-additive(home/street 라벨)·speculative-no-caller(deep-nesting)·>1-fire-redesign(KO injection·comma list-vs-value)·cross-loop-territory(BKT/whetstone=agent-core-cognition)·design-choice-not-bug(doctor selector) 중 하나.
- 왜 코드 슬라이스 없음: v2 EXHAUSTION/marginal-value floor — 억지 marginal 슬라이스(검증비 > 한계가치)보다 *정직한 출구 + vein-status 기록*이 규칙 부합. "검증 쉬운 것 아님" 원칙상 home/street 추가 같은 low-value busywork 회피.
- 리뷰지점: fire 1-10이 6 (pkg,kind) 표면에 검증된 하드닝 + 2 verifier-catch(fire 6,10)를 쌓음 — 테마의 1-fire 표면이 포화. 다음 고가치는 deliberate >1-fire decompose 또는 retheme(진안 결정). 새 코드 0줄이라 ④b N/A.
- 리스크: 0 — 코드 미변경.
lesson: 한 테마의 모든 표면에서 1-fire-clean이 마르면(전수 스카웃 후), 자동-fire를 thin하게 계속하기보다 *vein-status를 명시 기록하고 진안에게 deliberate-decompose vs retheme vs pause 결정을 올린다* — auto-loop의 marginal-value 바닥을 인식하는 게 정직.

## fire 10 · 2026-06-20 · skill v2.0 · 6d6af23e (JUDGE-DRILL + real ship)
meta: value-class=new-capability · pkg=@muse/recall · kind=memory-integrity/source-conflict · verdict=PASS · firesSinceDrill=0(reset)
ratchet: testFiles 1058→1058 (+4 cases conflict.test) · fabrication 0 · @muse/recall 338 tests green · precheck:grounding 2/3 PASS · pnpm check exit 0 · lint clean
- DRILL(firesSinceDrill≥10 트리거): 고의로 NAIVE 전역 콤마-widen(`[^\n.,;]`→`[^\n.;]` 모든 라벨) 주입 + cherry-pick 테스트(주소만)로 334 테스트 통과 → ④b 적응형 judge가 **FAIL 확인**(benign 리스트 6/6 spurious conflict 구체 증거, reordered-identical/grown-list 변종까지, label-gate 설계 권고). 검증자 작동 입증 → 롤백.
- 진짜 슬라이스: source-conflict 콤마-값을 **LABEL-GATED**로 — 정규식은 콤마 허용하되 `ADDRESS_LABELS`(address/주소/위치/…)만 콤마 보존, 그 외 모두 첫-콤마 절단(현행 byte-identical). 주소 conflict(London/Paris, 한국어 주소) 잡힘, benign 리스트 0 신규 FP.
- 왜: source-conflict는 user-facing grounding cue — false-positive=신뢰 침식. fire-9가 전역 widen의 FP를 분석, fire-10 드릴이 그걸 judge로 라이브 확증, gated 설계로 false-negative만 해소(judge가 byte-for-byte 등가 증명).
- 리뷰지점: ④b가 non-address 경로 byte-for-byte 등가(신규 FP 0) 증명; mutation 양방향(주소=원본 RED, 리스트가드=naive-widen RED). residual: ADDRESS_LABELS가 home/street 누락(같은 FN 방향, additive); 단일-라인 multi-field swallow=cosmetic(conflict는 표면).
- 리스크: 낮음 — non-address 경로 불변(등가 증명), 순수 additive. ④b Opus 적응형 judge PASS.
lesson: regex 추출 broadening의 FP는 *전역 대신 LABEL-GATE*로 외과적 해결 — 합법적 콤마-값 클래스(주소)만 열고 나머지는 byte-identical 유지하면 fire-6류 대량오탐 없이 false-negative만 닫는다. 드릴은 실제 후보를 naive로 주입하면 일석이조(검증자 확증 + 곧 진짜 fix).

## fire 9 · 2026-06-20 · skill v2.0 · 0a6db466 (analysis + 3-fire main merge, no code slice)
meta: value-class=refactor(work-list) · pkg=docs · kind=exhaustion-analysis+merge · verdict=N/A · firesSinceDrill=9
ratchet: testFiles 1057→1057 · fabrication 0 · branch fires 7-8 → origin/main ff-merge (3-fire obligation)
- 무엇: 이 세션의 core-edge **easy-clean(non-regex·non-agent-core) 베인이 얇아짐** — 타깃 스카웃이 already-built/non-issue 다수 적발(A2A label bound=이미 fire 63, feeds SSRF=내부피드 non-issue, formatDueLocal=clean+표면불일치위험, classifyMemory=fire 8 done, multi-hop recall=1b'/1c done 잔여 structural-blocked). 남은 고가치(source-conflict 콤마-값)는 1-fire clean이 아님(아래).
- 왜 코드 슬라이스 없음: source-conflict 콤마-값 broadening은 false-negative(주소 London↔Paris 놓침)를 잡지만 **콤마-리스트 false-positive(첫요소 공유)를 새로 추가** → fire-6과 동일 실패-모드(regex 추출 오탐). list-vs-value 판별기 + 대규모 benign 코퍼스 필요한 >1-fire 재설계 → DECOMPOSE-ON-DEFER 기록(억지 1-fire 강행 안 함, EXHAUSTION marginal-value 규칙).
- 리뷰지점: fire 9 = 진안의 3-fire main 머지 의무 이행(fires 7-8 anti-fabrication+memory-integrity를 origin/main에 통합) + work-list 정직 정제. 새 코드 0줄이라 ④b judge N/A(머지는 이미 fire별 PASS된 커밋).
- 리스크: 0 — 코드 미변경, 머지는 ff-only(이미 검증된 커밋).
lesson: 세션 내 한 (theme)의 easy-clean 베인이 마르면, 억지 1-fire 대신 *남은 고가치를 DECOMPOSE로 정직히 기록*하고 의무(머지)를 처리하라 — 방금 막힌 실패-모드(regex 추출)를 회피하는 게 다양성·marginal-value 규칙 둘 다에 부합.

## fire 8 · 2026-06-20 · skill v2.0 · 8e3616f4
meta: value-class=micro-fix · pkg=@muse/memory · kind=memory-integrity/spurious-write · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 1057→1057 (+2 cases memory-operation.test) · fabrication 0 · @muse/memory 456 tests green · pnpm check exit 0 · lint clean
- 무엇: `classifyMemoryOperation`이 `existing===undefined`(저장된 적 없는 키)여도 retraction 토큰이면 "delete" 반환 → auto-extract가 없는 키에 `store.forget()`를 호출(File/Kysely 백엔드는 persistence 경로를 실제로 건드림). `existing===undefined ? "noop" : "delete"`로 수정 — NOOP은 부수효과 0(Mem0 규율).
- 왜: 다양성 — non-agent-core(@muse/memory 신규 (pkg,kind)), non-regex(fire 6 한국어 regex vein에서 의도적 이탈). spurious store-mutation 제거 = 메모리-무결성 하드닝.
- 리뷰지점: 모든 분기 walk(defined+retraction→delete 유지, undefined+retraction→noop, 나머지 불변); 기존 "DELETE on retraction"(existing=Seoul) 테스트 그대로 통과; 정당한 삭제 억제 0(실제 키는 항상 existing defined). 형제-감사: 공유 classifier라 fact+preference 양 namespace 자동 커버. integration은 forget-spy로 0 호출 OUTCOME 검증.
- 리스크: 낮음 — 1줄 가드, 회귀 0. ④b Opus 적응형 judge PASS (mutation으로 RED 재확인).

## fire 7 · 2026-06-20 · skill v2.0 · 42b5455d
meta: value-class=new-capability · pkg=@muse/agent-core · kind=anti-fabrication/floor-total · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1057→1057 (+5 cases tool-argument-grounding.test) · fabrication 0 · agent-core 2491 tests green · precheck:grounding 2/3 PASS · pnpm check exit 0 · lint clean
- 무엇: `groundToolArguments`(fabrication=0 release-gate)가 string + string[]만 정제하고 **nested object는 무가공 통과** → 조작된 `meta.note` 같은 leaf가 게이트를 타고 PERSIST되던 갭. nested-object 분기 추가: 각 조작 string leaf 정제(grounded+non-string leaf 보존), array 분기와 동일 partial-vs-empty `dropped` 계약. 게이트를 값-형태 전체에 total화.
- 왜: fabrication=0은 release gate(CLAUDE.md). 게이트가 string-only면 object-valued arg가 우회로. 형제-감사로 `!Array.isArray` 가드 추가(mixed array가 object 분기에서 index-key 객체로 손상되는 버그를 같은 fire에 차단).
- 리뷰지점: 다양성 — (agent-core, grounding-floor) 3회였으나 kind=anti-fabrication은 신규 (pkg,kind). 정직한 caveat: **현재 object-valued grounded arg를 쓰는 도구 0개**(전부 string/`tags` string[]) — 도구가 그 형태를 ship하기 전 선제 차단(방어적, gold-plating 아님 — ④b가 grep으로 확인). residual: 1-level(array-of-objects/object-in-object 미재귀, 실제 caller 나오면).
- 리스크: 낮음 — 순수 additive(string/string[] 경로 불변, 회귀 테스트 그대로), no-corruption/no-aliasing 실증(④b). ④b Opus 적응형 judge PASS.
- note: fire 6은 v2 적응형 judge가 한국어 패턴 68% 오탐을 잡아 rollback(organic verifier-catch — 합성 드릴보다 강한 증거). allPASS 스트릭 fire 6에서 리셋 → fire 7부터 재시작.

## fire 6 · 2026-06-20 · skill v2.0 · NO-SHIP (rolled back)
meta: value-class=new-capability · pkg=@muse/agent-core · kind=grounding-floor/multilingual-injection · verdict=FAIL(④b)→ROLLBACK · firesSinceDrill=6
ratchet: testFiles 1055→1055 (slice reverted) · fabrication 0 · no code shipped · branch==main
- 무엇: fire 3의 형제-감사 — 영어 패턴 2(output-clamp)·3(role-hijack)의 한국어 아날로그 2패턴을 MEMORY_INJECTION_PATTERNS에 추가 시도. MUTATION-FIRST RED→GREEN 통과, pnpm check/lint/precheck:grounding 전부 green이었으나 ④b 적응형 Opus judge가 FAIL.
- 왜 FAIL: benign 한국어 노트 **13/19(68%) false-positive**. `만`/`처럼`이 한국어 최빈 조사라 "친구처럼 말해줬다"·"결과만 출력"·"이제 너는 …했다" 같은 일상 서술을 노트 한복판에서 중성화(파괴). 내 benign 테스트가 "친구처럼 편한"(형용사)만 골라 놓침 — 적응형 judge가 일상 simile/서술형 동사를 공략해 잡아냄.
- 리뷰지점: v2 적응형 적대 judge + MUTATION-FIRST 게이트가 **정확히 의도대로 작동** — 결정론 게이트 전부 통과한 슬라이스를 행동-수준 false-positive로 막음(고정 체크리스트였으면 통과했을 것). 롤백으로 한국어 사용자의 자기-노트 보호.
- 리스크: 0 — 코드 미반영(git restore), 저널/backlog 학습만 커밋.
lesson: 정규형 injection 패턴은 *희소 토큰*(command-noun+override-verb)에 앵커해야 한다 — `만`/`처럼`처럼 흔한 조사+일상 동사에 앵커하면 사용자 자기-노트를 대량 오탐. 새 locale 패턴은 작은 benign 테스트가 아니라 **대규모 benign 코퍼스로 STABLE 0 오탐** 검증 후에만 land.

## fire 5 · 2026-06-20 · skill v1.14.0 · e0916bd7
meta: value-class=new-capability · pkg=@muse/multi-agent · kind=orchestration/verifier-gated-resynthesis · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1054→1054 (+5 cases lead-worker.test + 1 ask-decompose retry case + reflection-guard registry) · fabrication 0 · @muse/multi-agent 123 tests green · eval:orchestration PASS · pnpm check exit 0 · lint clean
- 무엇: `runLeadWorkerTask`가 synthesis 불완전 시 flag만 하던 것(H1) → verifier-gated 1회 re-synthesis. `runSynthesis` 헬퍼로 리팩터, retry 프롬프트가 drop된 하위결과를 명시(`reinforceSynthesisRequest`), retry가 **검증됐고 drop 수 strictly 감소** 시에만 채택. reflection-guard registry 등록(verifier=verifySynthesisCoverage).
- 왜: MAST done-by-self-report 보완 — 떨어진 하위결과를 경고만 말고 1회 복구. arXiv 2510.18254: 외부 verifier 없는 bare retry는 85% 실패 반복 → 결정론 verifier 백킹 필수.
- 리뷰지점: never-worsens 불변식(drop 수 strictly 감소만 채택, ④b 전케이스 검증) + errored-verifier retry는 flag 미클리어(거짓 완전성 주장 안 함, judge caveat을 in-fire 강화). ask-decompose 소비자 테스트는 4-run(complete)·5-run(retry 1회)로 정직 분리(git show로 회귀 아님 확인). bounded 1회(loop 없음).
- 리스크: 낮음 — no-verifier/throw 경로 back-compat 동일, synthesize 순수텍스트(부수효과 0). ④b Opus 적대 judge PASS (5문항 + git-history 정직성 검증).

## fire 4 · 2026-06-20 · skill v1.14.0 · 54c24b66
meta: value-class=new-capability · pkg=@muse/model · kind=local-tool-calling/schema-sanitizer · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1054→1054 (+7 cases in adapter-ollama.test.ts) · fabrication 0 · @muse/model 325 tests green · eval:tools PASS (live local) · pnpm check exit 0 · lint clean
- 무엇: Ollama 네이티브 /api/chat tool 투영이 `inputSchema`를 무가공 전송 — Gemini는 `sanitizeGeminiSchema`가 있는데 Ollama는 없어 union `type`(`["string","null"]`)·nullable anyOf/oneOf가 llama.cpp GBNF tool 문법을 조용히 깨뜨림. `sanitizeOllamaToolSchema`(union→non-null, nullable anyOf→단일 branch, null branch drop, $schema/$id strip, depth64+cycle 재귀) 추가 후 투영에 배선.
- 왜: tool-calling.md 핵심 = 로컬 모델이 한 샷에 올바른 도구 선택. 깨진 스키마는 도구를 통째로 드롭시켜 선택조차 불가. Gemini sanitizer 선례 미러링(parity, 발명 아님).
- 리뷰지점: nullable→non-null collapse는 optionality를 `required`가 이미 운반하므로 무손실(required 불변 확인); triple-union은 첫 non-null로 좁힘(GBNF는 단일 type 필요, lossy지만 valid). clean 스키마는 구조적 동일(회귀 0). eval:tools green은 약한 증거(Muse 도구는 flat) — mutation 테스트가 핵심 증거.
- 리스크: 낮음 — 순수 additive(clean 스키마 pass-through), cyclic/deep 안전 degrade(④b 실증). ④b Opus 적대 judge PASS (5문항, 적대 스키마 프로빙).

## fire 3 · 2026-06-20 · skill v1.14.0 · 8c91315c
meta: value-class=new-capability · pkg=@muse/agent-core · kind=grounding-floor/multilingual-injection · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1054→1054 (+1 describe / 3 cases in injection.test.ts) · fabrication 0 · agent-core 2477 tests green · precheck:grounding 2/3 PASS pass^2 · pnpm check exit 0 · lint clean
- 무엇: `MEMORY_INJECTION_PATTERNS`(stored/tool-output 중성화기)가 영어 전용 4패턴이라 한국어 주입("이전 지시를 무시하고…")이 든 poisoned 노트/tool-output이 `neutralizeInjectionSpans`를 통과하던 grounding-floor 구멍. 좁은 한국어 패턴 1개(canonical ignore-instructions의 한국어 아날로그, 명사→무시/잊 어순) 추가.
- 왜: 진안은 한국어 사용자라 한국어 노트를 저장 — identity-critical 표면. policy의 broad 한국어 세트가 아니라 패턴 1의 좁은 아날로그만 추가해 자기-노트 false-positive 최소화(broad 세트는 양성 한국어 prose 훼손).
- 리뷰지점: 양성 한국어("그 규칙은 무시해도 된다" 등)는 영어 baseline과 동일한 class의 span-scoped collateral만 — 주변 노트는 보존(④b가 6개 실증). u-flag는 g-flag 재구성에서 보존, ReDoS 없음(259ms@50k). 정직한 residual: act-as/output-only 한국어 아날로그 미커버(T1-a-ko-resid).
- 리스크: 낮음 — 순수 additive(패턴 1개 append, 기존 영어/homoglyph/zero-width 탐지 불변). ④b Opus 적대 judge PASS (5문항, false-positive 실증 분석 포함).

## fire 2 · 2026-06-20 · skill v1.14.0 · 5efdf345
meta: value-class=wiring · pkg=@muse/mcp · kind=outbound-safety/audit-completeness · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1054→1054 (+1 describe / 4 cases in test/consented-action.test.ts) · fabrication 0 · @muse/mcp 1860 tests green · pnpm check exit 0 · lint clean
- 무엇: `performConsentedAction`(@muse/mcp)가 어떤 분기에서도 action-log를 안 남기던 rule-4 갭 — opt-in `actionLogFile?`/`now?`/`idFactory?` + `log()` 헬퍼 추가, 7개 return 분기(veto/no-consent/invalid-url/host-mismatch/timeout-or-transport-failed/redirect/performed) 모두에 rationale 동반 `ActionLogEntry` append.
- 왜: outbound-safety rule 4 = "sent OR refused 막론 모든 outbound는 리뷰가능 entry 기록". standing-objective 루프에 배선되기 전에 감사 공백을 닫는다. web-action.ts 선례 미러링(동일 await-log-before-return 패턴).
- 리뷰지점: credential(Bearer)은 어떤 필드에도 안 들어감(authorization 헤더 전용); body는 redactSecretsInText+500자 캡; actionLogFile 부재 시 무로그(back-compat). Residual: caller가 credential을 request.body에 직접 넣으면 generic 토큰은 redaction 미스 가능 — caller 데이터 문제(web-action 동일), Muse 자기-credential 재주입 위협은 차단.
- 리스크: 낮음 — 순수 additive(제어흐름·게이트 outcome 불변). 로깅 실패 전파는 web-action 선례와 동일. ④b Opus 적대 judge PASS (5문항: 7분기 완전성 enumerate 확인).

## fire 1 · 2026-06-20 · skill v1.14.0 · f8ef07f8
meta: value-class=micro-fix · pkg=@muse/agent-core · kind=grounding-floor/injection-hardening · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1054→1054 (+3 cases in injection.test.ts) · fabrication 0 · precheck:grounding 2/3 PASS pass^2 (faithfulness-rate env-skip) · pnpm check exit 0 · lint clean
- 무엇: `MEMORY_INJECTION_PATTERNS`의 fake-system 패턴 `/^\s*system\s*[:>]/iu` → `/imu` (`m` 멀티라인 플래그 추가). prose 중간에 주입된 `\nsystem:` 역할-하이재킹 라인(공격자가 양성 lead-in을 앞에 붙이는 흔한 회피)을 이제 모든 grounding/tool 표면에서 중성화.
- 왜: 기존 `^`는 문자열 맨 앞만 매칭 → 양성 텍스트 뒤 새 줄의 `system:` payload가 패턴 1-3(ignore/act-as/output-clamp)을 피하면 전부 통과. `m`은 라인 시작 매칭을 추가하는 superset이라 기존 탐지를 약화하지 않고, span만 교체해 prose 무손상. `normalizeForInjectionDetection`이 개행을 보존하므로 정규화 후에도 동작.
- 리뷰지점: 라인 시작 `system:`을 가진 양성 로그-덤프 라인은 그 span만 `[removed: injected instruction]`로 교체됨(untrusted 표면에선 허용 가능한 collateral). colon/`>` 없는 "system" 언급은 무손상(benign 테스트로 확인).
- 리스크: 없음 — git diff = 1-char 플래그 + additive 3-case 테스트 블록. agent-core 2474 테스트 + 전 워크스페이스 `pnpm check` green, 다른 소비자 회귀 0. ④b Opus 적대 judge PASS (4문항 전부 구체 증거).
