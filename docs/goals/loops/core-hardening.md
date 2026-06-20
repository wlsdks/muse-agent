# core-hardening — Muse 코어 엣지 강화 루프 journal

> Theme: Muse의 코어 엣지(결정론적 grounding+citation 게이트 + 4 표면 memory-integrity·self-development·orchestration·grounding-floor) 강화·하드닝.
> Worktree `/tmp/muse-core-hardening` · branch `loop/core-hardening` (Tier2 — pushes to its own branch each fire, periodic rebase from origin/main, NEVER merges to main).
> Cron `cfe778e2` (every 15m, session-only). Stop: `CronDelete cfe778e2`. Convention: [README](README.md).

## fire 1 · 2026-06-20 · skill v1.14.0 · f8ef07f8
meta: value-class=micro-fix · pkg=@muse/agent-core · kind=grounding-floor/injection-hardening · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1054→1054 (+3 cases in injection.test.ts) · fabrication 0 · precheck:grounding 2/3 PASS pass^2 (faithfulness-rate env-skip) · pnpm check exit 0 · lint clean
- 무엇: `MEMORY_INJECTION_PATTERNS`의 fake-system 패턴 `/^\s*system\s*[:>]/iu` → `/imu` (`m` 멀티라인 플래그 추가). prose 중간에 주입된 `\nsystem:` 역할-하이재킹 라인(공격자가 양성 lead-in을 앞에 붙이는 흔한 회피)을 이제 모든 grounding/tool 표면에서 중성화.
- 왜: 기존 `^`는 문자열 맨 앞만 매칭 → 양성 텍스트 뒤 새 줄의 `system:` payload가 패턴 1-3(ignore/act-as/output-clamp)을 피하면 전부 통과. `m`은 라인 시작 매칭을 추가하는 superset이라 기존 탐지를 약화하지 않고, span만 교체해 prose 무손상. `normalizeForInjectionDetection`이 개행을 보존하므로 정규화 후에도 동작.
- 리뷰지점: 라인 시작 `system:`을 가진 양성 로그-덤프 라인은 그 span만 `[removed: injected instruction]`로 교체됨(untrusted 표면에선 허용 가능한 collateral). colon/`>` 없는 "system" 언급은 무손상(benign 테스트로 확인).
- 리스크: 없음 — git diff = 1-char 플래그 + additive 3-case 테스트 블록. agent-core 2474 테스트 + 전 워크스페이스 `pnpm check` green, 다른 소비자 회귀 0. ④b Opus 적대 judge PASS (4문항 전부 구체 증거).
