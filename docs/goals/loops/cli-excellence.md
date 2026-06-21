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

## fire 8 · 2026-06-22 · skill v2.1.0 · f2dba36f
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=8
ratchet: testFiles +0 (1 case into commands-status.test.ts + 1 existing assertion updated) · @muse/cli 2953 green · check 0 · smoke:cli 9/9 · lint 0 · fabrication 0

- **무엇**: `muse status` at-a-glance 대시보드의 7개 raw UTC ISO 타임스탬프(last update/followups next/episodes last/patterns last/reminders next/cost as of/last notice)를 공유 `formatRelativeTime`로 humanize — ≤7d "3h ago"/"in 2d", >7d 읽기쉬운 로컬datetime, invalid 그대로. `--json`/collectStatus는 raw ISO 유지(머신 소비자).
- **왜**: at-a-glance인데 `2026-06-05T19:34:48.334Z`는 한눈에 안 읽힘(진안 실사용 관찰). 결정론 변환(fabrication 0), 기존 헬퍼 재사용.
- **리뷰지점**: LIVE hands-on(`node dist/index.js status` → `last update: 2026-06-06 04:34` 확인), mutation-first RED(rel 제거→raw ISO), 새 테스트 seeds now-3h→"3h ago". ★maker≠judge가 값을 함: ④b judge가 **풀 스위트 회귀**(program.test.ts cost line이 raw ISO assert) 적발→FAIL→기존 assertion을 humanized 형태(formatLocalDateTime)로 수정→재판정 PASS(5/5). 형제-감사: 다른 status ISO assertion 전수 grep(없음). 여신 아트 불가침.
- **리스크**: 낮음. diff: commands-status.ts + 그 테스트 + program.test.ts 기존 assertion 1개.
- lesson: 표시 렌더를 바꾸면 좁은 파일 테스트(commands-status.test.ts)만 보지 말고 **풀 @muse/cli 스위트**로 cross-file assertion 회귀(program.test.ts가 옛 출력 pin)를 잡아야 한다 — 형제-감사는 src 형제뿐 아니라 그 출력을 assert하는 테스트 형제까지.
- 레퍼런스: starship/lazygit 등 at-a-glance 상태표기는 상대시간 관행. https://starship.rs/

## fire 9 · 2026-06-22 · skill v2.1.0 · 991c1de7
meta: value-class=render+identity-copy · pkg=@muse/cli · kind=render · verdict=PASS · firesSinceDrill=9
ratchet: 변경연관 테스트만 실행(발열정책) · muse-banner.test 3/3 · 라이브 렌더 확인 · lint 0 · fabrication 0

- **무엇**: 진안 첫화면 피드백 반영. ① 태그라인(+status/hint) 들여쓰기 3→2칸(아트·chat-ink paddingLeft:2 recap/입력과 동일 컬럼) ② 태그라인 밑 장식용 cyan rule(`─`×38) 제거(+테스트의 그 색 의존 제거) ③ 마스코트 64→**56열** 재생성(gen-mascot-ansi.mjs, 동일 hi-res 마스터, sextant로 화질 유지; 진안이 56 선택). +버전 drift 0.1.0→0.1.1(v0.1.1 릴리스, fire-5 가드가 잡음).
- **왜**: 진안이 라이브 스플래시 보고 지적 — 태그라인 좌측 공백 과다(3 vs 2), 하늘색 줄 정체불명, 캐릭터 큼. 마스코트는 진안 명시 지시로 리사이즈(소유자 승인).
- **리뷰지점**: 라이브 hands-on(태그라인 2칸·rule 없음·`--version` 0.1.1) + 마스코트 56 preview-png를 Read로 화질 확인(64/52/44 비교 후 56 선택, 눈·얼굴·머리·후광 또렷). mutation-first(배너 테스트). ★④b judge가 색-모드 assertion이 제거된 rule에 의존했음을 검증하고 `\x1b[38`(마스코트 트루컬러)로 교체가 cheat 아님을 확인. byte-hygiene raw 0x1B=0. 독립 Opus ④b PASS(7/7).
- **리스크**: 낮음. diff 4파일(banner/test/mascot/version). 마스코트 재생성은 머신 생성(byte-identical 재현). 다양성: render kind.
- live: `node dist/index.js` 스플래시 = 마스코트(56×33) → 2칸 태그라인 → (rule 없음); preview PNG로 56열 화질 양호 확인.
- 레퍼런스: starship/lazygit 좌정렬 단일컬럼 splash; sextant(U+1FB00) 2×3 서브픽셀 렌더. https://starship.rs/
- ★발열 정책 전환(진안 2026-06-22): 이 fire부터 풀 스위트/`pnpm check`/smoke 매-fire 금지 → 변경연관 vitest 파일만. cron 92b2d826→e5696b6a로 가벼운 ④/④b 게이트 재등록. [[feedback_minimal_test_runs]]

