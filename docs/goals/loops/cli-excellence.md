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

## fire 3 · 2026-06-21 · skill v2.1.0 · 7cf0571e
meta: value-class=new-capability · pkg=@muse/cli · kind=first-screen/identity-copy · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +1 (muse-identity.ts new; tests in program-help+muse-banner) · @muse/cli 2900 green · smoke:cli 9/9 · lint 0 · fabrication 0

- **무엇**: 두 첫화면 태그라인을 단일 진실원 const `MUSE_TAGLINE`("The personal AI that learns you — local-first, private by default")로 정렬. `muse --help` 설명("Model-agnostic inspirational AI agent")과 REPL 배너 태그라인("your personal AI agent & assistant") 둘 다 generic·불일치였음 → 새 `muse-identity.ts` const를 program.ts(.description)와 muse-banner.ts(tagline)에서 공유. 여신 아트 불가침(태그라인 라인만 교체).
- **왜**: 사용자가 첫화면에서 가장 먼저 읽는 헤드라인이 제품 정체성("Learns you, not the world"·local-first)을 숨기고 generic LLM 래퍼처럼 보였다. 단일 const로 두 표면이 drift 불가(fire 1의 단일-진실원 패턴 재적용).
- **리뷰지점**: 와이어링 테스트가 실제 렌더(배너 문자열 + outputHelp) grade, mutation-first RED 확인(const 변형→identity+banner RED; .description/tagline 와이어링 변형→해당 테스트 RED). 라이브 `--help`+배너 둘 다 새 태그라인 표시 확인. 독립 Opus ④b judge PASS(7/7). grounding: CLAUDE.md 정체성 + local-only 기본 posture에 근거.
- **리스크**: 낮음. diff 5파일(muse-identity.ts 신규 + program.ts + muse-banner.ts + 2 테스트). 다양성: fire1=info-projection(status)→fire2=onboarding(--help quickstart)→fire3=identity-copy(태그라인, --help+배너), 다른 kind.
- **레퍼런스**: claude-code/gemini-cli 첫화면 헤드라인·정체성 표기 관행. https://shipyard.build/blog/claude-code-vs-gemini-cli/
- note: 풀 `pnpm check`는 @muse/model/web-search-policy property-fuzz가 "Test timed out 5000ms"(8.6s)로 1개 RED였으나 — 박스 포화(~17 동시 루프)發 false-timeout(격리 재실행 384 green, 내 @muse/cli 슬라이스 무관). [[project_test_hygiene_loop]] 패턴. 슬라이스 자체는 build/narrow-test/mutation/smoke/lint 전부 green이라 출하.

## fire 4 · 2026-06-21 · skill v2.1.0 · c9fc1ce6
meta: value-class=new-capability · pkg=@muse/cli · kind=render · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +0 (2 cases into chat-ink-render.test.ts) · @muse/cli HUD 테스트 격리 green · smoke:cli 9/9 · lint 0 · fabrication 0

- **무엇**: 인터랙티브 chat REPL 하단 HUD에 local-only posture 배지 추가 — model 뒤에 `🔒 local`(green) / `⚠ cloud`(yellow). `evaluateLocalOnlyPosture(process.env).enabled`(doctor·status와 동일 진실원)에서 파생, `proactiveOn` prop 흐름 그대로 미러. props.localOnly 추가 + runChatInk 계산 + HUD 렌더.
- **왜**: 가장 많이 보는 첫화면(라이브 REPL)이 Muse #1 정체성(클라우드 egress 차단)에 침묵했다. fire1(status)·fire3(태그라인)에 이어 세 첫화면(--help/배너/status/HUD)이 이제 모두 posture 일치 — fabrication 0(불리언에 strict).
- **리뷰지점**: ink-testing-library가 실제 렌더 프레임(lastFrame) grade(on→🔒/off→⚠), mutation-first RED 확인(배지 상수화→off-case RED). required prop이라 모든 생성자(runChatInk + test makeProps)가 공급 → undefined 렌더 없음(tsc 보증). 독립 Opus ④b judge PASS(7/7). 여신 아트 불가침.
- **리스크**: 낮음. diff 2파일(chat-ink.ts + 테스트). chat-ink.ts는 고-contention이라 다음 머지서 충돌 가능 — HUD 세그먼트는 독립 flex child라 격리적. 다양성: fire1 info-projection→fire2 onboarding→fire3 identity-copy→fire4 render, 모두 다른 kind.
- **레퍼런스**: starship/oh-my-posh 상태 세그먼트(prompt에 posture 배지) 관행. https://starship.rs/
- note: 풀 @muse/cli test에 2 RED 있었으나 둘 다 "Test timed out 5000ms"(document-reader PDF 5251ms, 기존 /forget 6992ms) — 박스 포화 false-timeout, 격리 재실행 둘 다 green, 내 HUD 테스트 아님. 슬라이스 게이트(build/HUD-test격리/mutation/smoke/lint) 전부 green이라 출하.

