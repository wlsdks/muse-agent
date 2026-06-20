# core-hardening — Muse 코어 엣지 강화 루프 journal

> Theme: Muse의 코어 엣지(결정론적 grounding+citation 게이트 + 4 표면 memory-integrity·self-development·orchestration·grounding-floor) 강화·하드닝.
> Worktree `/tmp/muse-core-hardening` · branch `loop/core-hardening` (Tier2 — pushes to its own branch each fire, periodic rebase from origin/main). **Every 3 fires: ff-merge the branch into origin/main, then keep working on the branch (진안 directive 2026-06-20).**
> Cron `cfe778e2` (every 15m, session-only). Stop: `CronDelete cfe778e2`. Convention: [README](README.md).

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