## fire 10 · 2026-06-22 · skill v2.1.0 · 28cbf359 · ★JUDGE-DRILL
meta: value-class=onboarding · pkg=@muse/cli · kind=onboarding · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: 변경연관 테스트만(발열정책) · chat-ink-core+chat-ink-nomodel 2 green · lint 0 · fabrication 0

- **무엇**: 새 유저가 모델 미설정으로 `muse` 실행 시 보던 `muse: no model configured yet.` 밋밋한 에러 → 정체성-리드 local-first 온보딩으로 교체. 순수 `formatNoModelMessage()`(chat-ink-core, MUSE_TAGLINE + local(free/private)·cloud(opt-in)·`muse setup wizard`) 추출 + runChatInk no-model 분기에 **배선**.
- **왜**: 첫 유저의 진짜 첫 화면(zero-config)이 제품 정체성을 안 보여줬다. 모든 명령 실재(setup local/model/wizard), local-first 기본 framing.
- **리뷰지점**: ★이 fire는 JUDGE-DRILL(firesSinceDrill=10/연속allPASS9≥8). 먼저 **inert(헬퍼+테스트만, 미배선)** 버전을 독립 ④b에 제출 → judge가 "dead code, live 경로 불변, 테스트 격리만"으로 **정확히 FAIL**(검증자 teeth 증명). 그 후 runChatInk에 배선 + **wired-path 통합 테스트**(vi.mock createMuseRuntimeAssembly→no-provider, runChatInk 구동, stderr 캡처) 추가. mutation-first 양면(카피 + 배선; 배선 되돌리면 통합테스트 RED). 재-judge PASS(6/6).
- **리스크**: 낮음. diff 4파일. early-return(exitCode=1) 보존. 다양성: onboarding kind. chat-ink.ts 국소 편집(분기 1곳).
- live: no-model 분기는 TTY 전용이라 셸 직접캡처 대신 vi.mock 통합테스트로 live 경로 grade.
- lesson: "헬퍼 추가+테스트"만으론 inert일 수 있다 — 표시-변경은 반드시 **배선된 경로를 grade하는 테스트**(여기선 vi.mock으로 runChatInk 구동)까지 있어야 진짜. JUDGE-DRILL이 이걸 실증.
- 레퍼런스: 60초-to-value 온보딩(첫 화면이 다음 행동 1개를 명확히). https://www.appcues.com/blog/best-user-onboarding-examples

## fire 11 · 2026-06-22 · skill v2.1.0 · d650e179
meta: value-class=render · pkg=@muse/cli · kind=render · verdict=PASS · firesSinceDrill=1
ratchet: 변경연관 테스트만(발열정책) · commands-doctor doctorStatusMarker 1 green · lint 0 · fabrication 0