## fire 5 · 2026-06-21 · skill v2.1.0 · 915df67a
meta: value-class=perf+correctness · pkg=@muse/cli · kind=perf · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +1 (muse-version.test.ts, 7 cases) · `muse --version` ~500ms→~90ms · 0.0.0→0.1.0 정정 · lint 0 · fabrication 0

- **무엇**: `muse --version` 프리-프레임워크 fast-path. index.ts가 program.ts(~100+ 모듈 그래프)를 정적 import해 사소한 `--version`도 ~0.5s 세금을 냈음 → 새 leaf `muse-version.ts`의 `tryVersionFastPath`로 `--version`/`-V`만 프레임워크 전에 처리+exit, 그 외엔 program.ts를 **dynamic import**(그래프 우회의 핵심). 동시에 `.version("0.0.0")`(실제 0.1.0과 불일치 = wrong-info 버그)을 단일 진실원 `MUSE_CLI_VERSION`으로 교체.
- **왜**: `--version`은 래퍼/셸-컴플리션/CI 헬스체크가 가장 자주 치는 프로브인데 풀 import 세금을 냄(③ 시작 속도). 측정: fast-path ~90ms vs full-graph(--help) 수초(포화). 또 첫화면 버전 문자열이 틀렸음(tag v0.1.0/CHANGELOG/root pkg = 0.1.0). 단일 const + root-pkg drift 테스트로 미래 divergence 차단.
- **리뷰지점**: 테스트가 실제 출력(fast-path write 문자열·commander `.version()`·라이브 dist) grade, mutation-first RED(version→0.0.0이 drift/stale RED; guard→false가 handled RED). dynamic import가 dispatch 보존(--help/mcp/scheduler/spec/chat --help 전부 동작). fast-path는 정확히 `--version`/`-V`만(length===1), 그 외 fall-through. 독립 Opus ④b judge PASS(7/7). 여신 아트 불가침.
- **리스크**: 낮음. diff 4파일(index.ts·program.ts 1줄·muse-version.ts 신규·테스트). 다양성: fire1-4(info-projection/onboarding/identity-copy/render, posture/identity value-class) → fire5 **perf 축**(startup-cost), 명확히 다른 kind/value-class.
- **레퍼런스**: CLI 시작-성능 최적화(--version/--help는 최빈 호출, lazy-load가 최대 win). https://github.com/oclif/oclif/issues/606
- note: smoke:cli 7 pass / 2 fail(`muse chat`·`--stream` "got null"=spawnSync 30s 타임아웃, 박스 포화). **A/B 격리**: index.ts를 원래 static import로 되돌려 rebuild→재실행해도 동일 2 chat 라운드트립이 똑같이 실패 → 내 슬라이스 탓 아님(포화/머지發). 비-라운드트립 프로브(`--version` 포함) 전부 PASS. 슬라이스 게이트(build/버전테스트 격리 7/7/mutation/lint) green이라 출하.
- lesson: stop-condition 게이트(smoke:cli)가 RED일 때 "환경 탓"이라 단정 말고 **A/B로 격리**(내 변경을 임시 되돌려 동일 실패 재현 확인)하면 회귀-아님을 증명할 수 있다. git stash 금지라 `cp`로 임시 백업/복원.

## fire 6 · 2026-06-21 · skill v2.1.0 · 1b6a01c1
meta: value-class=empty-state · pkg=@muse/cli · kind=empty-state · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +0 (4 cases into commands-notes-rag.test.ts) · @muse/cli notes-rag 테스트 격리 green · lint 0 · fabrication 0

