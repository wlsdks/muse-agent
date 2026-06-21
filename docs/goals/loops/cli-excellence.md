# Loop journal — `cli-excellence`

Theme: muse CLI를 타사 대비 최고급으로 — ① 첫 화면 완성도 ② 표시 정보(상태/근거/학습/안내/진행) 품질 ③ CLI 성능. 여신 마스코트 아트는 진안 소유(불가침). Tier2 (worktree `/tmp/muse-cli-excellence`, branch `loop/cli-excellence`, push + PR; main 머지는 진안). cron `a4520c8e` (20m, session-only).

Convention: [README](README.md).

## fire 1 · 2026-06-21 · skill v2.1.0 · 29414fb0
meta: value-class=new-capability · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +0 (added 5 cases to existing commands-status.test.ts) · @muse/cli 2881 green · check exit 0 · smoke:cli 9/9 · lint 0 · fabrication 0

- **무엇**: `muse status` at-a-glance 대시보드 + `--json` 스냅샷에 프라이버시 posture(local-only) 라인 추가. 새 export 순수 헬퍼 `formatPrivacyPosture(snapshot)` + `collectStatus`에 `localOnly: evaluateLocalOnlyPosture(process.env)`(additive, schema v1 유지) + `renderStatus` providers 블록 뒤 `privacy:` 라인 1줄.
- **왜**: Muse의 #1 정체성("local by default, cloud egress refused")이 `muse doctor`엔 있으나 매일 보는 at-a-glance 첫화면 대시보드엔 누락이었다. facts는 doctor와 **동일한 단일 진실원** `evaluateLocalOnlyPosture`에서 파생 → 두 표면이 posture를 두고 절대 어긋날 수 없다. fabrication=0: 4분기 문구가 각 (enabled,status)에 strictly entailed("egress blocked/possible", "no cloud credentials").
- **리뷰지점**: 문구는 glance-sized(detail-verbatim 아님)이고 정밀 진단(어떤 클라우드 키/off-box 임베더 URL)은 `muse doctor`로 위임 — 단일 진실원은 facts(enabled/status)이지 prose가 아니므로 divergence 없음. 독립 Opus ④b judge PASS.
- **리스크**: 낮음. diff는 commands-status.ts + 그 테스트로 한정. 여신 아트 불가침 준수. ④b judge가 잡은 nit(와이어링 테스트가 canonical 5개 클라우드 키 중 4개만 삭제 → GOOGLE_API_KEY 누락)은 즉시 하드닝(5개 전부 삭제)으로 수정함.
- **레퍼런스**: claude-code(트리 포맷)·gemini-cli(박스 레이아웃)·starship/oh-my-posh(at-a-glance 상태 표기) 첫화면 관행 — 표시 정보는 "한눈에, 정직하게". https://shipyard.build/blog/claude-code-vs-gemini-cli/ · https://github.com/ratatui/ratatui

### sibling-audit (이번 fire 미적용 → backlog)
- chat REPL 하단 HUD(chat-ink.ts:822-833)는 model·proactive·agent·tools·skills·tokens를 보여주나 **local-only posture 미표시** — 같은 클래스 형제. 공간 제약 + 라이브 상태라 별도 fire로(다른 (pkg,kind)).

## fire 2 · 2026-06-21 · skill v2.1.0 · 009800bf
meta: value-class=new-capability · pkg=@muse/cli · kind=first-screen/onboarding · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +1 (program-help.test.ts) · @muse/cli 2895 green · check exit 0 · smoke:cli 9/9 · lint 0 · fabrication 0

- **무엇**: `muse --help` / 비-TTY 첫화면(파이프·CI·`muse | cat`)에 local-first "60초 quickstart" 블록 추가. 순수 export `museQuickstartHelp()` + `createProgram`에서 `addHelpText("after", …)` 와이어링. 4개 실명령(muse / muse setup local / muse remember / muse status) + "LOCAL model by default; cloud egress refused unless you opt out" 정체성 리드.
- **왜**: commander 기본 help는 명령 나열만 — 첫 발견자에게 "뭘 먼저 할지"도 "로컬-우선"도 안 알려줬다. 60초-to-value(웹 리서치 벤치마크)를 첫화면에 직접. fabrication=0: 모든 줄이 실명령, 클레임은 local-only-policy.ts/CLAUDE.md에 grounded.
- **리뷰지점**: 와이어링 테스트가 실제 렌더 출력을 grade(선언 아님), mutation-first RED 확인. 루트 addHelpText("after")는 서브커맨드 help로 새지 않음(muse status --help에 quickstart 0회). diff는 program.ts + 새 테스트로 한정, 여신 아트 불가침. 독립 Opus ④b judge PASS(6/6).
- **리스크**: 낮음. 다양성: fire1=info-projection(status) → fire2=first-screen(--help), 다른 kind.
- **레퍼런스**: gemini-cli vs claude-code 첫화면 비교 + 60초-to-value 온보딩. https://shipyard.build/blog/claude-code-vs-gemini-cli/ · https://www.appcues.com/blog/best-user-onboarding-examples
- lesson: 동시-루프 환경에서 fire 시작 fetch는 금세 stale → 머지가 끌어온 raw-NUL byte-hygiene 회귀를 자체 수정하려다, origin/main이 이미 canonical 픽스(commit 4871aca9, backslash-u-0000 escape)를 가진 걸 발견 → 자체수정 폐기하고 최신 origin/main 재머지로 canonical 픽스 채택. 교훈: 머지가 끌어온 회귀는 자체 패치 전에 origin이 이미 고쳤는지 먼저 확인(divergent fix 회피). 또 self-eval은 풀 테스트 미실행이라 byte-hygiene 회귀를 못 잡음 — `pnpm check`가 진짜 게이트.