- **무엇**: `muse doctor --local` 헬스 화면에서 WARN 체크가 중립 `·`로 렌더돼 OK `✓`와 구분 안 됨(23줄 중 "주의 필요"가 안 보임). 순수 export `doctorStatusMarker(status)` 추출(ok→✓/warn→⚠/fail→✗)해 formatLocalDoctor에 배선. warn=⚠로 스캔 가능.
- **왜**: 헬스체크의 핵심은 "뭐가 문제인지 한눈에"(brew/flutter doctor 관행). `·`는 OK와 시각 동일이라 경고가 묻혔다. 순수 presentation(분류/카운트/--full JSON 불변), ⚠는 CLI 기존 경고 글리프와 일관.
- **리뷰지점**: 테스트가 3매핑 + warn≠"·" grade(배선 확인), mutation-first RED(warn→· 되돌리면 fail). 라이브 `doctor --local`에 3 warn 모두 ⚠ 표시 확인. 형제-감사: 옛 `·` 마커 assert하는 테스트 없음(grep). 독립 Opus ④b PASS(6/6).
- **리스크**: 낮음. diff 2파일(commands-doctor.ts + 테스트). 다양성: render kind(fire 4/9 render였으나 최근8 ≥6 동일아님). 여신 아트 무관.
- live: `node dist/index.js doctor --local` → `⚠ ollama-perf…` `⚠ at-rest encryption…` `⚠ mcp.json…` + `Overall: WARN — 3 warning(s) (20 ok / 3 warn / 0 fail)`.
- 레퍼런스: brew/flutter doctor 스캔 가능 마커 관행([!]/⚠). https://docs.flutter.dev/reference/flutter-doctor

## fire 12 · 2026-06-22 · skill v2.1.0 · 03b3d3c2
meta: value-class=progress · pkg=@muse/cli · kind=progress · verdict=PASS · firesSinceDrill=2
ratchet: 변경연관 테스트만(발열정책) · commands-notes-rag 43/43(파일전체) · lint 0 · fabrication 0

- **무엇**: `muse notes reindex`의 per-file onProgress 라인에 `[i/N]` 위치 prefix 추가(found.length 중 몇 번째). 캐시(skip) 파일은 무음 유지. embedded/failed 라인만 위치 표시.
- **왜**: 긴 reindex가 위치 없이 `+path`만 흘러 "멈춘 듯" 보였다(③ 반응성). progress kind = fresh(최근 render 3회 회피). 실제 루프 index+found.length라 fabrication 0, presentation만(카운트/인덱스 불변).
- **리뷰지점**: 테스트가 실제 onProgress 캡처 grade([1/2]/[2/2]), mutation-first RED(prefix 제거→fail). 라이브 3파일 reindex로 `[1/3][2/3][3/3]` 확인. ★maker≠judge가 또 값을 함: 첫 ④b가 **형제 회귀**(corrupt-PDF 테스트가 startsWith("✗") assert) 적발→FAIL→그 assertion을 `[i/N]` prefix 반영 regex로 수정→재판정 PASS(5/5). commands-read는 별도 prefix-less emitter라 무관(14/14).
- **리스크**: 낮음. diff 2파일.
- live: `node dist/index.js notes reindex --dir <3 notes>` → `[1/3] + …a.md` `[2/3] + …b.md` `[3/3] + …c.md` `Done. 3 embedded`.
- lesson: 출력 형식을 바꾸면 **그 출력을 assert하는 모든 테스트를 grep**(startsWith/toContain)해 형제까지 같은 fire에 고쳐야 한다 — 좁은 `-t` 한 테스트만 돌리면 cross-file 형제 회귀를 놓친다(judge가 풀-파일 실행으로 잡음). 형제-감사 = src뿐 아니라 그 출력 assert 테스트까지.
- 레퍼런스: 진행 표기 `[i/N]`(npm/pip/lazygit식 위치 카운터). https://github.com/jesseduffield/lazygit

## fire 13 · 2026-06-22 · skill v2.1.0 · 40afdeec
meta: value-class=first-screen · pkg=@muse/cli · kind=first-screen · verdict=PASS · firesSinceDrill=3
ratchet: 변경연관 테스트만(발열정책) · program-help 정렬테스트 1 green · lint 0 · fabrication 0