- **무엇**: `muse notes reindex`가 마크다운 0개일 때도 `Done. 0 embedded, 0 cached, 0 failed`를 찍어 silent-failure와 구분 불가였음 → `ReindexSummary.totalFiles`(additive) + 순수 `formatReindexOutcome`가 totalFiles===0이면 액션-담은 빈-상태("No notes to index — found 0 ... under <dir>" + `muse note` + `MUSE_NOTES_DIR` + ask/recall 안내) 출력, 아니면 기존 Done 라인. found-but-all-failed 경로는 불변(Done+counts+Ollama 안내 유지).
- **왜**: RAG over notes가 second-brain 근간(ask/recall/today --connect/status). `muse setup local` 직후 첫 reindex에서 빈/오설정 vault면 막다른 길이었다(NN/G "totally empty state" 안티패턴). 모든 수치=fs walk, 모든 제안 명령=실재(fabrication 0).
- **리뷰지점**: 테스트가 헬퍼 반환 문자열 + 실제 tmp-dir totalFiles + 라이브 명령 grade(선언 아님), mutation-first RED(빈-상태 분기 비활성화/totalFiles 0-고정 둘 다 RED). all-failed 엣지가 빈-상태에 안 먹힘을 judge가 독립 확인. 독립 Opus ④b judge PASS(7/7). 여신 아트 불가침, 저-contention 파일.
- **리스크**: 낮음. diff 2파일(commands-notes-rag.ts + 테스트). totalFiles는 additive(타 호출부 3곳 필드만 읽음, shape assert 없음). 다양성: fire1-5(info-projection/onboarding/identity-copy/render/perf) → fire6 empty-state, 새 kind.
- **레퍼런스**: NN/G empty-state 디자인 가이드(빈 상태는 다음 행동을 제시해야). https://www.nngroup.com/articles/empty-state-interface-design/
- note: smoke:cli 7 pass / 2 fail(`muse chat`·`--stream` "got null"=30s 타임아웃) — fire 5에서 A/B로 환경성 확정한 그 프로브, 내 슬라이스는 notes 경로라 chat/api 무관(신규 실패 0).

## fire 7 · 2026-06-21 · skill v2.1.0 · 305b844b
meta: value-class=error-guidance · pkg=@muse/cli · kind=error-guidance · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0 (3 cases into program-help.test.ts) · @muse/cli formatUnknownCommand 격리 green · lint 0 · fabrication 0

- **무엇**: unknown `muse <x>`가 가까운 매치 없을 때 "unknown command" + "run --help"(100+ 덤프)로 막다른 길이었음 → 순수 `formatUnknownCommand` 추출: near-miss "Did you mean" 경로 불변, no-match엔 POPULAR(chat·ask·status·today·remember·setup) 발견 on-ramp 추가. POPULAR을 **라이브 레지스트리(listAllCommandNames)와 교집합** → 실재 명령만 표시(fabrication 0).
- **왜**: 오타/새 유저 추측 시 막다른 길 대신 데일리-드라이버 명령으로 안내. claude-code/git의 "did you mean" + 발견 힌트 관행. 모든 이름이 등록된 실명령(교집합 보증).
- **리뷰지점**: 테스트가 반환 문자열(near-miss vs no-match vs 레지스트리-교집합) + 라이브 출력 grade, mutation-first RED(POPULAR 비우면 2 테스트 RED, near-miss는 green 유지). near-miss 경로 바이트동일 보존 + exitCode=1 유지. 기존 테스트가 옛 문구 assert 안 함(회귀 0). 독립 Opus ④b judge PASS(7/7). 여신 아트 불가침.
- **리스크**: 낮음. diff 2파일(program.ts + 테스트). 다양성: fire1-6(info-projection/onboarding/identity-copy/render/perf/empty-state) → fire7 error-guidance, 새 kind.
- **레퍼런스**: git "did you mean" + CLI 발견성(unknown→top commands) 관행. https://www.npmjs.com/package/commander
- note: smoke:cli 7 pass / 2 fail = fire 5 A/B 확정 chat 라운드트립 환경 타임아웃, 내 unknown-command 변경과 무관(`muse --help` 프로브 PASS).