- **무엇**: `muse --help`의 ~80 명령이 insertion 순서라 스캔 불가 → `configureHelp({sortSubcommands,sortOptions})`로 알파벳 정렬. 첫 글자로 명령 찾기 가능. 하단 quickstart는 데일리-드라이버 강조 유지. display-only(명령 추가/삭제/리네임 없음, dispatch 불변).
- **왜**: 발견성(②/① 첫화면). gh/docker는 정렬/그룹; insertion-order 80개는 벽. 정렬은 commander-native 단일 fire win(그룹화는 더 큰 작업 → 후속).
- **리뷰지점**: 테스트가 실제 outputHelp 순서 grade(chat<spec는 chat이 spec 뒤 등록이라 정렬 시에만 성립 → 우연 아님), mutation-first RED(configureHelp 제거→insertion→fail). 라이브 `--help` Commands가 A-정렬(actions/agent-notices/agents/analytics…). 형제-감사: 명령 insertion-순서 assert 테스트 없음(chat-ink /help는 별 surface). Did-you-mean 경로 무관. 독립 Opus ④b PASS(6/6).
- **리스크**: 낮음. diff 2파일. 다양성: first-screen kind.
- live: `node dist/index.js --help` Commands 섹션 알파벳순.
- ◦ FOLLOW-UP(backlog): 80 명령 카테고리 그룹화(gh식 CORE/…)는 commander helpGroup(13+)로 가능하나 큰 큐레이션 → decompose 필요.
- 레퍼런스: gh/docker 명령 그룹·정렬 관행. https://cli.github.com/manual/

## fire 14 · 2026-06-22 · skill v2.1.0 · 5c4a4640
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=4
ratchet: 변경연관 테스트만(발열정책) · commands-doctor formatDoctorSummaryLine 3 green · lint 0 · fabrication 0

- **무엇**: 기본 `muse doctor` 한 줄 요약의 raw UTC ISO stamp(`(2026-06-21T16:09:48.322Z)`)를 humanize. 순수 export `formatDoctorSummaryLine(snapshot, now)` 추출(공유 formatRelativeTime: just now/3h ago/>7d 로컬datetime/absent 생략) + 액션 배선. fire-8(status 타임스탬프) 형제-완성.
- **왜**: 헬스 스냅샷이 얼마나 stale한지 raw ISO는 암산 강요. "(just now)/(Nh ago)"가 staleness 즉시 표시. 결정론(now 주입), --full/--json/--local 경로 불변.
- **리뷰지점**: 테스트가 반환 라인 grade([ok] … (3h ago), raw ISO 없음, absent→stamp 생략), mutation-first RED(raw stamp 복원→2 fail). 라이브 `muse doctor` → `[OK] 6 섹션 — OK 6 (just now)`. 형제-감사: 옛 raw 요약 assert 테스트 없음(today의 generatedAt은 별 surface). 독립 Opus ④b PASS(6/6).
- **리스크**: 낮음. diff 2파일. DoctorSummary export는 benign. 다양성: info-projection(최근8 중 1회).
- live: `node dist/index.js doctor` → `[OK] 6 섹션 — OK 6 (just now)`.
- 레퍼런스: at-a-glance 상태는 상대시간(fire-8과 동일 패턴, brew/flutter doctor staleness 표기). https://docs.flutter.dev/reference/flutter-doctor

## fire 15 · 2026-06-22 · skill v2.1.0 · 10ca51f1
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=5
ratchet: 변경연관 테스트만(발열정책) · commands-remind formatReminderList 3 green(파일 28/28) · lint 0 · fabrication 0

- **무엇**: `muse remind list`가 지난(overdue) pending 알림을 upcoming과 동일 표시 → 무엇이 늦었는지 스캔 불가(박스에 4개 수주째 overdue 무표시). pending & dueAt<now면 `(⚠ overdue)` 추가(기존 (repeats)/(fired) suffix 컨벤션). formatReminderList export + nowMs 주입. fired는 미표시(이미 발화), bad/absent dueAt 안전 무시.
- **왜**: 늦은 항목이 한눈에 보여야 함(status는 "(N overdue)" 카운트만, list는 항목별 표시 없었음). 결정론(실 timestamp 비교), fabrication 0.
- **리뷰지점**: 테스트가 실 포맷 출력 grade(past→(⚠ overdue), future 미표시, fired 미표시), mutation-first RED(overdue 분기 끄면 fail). 라이브 4 알림 모두 `(⚠ overdue)`(반복 포함 `운동 (⚠ overdue) (repeats daily)`). 독립 Opus ④b PASS(6/6).
- **리스크**: 낮음. diff 2파일. export+optional param 후방호환. 다양성: info-projection(최근8 중 2회나 다른 surface=remind).
- live: `node dist/index.js remind list` → 각 overdue 알림에 `(⚠ overdue)`.
- 레퍼런스: 할일/리마인더 UI의 overdue 강조 관행(빨강/⚠). https://todoist.com/help

## fire 16 · 2026-06-22 · skill v2.1.0 · 335a4741
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=6
ratchet: 변경연관 테스트만(발열정책) · chat-repl formatReminderList 2 green · lint 0 · fabrication 0

- **무엇**: fire-15 형제 완성 — 인-챗 리마인더 리스트("리마인더 뭐 있어?", chat-repl formatReminderList)에도 `(⚠ overdue)`/`(⚠ 지남)` 마커. 포매터에 optional `overdue?` 추가 + 호출부(이미 pending 필터)에서 dueAt<now 계산. korean-aware.
- **왜**: `muse remind list`(fire 15)와 인-챗 경로 일관성 — 늦은 알림이 두 surface 모두에서 스캔 가능. 결정론(실 dueAt), fabrication 0, fired는 호출부 필터로 제외.
- **리뷰지점**: 포매터 테스트가 실 출력 grade(KO 지남/EN overdue, future 미표시), mutation-first RED(마커 끄면 2 fail). 인-챗 경로는 모델 intent-gated라 헤드리스 라이브 불가 — 순수 포매터 단위테스트 + 호출부 dueMs<now(fire-15 검증 로직 미러)로 충분. 독립 Opus ④b PASS(6/6). 비-pending은 호출부 필터로 도달 불가.
- **리스크**: 낮음. diff 2파일. optional 필드 후방호환. 다양성: info-projection(parity 완성).
- live(테스트 대용): 포매터 단위테스트가 마커 렌더 확인(인-챗 경로는 intent-gated).
- 레퍼런스: fire 15와 동일(overdue 강조 관행).

## fire 17 · 2026-06-22 · skill v2.1.0 · c84cdcf0
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=7
ratchet: 변경연관 테스트만(발열정책) · human-formatters 33/33 · root-eslint 0 · fabrication 0

- **무엇**: `muse tasks list`가 과거-기한 task를 upcoming과 동일 표시(박스 31개 전부 수주 overdue 무표시) → not-done & dueAt<now면 `(⚠ overdue)`(formatTaskRow). fire 15/16(reminder)의 tasks 확장. nowMs 주입, done/undated/unparseable 안전 제외.
- **왜**: daily-driver(31개)에서 늦은 일이 한눈에. 결정론, fabrication 0. ⚠는 이 파일 urgent badge에 이미 사용중이라 일관.
- **리뷰지점**: 테스트가 실 렌더 row grade(past→(⚠ overdue), future/done 미표시), mutation-first RED. 라이브 `tasks list` 31개 모두 표시. 형제-감사: 유일 caller=commands-tasks(today는 formatLocalDate만, chat-repl은 별도 formatTaskList), 기존 urgent 테스트 무사(33/33). 독립 Opus ④b PASS(5/5).
- **리스크**: 낮음. diff 2파일. nowMs optional 후방호환.
- lesson: scoped lint은 `npx eslint`(루트 flat config 못 읽을 수 있음) 대신 **`./node_modules/.bin/eslint`**로 — ④b judge가 첫 라운드에서 내가 놓친 no-regex-spaces(정규식 이중공백) 2건을 잡음. 정규식 리터럴의 연속공백은 `{2}` 양화사로.
- live: `node dist/index.js tasks list` → 과거 task에 `(⚠ overdue)`.
- 레퍼런스: fire 15/16(overdue 강조 관행).

## fire 18 · 2026-06-22 · skill v2.1.0 · e4f953f24
meta: value-class=perf · pkg=@muse/cli · kind=perf · verdict=PASS · firesSinceDrill=8
ratchet: info-projection 4연속(14-17) 깸 → perf로 전환 · 변경연관 테스트만(발열정책) · muse-spec 6/6 + program.test 243/243 · root-eslint 0 · raw-ESC 0

- **무엇**: `muse spec` / `muse spec --json`에 프리-프레임워크 fast path(fire 5 `--version` 패턴 미러). 신규 leaf `muse-spec.ts`(MUSE_RUNTIME_SPEC·formatSpec·trySpecFastPath); program.ts spec 액션은 formatSpec로 렌더(단일 진실원, 행동 무변경); index.ts가 program.js import 전에 trySpecFastPath 호출.
- **왜**: spec은 완전 static인데도 ~100모듈 그래프 로드로 0.5s. fast path로 **0.50s→0.02s(~20배)**. "최고급 CLI" 시작속도(③ perf, 최저서빙 축). `spec --help`는 fast-path 미적용→commander 유지.
- **리뷰지점**: 출력 바이트-동일(text 79B·json 145B diff 0), `spec --help` framework 유지, mutation-first RED(text 1 fail / `runner` 바꾸면 program.test 포함 2 fail — tautology 회피 위해 리터럴 핀). 형제-감사: spec 유일 참조=program.test:60(framework json), 243/243 무사. 독립 Opus ④b PASS(8/8).
- **리스크**: 낮음. diff 4파일(2 src 배선 + 1 신규 + 1 test). 데이터 단일 진실원이라 드리프트 0.
- lesson: 같은 파일 내 `formatSpec===const` 비교는 tautological(mutation이 양변 동시 변경 → green) — 출력 텍스트는 테스트에 **리터럴로 직접 핀**해야 진짜 RED. mutation-first가 이걸 잡음.
- live: `node dist/index.js spec`(0.02s) / `spec --json`(0.03s) 출력 framework와 바이트-동일; `spec --help` 정상 usage.
- 레퍼런스: gh/starship 등 즉시-시작 CLI 관행(trivial probe는 풀 init 회피); 내부 fire 5 `muse-version.ts` 패턴.

## fire 19 · 2026-06-22 · skill v2.1.0 · fea987e47 (JUDGE-DRILL)
meta: value-class=error-guidance · pkg=@muse/cli · kind=error-guidance · verdict=PASS · firesSinceDrill=0 (drill reset)
ratchet: info-projection 4(14-17)+perf(18) → error-guidance 전환 · unknown-subcommand 6/6 + program.test 243/243 · root-eslint 0 · raw-ESC 0

- **무엇**: `muse <group> <typo>`(예 `muse memory serch`)가 stock commander 막다른 `error: unknown command 'serch'` 대신 grounded 블록 출력 — 신규 `unknown-subcommand.ts`(`formatUnknownSubcommand` pure + `attachUnknownSubcommandGuidance` 배선). 그룹별 commander `command:*` 핸들러가 `'muse <group> <attempted>'` + "Did you mean"(closest-command Levenshtein, 없으면 unique-prefix) + `Available <group> commands: <실 레지스트리 정렬목록>` 출력. fire 7(top-level)을 서브그룹으로 확장.
- **왜**: ~38개 서브그룹의 오타가 zero-help 막다른 길이었음. 제안+유효 서브 실목록으로 복구 경로 제공(gh/git did-you-mean 관행). 근거: 목록·제안 모두 LIVE 레지스트리(`group.commands`)에서 파생 — fabrication 0.
- **리뷰지점**: 테스트가 실 렌더 문자열 + 배선(실 commander program parse→stderr) 양쪽 grade, mutation-first RED(format 문자열 깨면 3-4 fail). 형제-감사: program.test 243/243(fire 7 top-level 무사). 그룹이 자체 default action 보유 시(`remind`) command:* 미발화 → **무변경**(no-regression, 안전 폴백). 독립 Opus ④b PASS(8/8).
- **리스크**: 낮음. diff 3파일(2 신규 + program.ts 배선 1줄+import). default-action 그룹은 기존 동작 유지.
- lesson(DRILL): 고의 나쁜 슬라이스(fabricated 'show' 하드코딩 + `typeof===string` tautological 테스트 + 미배선 dead code) 주입 → 독립 verifier가 4규칙(behavioral/mutation-RED/fabrication/wiring) 전부로 FAIL 확인 → 롤백 → 진짜 grounded fix는 PASS. 게이팅 검증자가 rubber-stamp 아님(양방향 보정) 입증.
- live: `memory serch`→"Did you mean 'muse memory search'?"+실목록; `calendar evnts`→events 제안; `memory show`(유효) 정상 exit 0; `memory s`(ambiguous) 제안 없이 실목록.
- 레퍼런스: git/gh "did you mean" + 유효 서브 나열 관행; 내부 fire 7 top-level unknown-command 패턴.
