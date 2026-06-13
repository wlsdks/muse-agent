# Loop journal — `tool-mcp-browser`

> Theme: Muse's own TOOL expansion/hardening · official public external-MCP integration
> (Notion/GitHub) · muse-in-chrome (browser control) perfection. Isolated worktree
> `/tmp/muse-tool-mcp-browser` (branch `tool-mcp-browser`, own codegraph index), Tier1
> (local commits, no push). Differentiates from the `tool-hardening` loop by owning
> axes **B (external MCP)** + **C (browser)**, rotating A/B/C. Convention: [README](README.md).

## fire 1 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=1

ratchet: testFiles +0 net files (2 test files extended, +126 cases-region) · @muse/browser 68 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE PASS · lint 0/0

- **무엇:** `@muse/browser` 요소 매처가 모델이 지목한 타겟(`browser_click target:"Delete"`)에
  대해 동점 최상위 후보가 여럿일 때 **조용히 첫 DOM 요소를 클릭**하던 fail-open 구멍을 닫음.
  새 `matchElementResult()`가 `match|ambiguous|none`을 반환하고, `resolveTarget`가
  `ambiguous`면 act 도구(`browser_click`/`browser_type`)를 **스냅샷 변형·승인 게이트 호출 전에
  거부**(fail-close)하고 후보 목록 + 서수 힌트("the second Delete")를 돌려줌. 단일 매치 해피패스는
  불변, `matchElement()`는 first-pick back-compat 래퍼로 유지.
- **왜:** 브라우저 act 경로는 Muse가 제3자 페이지 상태를 바꾸는 유일한 지점 —
  잘못된 클릭/타이핑은 되돌릴 수 없는 행위 클래스(outbound-safety.md). 같은 라벨 컨트롤이
  둘일 때 추측으로 행동하고 승인 드래프트 라벨도 구분 불가였던 것이 가장 가치 높은 갭이었음.
- **리뷰지점:** RED이 행동적임을 독립 judge가 src만 revert해 재확인(old=clicked:true →
  AssertionError); fail-close가 게이트 호출 전임을 browser-tools.ts:461/523 단락으로 확인.
- **리스크:** 모호성 사유 문자열이 영어 전용(KO 프롬프트도 영어 힌트 — 모델은 서수로 재타겟
  가능, 후속 슬라이스에서 현지화 가능); read-only `hover`도 모호성을 표면화(무해).

## fire 2 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/mcp · kind=B-mcp · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +1 (official-mcp-presets.test.ts, 11 cases) · @muse/mcp 1810 tests pass · fabrication 0 · eval:tools no-regression (no new model-facing tool) · lint 0/0

- **무엇:** 공식 공개(누구나 연동 허용) 외부 MCP 프리셋 레지스트리 `official-mcp-presets.ts` 신설 —
  `createGitHubMcpServer`(`https://api.githubcopilot.com/mcp/`) + `createNotionMcpServer`
  (`https://mcp.notion.com/mcp`) streamable 팩토리, 각자 official provenance URL + **fail-close
  toolRisk 분류기**(read 도구만 화이트리스트, write/unknown→`write`→toolApprovalGate 게이트) +
  `withOfficialMcpRisk`(domain `external` 재스탬프). 기존 `allowedServerNames` allowlist seam으로
  배선, `resolveOfficialMcpPreset`는 비큐레이트 서버명에 undefined(미허가 거부). secret 미동봉.
- **왜:** 진안 헤드라인 요청(외부 MCP 연동)이자 tool-hardening(axis A)과 가장 차별되는 축.
  seam은 이미 있었고 빠진 조각은 *provenance-backed 큐레이트 레지스트리 + fail-close write 분류*.
  outbound-safety: read 자유, write/unknown은 draft-first 게이트 — 자율 전송 구멍 없음(독립 judge 확인).
- **리뷰지점:** judge가 `githubMcpToolRisk`를 항상 read로 깨 RED 3건(분류·재스탬프·e2e) 재확인 후 복원;
  프리셋이 assembleMcpStack/CLI 투영 경로에 아직 미배선(autoConnect 기본 false)이라 write 도구 도달 불가.
  contract-faithful transport fake로 실제 McpManager register/connect/projection 경로 검증(fake 레지스트리 아님).
- **리스크:** 라이브 배선은 다음 ◦ 슬라이스들(backlog 5건 decompose: env 토글·투영 경로 적용·키체인 자격증명·
  draft-first write e2e·doctor provenance). web-search-policy fuzz 타임아웃은 무관 패키지 기존 flake(격리 44/44).

## fire 3 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=wiring · pkg=@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=3

ratchet: testFiles +1 (mcp-stack-official-presets.test.ts, 10 cases) · @muse/autoconfigure 532 tests pass · fabrication 0 · eval:agent LIVE (ran-cases PASS, wrapper-timeout not a fail) · lint 0/0

- **무엇:** fire 2의 휴면 외부-MCP 프리셋 레지스트리를 **opt-in 연결 가능**하게 배선. per-server
  env 토글(`MUSE_GITHUB_MCP_ENABLED`/`MUSE_NOTION_MCP_ENABLED`, `MUSE_<NAME>_MCP_ENABLED` 파생)이
  set일 때만 `assembleMcpStack` externalServerInputs + strict allowlist에 등록(기본 OFF), 그리고
  라이브 투영에 `withOfficialMcpRisk(withChromeDevToolsRisk(toMuseTools()))` 합성으로 write/unknown
  외부 도구를 `write`로 재스탬프 → `toolApprovalGate` 도달. @muse/autoconfigure만 수정.
- **왜:** 토글만 켜고 risk 재스탬프 없으면 외부 write 도구가 `read`로 투영돼 **fail-OPEN** — 두
  스텝은 반드시 커플링해 함께 출하해야 안전. chrome-devtools 선례를 정확히 미러. 진안의 외부 MCP
  연동 요청을 실제 사용 가능 상태로 끌어올림(read 자유, write draft-first 게이트).
- **리뷰지점:** judge가 등록 루프를 neuter해 5/10 RED 재확인; `index.ts:750` 합성 호출이 실제
  agent-runtime resolveToolRisk→approvalGate에 도달함을 chrome 선례로 추적; 빈 allowlist allow-all
  유지(enable이 strict로 안 뒤집힘) 확인.
- **리스크:** 자격증명 해석(키체인 PAT/OAuth)·draft-first write e2e·doctor provenance는 남은 ◦.
  `pnpm check` SIGABRT는 무관 @muse/memory 병렬-부하 flake(격리 417/417). eval:agent는 로컬모델
  바운드로 wrapper 타임아웃(만진 코드가 tool selection 무관이라 직교).

## fire 4 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=4

ratchet: testFiles +0 (2 browser test files extended, 72 cases) · @muse/browser 72 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE PASS · lint 0/0

- **무엇:** `browser_type`가 비입력 요소(버튼/링크)를 타겟으로 잡던 fail-open 교정. `type` 인텐트의
  유일 매치가 untypeable면 매처가 새 결과 `notypeable`을 반환하고 `browser_type`은 승인 게이트
  도달 전에 거부 — `{typed:false, fields:[실제 텍스트필드], reason}`로 모델을 올바른 필드로 유도.
  click/hover는 불변(버튼은 여전히 매치). fire-1(동점-모호)과 구별되는 "잘못된 종류의 타겟" 케이스.
- **왜:** 옛 동작은 "type 'password' into Sign in button" 드래프트를 사용자가 confirm한 뒤 fill()이
  버튼에서 throw — (1) 성공 불가한 outbound-safety 승인 드래프트 (2) 저사양 모델 confirm 라운드 낭비
  (3) 재타겟 신호 없는 bare error. 이제 한 번에 올바른 필드로 유도.
- **리뷰지점:** judge가 src revert해 4 RED 재확인; **수정된 기존 테스트 3개**(버튼에 타이핑하던 옛
  버그 동작 인코딩)가 정당한 교정이지 게이밍 아님을 git diff로 확인; 거부가 게이트/`type` 호출 전
  (`c.calls===["snapshot"]`, gateCalled:false)임을 확인.
- **리스크:** 낮음 — `notypeable.fields`는 점수정렬 안 한 전체 typeable 목록(흔한 로그인/검색/체크아웃은
  짧음, 많은 필드면 향후 정렬 가능). ref-only 고급 경로·`<select>` 경로 불변.

## fire 5 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=5

ratchet: testFiles +1 (official-mcp-write-draft-first.test.ts, 6 cases) · @muse/autoconfigure 548 tests pass · fabrication 0 · pnpm check 0 · lint 0/0

- **무엇:** fire 3가 배선한 라이브 외부-MCP write 경로의 draft-first fail-close 증명 배터리(test-only).
  REAL McpManager register/connect/toMuseTools + withOfficialMcpRisk + AgentRuntime toolApprovalGate를
  구동(transport seam callTool만 vi.fn spy — fake 레지스트리 아님). 증명: GitHub create_issue(risk
  write)가 게이트되고 deny/timeout-undeliverable/absent-consent ⇒ transport write 호출 0, confirmed ⇒
  정확히 1, read(get_me) ungated. outbound-safety.md 규칙 1·2·4를 외부-MCP write에 적용.
- **왜:** fire 2·3가 외부 MCP를 연결 가능하게 만들었으나 send capability는 happy-path만 테스트하면
  미배달(outbound-safety.md). 이 배터리가 deny/timeout/absent 경로 외부효과 0을 증명해 헤드라인
  기능 신뢰성 스토리를 닫음. 프로덕션 변경 0 — 경로는 이미 정확, 누락된 OUTCOME 증명.
- **리뷰지점:** judge가 비공허성 두 방식 재확인 — test-side(restampRisk:false) + prod-side(실제
  withOfficialMcpRisk를 pass-through로 도려냄, @muse/mcp 재빌드) 모두 deny 케이스 RED. confirmed가
  정확히 1회 send임을 assert(블랭킷-차단 게이트 배제). 트리 test-only(git diff --stat 빈값).
- **리스크:** GitHub 프리셋이 대표 — Notion create-page는 동일 seam을 타므로 구조적 커버. 남은
  axis-B ◦: 키체인 자격증명 · doctor provenance.

## fire 6 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=6

ratchet: testFiles +0 (browser-tools.test.ts +3 cases, 75 total) · @muse/browser 75 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · eval:tools 194/199 (97%, threshold 85%) · smoke #19 LIVE · lint 0/0

- **무엇:** 읽기-측 누락 역량 — 링크 요소가 목적지 URL 없이 노출돼(스냅샷이 href를 dedup용으로만
  읽고 버림) 모델이 링크를 클릭할 순 있어도 "이동하지 않고" 어디로 가는지 답할 수 없었음. 이제
  `SnapshotElement.url`이 각 앵커의 resolved ABSOLUTE href를 browser_read/browser_open 요소 JSON에
  실어줌(있을 때만 emit, 버튼/필드 불변) + browser_read 설명이 링크-목적지 답변을 광고. 새 도구 없음
  (read 경로 증강, 9-도구 셋 유지 — tool-calling.md 혼동쌍 회피).
- **왜:** "그들 가격 페이지 링크가 뭐야?"·"공유하게 top 결과 URL 줘"·"링크들과 목적지 나열" 같은
  웹-리서치 작업이 inexpressible이었음. fires 1·4(act-target fail-close)와 구별되는 *역량 추가*.
- **리뷰지점:** judge가 src revert해 3 RED 재확인; url이 실제 HTMLAnchorElement.href(IDL=절대)에서
  채워짐을 라이브 smoke #19로 확인(절대+상대해소+비링크-none); browser_read 설명 변경이 eval:tools
  mis-selection 안 냄(97% 통과, browser 셀렉션 전부 green).
- **리스크:** cross-origin iframe 링크는 여전히 범위 밖(CDP가 page context서 도달 불가, 불변).
  url은 additive/optional이라 dedup·비링크 컨트롤·act 경로 불변, 보안 surface 무변경.

## fire 7 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=wiring · pkg=@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=7

ratchet: testFiles +1 (official-mcp-credentials.test.ts; mcp-stack-official-presets +8) · @muse/autoconfigure 567 tests pass · fabrication 0 · pnpm check 0 · lint 0/0

- **무엇:** fire 3가 토글을 배선했지만 `preset.create()`에 headers가 없어 사용자가 손으로
  `~/.muse/mcp.json`에 Authorization을 써야 했음. 이제 새 `official-mcp-credentials.ts`가
  `GITHUB_MCP_TOKEN`/`NOTION_MCP_TOKEN` env → `~/.muse/mcp-credentials.json` 순(기존
  readCredentialsSync env-wins-then-file 시드, model/messaging 키와 동일 패턴)으로 토큰을 해석해
  `Authorization: Bearer <token>` 주입. 자격증명 없으면 preset 미활성+미allowlist(fail-closed,
  blank-auth half-connection 없음). secret은 직렬화/로그 가능 safe-config에 절대 안 남음.
- **왜:** 외부 MCP를 실제로 인증해 쓰게 만드는 마지막 조각(헤드라인 요청 완성). 보안: 키체인은 아직
  없어 기존 파일 시드 재사용(judge가 새 평문 경로 아님을 확인), secret 미로그.
- **리뷰지점:** judge가 resolver를 상수 헤더로 neuter해 5 RED 재확인; secret-leak 테스트가 토큰 AND
  "Bearer"를 모두 잡음(RED-able 검증); 작업 트리가 정확히 4 슬라이스 파일뿐(동시 루프 stash 오염 0).
- **리스크:** Notion hosted 엔드포인트는 OAuth-선호(Bearer 거부시 향후 OAuth 분기 필요, 현재는
  토큰 없으면 클린 fail-close). 파일경로 whitespace-only 토큰 미트림(cosmetic, upstream 인증 실패,
  누출 없음) + 네이티브 키체인 백엔드 = backlog 후속 ◦.

## fire 8 · 2026-06-13 · skill v1.14.0 · ROLLED BACK (no slice commit)

meta: value-class=new-capability(attempted) · pkg=@muse/browser · kind=C-browser · verdict=FAIL→rollback · firesSinceDrill=8

ratchet: testFiles +0 (slice reverted) · fabrication 0 · @muse/browser unchanged · gate=④b independent judge FAIL

- **무엇(시도):** browser_open/back 네비게이션 상태 충실도 — page.goto가 4xx/5xx에 throw 안 해
  에러 페이지가 콘텐츠로 둔갑하던 grounding 구멍에 PageSnapshot.httpStatus + statusError를 추가.
- **왜 FAIL(④b judge):** open/back 부분은 견고+RED-able이었으나, 슬라이스가 **post-click 500
  플래깅을 과대청구** — 실제 PuppeteerBrowserController.click은 lastHttpStatus를 절대 설정 안 함
  (open/back만 함). 그 케이스 테스트가 `c.click=async()=>errSnap`로 500 스냅샷을 가짜 주입해
  실제 경로와 무관하게 통과 = 프로젝트 금지 happy-path/fake-injection 안티패턴(testing.md
  "fall-back 어서션 금지"). maker≠judge 게이트가 정확히 이걸 잡음.
- **조치:** git restore로 4 파일 전체 롤백(브랜치 HEAD=pre-pull 머지 5c3d6d6f 불변). 정직히
  스코프된 재작업을 backlog ◦로 기록(open/back ONLY + 가짜 click 테스트 제거, 또는 click nav
  status를 main-frame page.once("response")로 실제 캡처). 다음 fire가 픽업.
- **리스크/교훈:** 동종 act-경로 상태 캡처를 "한 슬라이스로 배칭"하려다 미구현 경로를 가짜 테스트로
  덮음 — 배칭 시 각 경로가 REAL인지 확인 필수. 연속 allPASS 스트릭 7에서 끊김(이 catch가 곧
  9에 예정됐던 judge-드릴의 실효 — 검증자가 진짜 나쁜 슬라이스를 잡음 입증).

## fire 9 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=1 (reset — fire-8 real verifier-catch served as the drill)

ratchet: testFiles +0 (browser-tools.test.ts +9 cases, 84 total) · @muse/browser 84 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke #20 LIVE (real Chrome vs localhost 404/200) · lint 0/0

- **무엇:** fire-8(롤백)의 정직 재작업 — browser_open/browser_back 네비게이션 상태 충실도. goto/goBack
  HTTPResponse에서 PageSnapshot.httpStatus 캡처(snapshot()의 settle-retry 루프 後 consume-once,
  lastDialog 패턴), browser_open/back이 status≥400일 때만 {httpStatus, statusError} emit(200/부재 침묵).
- **왜:** page.goto가 4xx/5xx에 throw 안 해 404/500 에러 페이지가 요청 콘텐츠로 둔갑하던 grounding
  구멍. fire-8 실패 교훈 반영: **open/back로만 스코프, click/type 무관/무청구, 가짜 주입 테스트 0.**
- **리뷰지점:** judge가 (1)fire-8 안티패턴 재발 0 확인(click/type 경로 byte 불변, fake-injection 없음)
  (2)src revert해 7 RED (3)라이브 smoke #20이 실제 localhost 404/200을 헤드리스 Chrome으로 왕복해
  실제 goto-status 경로 증명(가짜 아님) (4)consume-once가 looksUnsettled 재캡처 後에도 보존되는 실제
  버그 수정 확인. 라이브 실행이 그 consume-once 버그를 노출(unit fake로는 못 잡았을 것).
- **리스크:** click/type 네비게이션 status는 의도적 범위 밖(실제 click이 document HTTPResponse를 안 봄,
  main-frame page.once("response") race 필요) → backlog 후속 ◦. byte-hygiene check red는 외부(타 루프 문서).

## fire 10 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/autoconfigure+@muse/cli · kind=B-mcp · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +1 (official-mcp-posture.test.ts 8 + doctor +5) · @muse/autoconfigure+cli tests pass (doctor 90) · fabrication 0 · pnpm check 0 · lint 0/0 · live doctor --local verified (secret 0×)

- **무엇:** `muse doctor --local`이 공식 공개 MCP 프리셋(GitHub/Notion)별 posture를 보고 — enabled(env
  토글) + credentialPresent(불린, 토큰 절대 미렌더) + allowed(allowlist) + 공식 provenanceUrl. pure
  describeOfficialMcpPosture(env)를 autoconfigure에 두고 CLI doctor에 officialMcpChecks로 배선.
- **왜:** 외부 MCP의 신뢰/관측 스토리 완결 — 프라이버시-우선 사용자가 "내 에이전트가 어떤 외부 서버에
  연결 가능한지/왜인지"를 감사. Muse 정체성("tell it everything, it can't tell anyone")과 부합.
- **리뷰지점:** judge가 leak-가드를 RED-able로 재확인(posture에 토큰 주입→테스트 RED; 라이브 doctor
  --local에서 secret 0회), allowlist 시맨틱이 McpManager/assembleMcpStack과 일치(empty=allow-all,
  non-empty=strict, 같은 MUSE_MCP_ALLOWED_SERVERS env)함을 확인, 4 상태 OUTCOME 채점 RED-able.
- **리스크:** doctor가 enabled+strict-allowlist-제외를 "blocked"로 표시하나 assembleMcpStack은 turnkey
  프리셋을 allowlist에 자동추가 → 런타임보다 약간 엄격(cosmetic follow-up ◦ 기록). posture는 env-only
  (연결 프로브 아님, 연결성 아닌 *적격성* 보고 — 의도).

## fire 11 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=3

ratchet: testFiles +0 (browser-tools.test.ts +1 + smoke 10b) · @muse/browser 85 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke 10b LIVE (real Chrome prompt) · lint 0/0

- **무엇:** 네이티브 JS prompt() 다이얼로그가 bare dialog.accept() = 빈 문자열 제출로 페이지의 defaultValue를
  폐기하던 버그 수정. 이제 prompt는 다이얼로그 자신의 defaultValue로 수락(절대 텍스트 발명 안 함) + 제출
  텍스트를 PageSnapshot.dialog.response로 노출. alert/confirm/beforeunload는 불변(bare accept).
- **왜:** "쿠폰 적용"·"제안된 수량 입력" 같은 액션이 prompt(msg, default) 페이지에서 빈값을 보내 승인된
  행동이 garbage로 진행되고 모델은 무엇이 보내졌는지 몰랐음. fires 1·4·6·9(요소 grounding·nav-status)와
  구별되는 auto-accept 다이얼로그 응답 경로.
- **리뷰지점:** judge가 (1)증거가 REAL 경로임 확인 — 라이브 smoke 10b가 실제 Chrome에서 prompt 픽스처를
  구동하고 page가 캡처한 값(document.title=code:+prompt())을 readback(hand-injection 아님) (2)handler revert해
  10b RED 재현 (3)defaultValue만 사용=텍스트 미발명(fabrication-into-world 구멍 없음) (4)alert/confirm 불변.
- **리스크:** default 없는 prompt(msg)는 defaultValue="" → 여전히 빈값(불변)이나 response:""로 투명 기록.
  파괴적 confirm()은 여전히 blind-accept(트리거 클릭이 이미 draft-first 승인됨 — 다이얼로그 재게이팅은 별도 큰 건).

## fire 12 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/mcp+@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=4

ratchet: testFiles +0 (existing preset/cred/posture tests +cases; mcp 14, autoconfigure 43, doctor 90) · fabrication 0 · pnpm check 0 · lint 0/0

- **무엇:** 외부-MCP 레지스트리 EXPANSION — Linear을 3번째 공식 공개 프리셋으로 추가
  (mcp.linear.app/mcp, provenance linear.app/docs/mcp, OAuth2.1 + Bearer 개인 API키). 전체 기계장치
  재사용(레지스트리 팩토리 + fail-close linearMcpToolRisk[23 read 도구→read, create/update/unknown→write]
  + 자동파생 MUSE_LINEAR_MCP_ENABLED + LINEAR_MCP_TOKEN + doctor posture). 자격증명 resolver 하드닝:
  presetEnvTokenKey()가 Object.hasOwn(OFFICIAL_MCP_PRESETS,name) gated로 <NAME>_MCP_TOKEN 자동파생.
- **왜:** GitHub/Notion 외 실용 통합 추가 — 사용자가 env var 하나로 Linear 워크스페이스 연결(읽기 자유,
  쓰기 draft-first 게이트, doctor 감사). 레지스트리가 진짜 확장 가능함을 입증.
- **리뷰지점:** judge가 (1)Linear provenance를 Linear 자체 문서로 확인(공식 호스티드·anyone-may-connect·
  Bearer) (2)linearMcpToolRisk를 always-read로 깨 RED 재현, unknown→write 최강 fail-close (3)자격증명
  auto-derive가 큐레이트 프리셋명에 gated(arbitrary name은 ambient 토큰 안 읽음 — env-exfil 차단,
  gitlab→undefined 테스트) (4)secret 미동봉.
- **리스크:** Linear read-도구 목록을 단일 공식 페이지서 못 얻어 제3자 분석(Fiberplane) 참조 — 단
  fail-close라 stale read-list는 over-gate만(절대 under-gate 아님), 안전 회귀 불가.

## fire 13 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=5

ratchet: testFiles +0 (smoke #21 + controller; 89 tests) · @muse/browser 89 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke #21 LIVE (real CDP hang) · lint 0/0

- **무엇:** CDP protocolTimeout 바운드. puppeteer 기본 180초가 unset이고 스냅샷 캡처 page.evaluate
  (innerText/element-walk)는 상위 타임아웃조차 없어 멈춘 CDP 왕복이 에이전트를 ~3분 행(복구 불가).
  이제 connect()에 protocolTimeout = max(requested, timeoutMs+15s)(기본 30초) 주입 — 항상 per-op
  timeout 위라 정상 느린 nav/click/fill은 절대 먼저 안 죽음. protocolTimeoutMs 옵션도 floor로 클램프.
- **왜:** 전송층 신뢰성 구멍 — prod 에이전트는 SIGKILL 불가. fires 1·4·6·9·11(관측/act 의미론)과
  구별되는 transport/hang-recovery seam.
- **리뷰지점:** judge가 (1)smoke #21이 REAL 경로(HANG_HTML innerText 무한 getter→실제 captureSnapshot
  →page.evaluate, fake-injection 아님) 실행 통과(19.5초) (2)threading revert시 45초+ pending=RED 재현
  (3)클램프 math가 항상 protocolTimeout>timeout(조기 kill 경로 없음) 확인.
- **리스크:** 기본 천장 30초 — >30초 단일 CDP op(거대 DOM innerText 등)은 이제 에러(전엔 180초 대기).
  허용가능(15s per-op가 이미 nav/click/fill 관장, >30초 단일 왕복은 병리), protocolTimeoutMs로 튜닝 가능.

## fire 14 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/mcp+@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=6

ratchet: testFiles +0 (preset/cred/posture/doctor tests +cases; mcp 17, autoconfigure 49, doctor 91) · fabrication 0 · pnpm check 0 · lint 0/0

- **무엇:** 외부-MCP 레지스트리 EXPANSION — Sentry를 4번째 공식 공개 프리셋으로(mcp.sentry.dev/mcp,
  provenance getsentry/sentry-mcp). 전체 기계장치 재사용(레지스트리 + fail-close sentryMcpToolRisk[27 read,
  create/update/add/unknown→write] + 자동파생 MUSE_SENTRY_MCP_ENABLED + SENTRY_MCP_TOKEN + doctor posture).
  에러/모니터링 = 코드/문서/이슈에 이은 4번째 dev 카테고리.
- **왜:** GitHub/Notion/Linear 외 실용 카테고리 확장 — 레지스트리가 4개로 스케일됨 입증. pkg를 browser서
  mcp로 회전(value-class new-capability).
- **리뷰지점:** judge가 (1)provenance를 Sentry 자체 docs+repo로 확인(공식·anyone-may-connect) (2)
  sentryMcpToolRisk always-read로 깨 RED 재현, unknown→write (3)토큰 없으면 미등록(fail-closed, blank-auth
  없음) (4)secret 미동봉·기계장치 재사용·트리 클린. **AUTH NUANCE 정직 판정:** Sentry는 OAuth-primary,
  Bearer는 upstream #833 미출시 → Muse Bearer seam은 forward-compatible, 토큰 없거나 거부되면 fail-close
  (오도 아님, 프리셋에 문서화). judge가 "비기능적 거짓 아님"으로 PASS.
- **리스크:** Bearer auth가 Sentry endpoint에 아직 수락 안 될 수 있음(#833 대기) — 단 fail-close라 무해,
  #833 출시시 Muse 변경 0으로 동작. read-tool set은 fire-time 카탈로그 기준(신규 도구는 write 기본).

## fire 15 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser+@muse/cli · kind=C-browser · verdict=PASS · firesSinceDrill=7

ratchet: testFiles +0 (browser-tools.test +5 + smoke #22 + eval:tools golden; browser 94, cli 2599) · fabrication 0 · eval:browser-agent 1/1 LIVE · eval:tools 13/14 93% (browser_wait EN STABLE 3/3) · lint 0/0

- **무엇:** 새 역량 browser_wait — 비동기 콘텐츠(forText 부분문자열 OR CSS selector)를 timeoutMs 바운드로
  대기 후 재관측. controller.waitFor + createBrowserWaitTool + CLI 등록(read-risk, 게이트 없음).
- **왜:** settleDom(400ms-quiet, open/scroll 시) + snapshot 재시도(looksUnsettled=0 elements&<40chars일 때만)는
  quiet-at-load 후 타이머/fetch로 콘텐츠 삽입하는 페이지를 못 잡음 — 모델이 "X 나타날 때까지 기다려 읽어"를
  표현할 방법이 없었음. 스트리밍 검색결과·스피너·"Loading…"→데이터에서 모델이 너무 일찍 읽어 놓침.
  fires 1·4·6·9·11·13(이미 있는 것 act/read)과 구별되는 *not-yet-rendered 대기* 역량.
- **리뷰지점:** judge가 (1)실제 갭 확인(looksUnsettled 조건·SETTLE_RETRIES 캡 읽음) (2)live smoke #22가
  REAL Chrome(2.5s 지연삽입)서 첫 assert "delayed content absent right after open"으로 갭 증명, fake-injection
  없음 (3)타임아웃 정직(matched:false, throw/거짓성공 없음, live page 반환) (4)도구 선택 무회귀(eval:tools
  93%, browser_wait EN 3/3, browser_read/scroll 3/3 — 혼동쌍 없음).
- **리스크:** KO async-wait phrasing 선택 0/3(기존 gemma KO 약점, KO browser_look과 동일 클래스) — STABLE
  아니라 골든에 게이트 안 함(agent-testing.md), EN만 게이트. KO 설명 예시는 무해하게 유지. 도구셋 10개(relevance
  필터로 한번에 안 덤프되니 OK, 선택 무열화 확인).

## fire 16 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=8

ratchet: testFiles +0 (browser-tools.test +4 + smoke #23; 98 tests) · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke #23 LIVE (real CDP act-nav 404) · lint 0/0

- **무엇:** nav-status 충실도를 ACT 경로로 확장 — click/type-submit/key-Enter가 4xx/5xx로 네비게이션하면
  새 withNavStatus 래퍼(현재 페이지+신규탭 타깃의 main-frame document response에 실제 page.on('response')
  arm)가 httpStatus 캡처, 3 act 도구가 status≥400일 때 {httpStatus, statusError} 노출(200/부재 침묵).
- **왜:** lastHttpStatus는 open()/back()에서만 설정됐고 act 메서드(goto/goBack 안 거침)는 미커버 —
  링크 클릭이 404거나 검색 제출이 500이면 에러 페이지 body를 정상 콘텐츠로 읽던 grounding 거짓.
  **fire-9 follow-up ◦ 닫음 + fire 8이 fake로 했던 것을 정직하게 완성**(fire-8 judge가 실제 click이
  lastHttpStatus를 안 세운다고 지적했던 바로 그 경로를 진짜 구현).
- **리뷰지점:** judge가 (1)REAL 캡처(withNavStatus가 실제 response 리스너, act 메서드에 배선, hand-inject
  아님) (2)smoke #23이 실제 Chrome로 localhost 404 클릭→404 캡처, wiring revert시 undefined RED 재현
  (3)success silent·advisory·승인게이트 무회귀(post-approval 결과에만 적용) (4)리스너 정리·consume-once 확인.
- **리스크:** 신규탭 target.page()가 finally 후 resolve되는 이론적 narrow edge(withNewTabFollow가 await해
  실무상 정리됨, 메인 리스너는 항상 제거) — 비차단 robustness nit. statusError는 advisory(refusal 아님).

## fire 17 · 2026-06-13 · skill v1.14.0 · (this commit) · JUDGE-DRILL

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=0 (RESET — drill completed)

ratchet: testFiles +0 (browser-tools.test +2 discriminating; 100 tests) · fabrication 0 · pnpm check 0 · lint 0/0 · DRILL: verifier FAILed the planted bad slice

- **무엇(드릴):** 8연속 PASS 하드-카운터 발동 → 고의 나쁜 슬라이스 주입(linkCount = elements.length =
  링크 아닌 전체 요소 카운트, all-link 비판별 픽스처로 버그 숨김) → 독립 Opus verifier가 **잡음**(혼합
  2링크/2비링크 픽스처로 4≠2 경험 증명 + 비판별 테스트 fire-8 선례로 지적) → FAIL → 롤백.
- **무엇(진짜 fix):** linkCount = elements.filter(role==="link").length, >0일 때만 emit(거짓-0 노이즈
  없음), **판별 테스트**(4요소 중 2링크 → linkCount:2 not 4; .length 버그시 새 테스트 2개 모두 RED 증명).
- **왜:** 검증자가 rubber-stamp 안 하고 진짜 결함(미묘한 구현 버그 + 비판별 테스트)을 잡는지 주기적 증명 —
  fire-8의 실제 catch에 이은 의도적 드릴. maker≠judge 보상통제가 살아있음 재확인.
- **리뷰지점:** 드릴 verifier가 FAIL+정확한 처방(filter role==="link" + 혼합 픽스처) 반환; 진짜 fix가
  그 처방을 구현하고 판별성을 self-증명(impl을 .length로 되돌리면 RED, 올바르면 100 pass).
- **리스크:** linkCount는 modest 편의 필드(요소 목록+fire6 링크 URL이 이미 있음) — 드릴 bait를 정직하게
  올바른 형태로 완성한 것. 낮은 가치지만 정확+판별 검증됨.

## fire 18 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser+@muse/cli · kind=C-browser · verdict=PASS · firesSinceDrill=1

ratchet: testFiles +0 (browser-tools.test +12; browser 111, cli 2616) · fabrication 0 · eval:tools 14/15 93% (fill_form 3/3 + type 3/3 no regression) · eval:browser-agent 1/1 LIVE · lint 0/0

- **무엇:** 새 역량 browser_fill_form — 다중 필드 폼을 한 번의 draft-first 승인으로 충전. fields:[{target,
  value}](minItems 2, optional submit), 모든 타겟 먼저 resolve(fire-1/4 matcher fail-close 재사용), 전
  field→value 쌍을 한 승인 드래프트에 표시, confirm시에만 순서대로 충전. ANY none/ambiguous/non-typeable
  타겟이면 게이트 전 fail-close(충전 0, 부분변형 없음), submit은 마지막 필드만 Enter. risk:execute.
- **왜:** 로그인/가입/체크아웃 등 다중 필드 폼이 필드별 browser_type=승인 라운드 다발(저사양 모델엔 느림)
  이었음 — 한 번의 승인으로 모든 필드값을 보여주고 채움(outbound-safety 정렬: 한 드래프트에 전체 내용).
- **리뷰지점:** judge가 (1)outbound-safety RED-able 두 방식(deny 우회·실패타겟 continue→안전테스트 RED)
  (2)resolve-all-first라 field[0] 충전 후 field[1] 실패 경로 없음(코드 추적) (3)eval:tools 혼동쌍 무회귀
  (fill_form 3/3 multi + type 3/3 single, 임계 통과) (4)real execute 경로(contract-faithful FormController,
  실제 controller.type 합성, fake-injection 아님) (5)스키마 verb_noun·minItems2·use-when/not-when.
- **리스크:** 라이브-CDP smoke 미추가 — 이미 라이브 증명된 controller.type를 합성할 뿐 새 CDP 동작 없어
  eval:browser-agent 실 라운드트립으로 충분. pnpm check의 apps/api 타임아웃은 무관 외부 flake(격리 통과).

## fire 19 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix(hardening) · pkg=@muse/mcp · kind=B-mcp · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +0 (mcp.test +3; 1860 tests) · fabrication 0 · pnpm check 0 · lint 0/0 · architecture.md retry-classification 준수

- **무엇:** 외부 MCP 연결 실패 retry 분류. connect/healthCheck가 모든 에러에 무조건 scheduleReconnect했고
  connector가 SDK HTTP status를 드롭 → 취소/만료 토큰(401/403) 서버가 maxAttempts 재시도(영원히 hammering).
  수정: isRetryableMcpConnectStatus(4xx→fast-fail terminal disabled, 루프 없음; 429/5xx→bounded backoff;
  undefined/network→fail-OPEN retryable), McpConnectionError가 status/retryable 보유, mcpConnectErrorStatus가
  SDK .code 추출(100-599 클램프, -1 sentinel 무시).
- **왜:** architecture.md "4xx MUST fail fast; 5xx/unknown MAY retry" 위반 — 죽은 자격증명으로 외부 서버를
  무한 두드리던 실 버그. fires 16·17·18(C)에서 B로 다양성 회전. 레포의 isRetryableNotesStatus 패턴 미러.
- **리뷰지점:** judge가 (1)architecture.md 위반 실 갭 확인 (2)401 테스트가 REAL manager.connect를 실제
  McpConnectionError(401)(SDK 1.29.0 byte-faithful)로 구동, 브랜치 revert시 RED 재현, disabled+호출1회+루프없음
  (3)503 여전히 bounded-retry(과교정 없음) (4)unknown shape fail-OPEN(전이성 blip에 잘못 terminal-disable 안 함).
- **리스크:** stdio/bare-network는 status 없어 retryable(전이성 보존, 올바름). mid-session callTool 실패
  재분류는 범위 밖(별도 future ◦). SDK 에러 shape 변경시 retryable로 degrade(fail-open, 잘못 terminal 아님).

## fire 20 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix(hardening+secret-leak) · pkg=@muse/mcp · kind=B-mcp · verdict=PASS · firesSinceDrill=3

ratchet: testFiles +1 (mcp-tool-call-error.test.ts 5 cases; 1859 tests) · fabrication 0 · pnpm check 0 · lint 0/0

- **무엇:** 외부 MCP 호출-시점 에러 표면화 + 토큰 redaction. createMcpMuseTool execute가 connection.callTool()을
  try/catch 없이 반환(SdkMcpConnection.callTool도 미감싸짐, fire-19가 감싼 listTools와 달리) → mid-session
  callTool 실패(401/500/timeout/throw)가 raw 탈출. 이제 캐치→명확한 `Error: MCP tool '<name>' failed: <msg>`,
  redactMcpSecrets가 Bearer <token>→Bearer [redacted]. 성공 콘텐츠 + isError:true passthrough 불변.
- **왜:** 두 구멍 동시 수정 — (1)grounding: swallow/탈출 실패를 모델이 빈 결과로 읽던 것 (2)**secret-leak**:
  주입된 Authorization: Bearer <token>이 SDK HTTP 에러에 echo돼 모델/로그에 누출 가능. fire-19(연결-시점
  fail-fast)의 호출-시점 보완. fabrication-adjacent 구멍을 닫아 grounding 강화.
- **리뷰지점:** judge가 (1)실 갭(callTool 미캐치 end-to-end + Bearer 주입 코드 인용) (2)redaction RED-able
  (제거시 raw ghp_ 토큰 누출) (3)에러 표면화 RED-able(catch 제거시 탈출) (4)success/isError over-catch 없음
  (catch 제거해도 통과=그 경로 안 건드림) (5)Bearer-only scope 정직(Muse 주입 유일 secret).
- **리스크:** redaction은 Bearer 형태만 — query-string 등 다른 형태 토큰은 미커버(Muse 자체 주입은 Bearer
  전용이라 완전, 문서화된 residual). mid-session 외 경로는 fire-19가 커버.

## fire 21 · 2026-06-14 · skill v1.14.0 · (scout + defer, no code slice)

meta: value-class=scout · pkg=@muse/browser(investigated) · kind=C-browser · verdict=DEFER · firesSinceDrill=5

ratchet: testFiles +0 · fabrication 0 · no code change (scout finding + API-degradation defer)

- **무엇:** axis-C scout — browser `<select>` 드롭다운 선택이 갭인지 조사. **이미 처리됨**: browser_type이
  role=combobox/<select>에서 matchOption으로 옵션을 grounding(fail-close, 매치 안 되면 옵션 나열+거부),
  puppeteer-controller.ts type()서 확인. browser_select는 불필요. backlog에 scout 발견 기록(미래 스카웃 스킵).
- **왜 DEFER:** 두 번의 worker 서브에이전트 디스패치가 API rate-limit/연결거부로 죽음(크래시 worker의
  부분 변경은 롤백). 코드 슬라이스를 강행하면 ④b 독립 judge를 못 돌려(maker≠judge 미충족) 커밋 불가 —
  검증 안 된 코드를 커밋하느니 정직히 연기. 브랜치 클린 유지, doc-only backlog 노트만 기록(judge 불필요).
- **리뷰지점:** 브라우저 마이크로픽스 vein 얇아짐 — 남은 distinct C 후보(iframe read·file upload·CDP
  error-surfacing edge) 다음 fire에 검증; 2연속 clean이면 EXHAUSTION대로 value-class 회전.
- **리스크:** API 저하는 일시적 추정 — 다음 fire에 서브에이전트 회복되면 정상 슬라이스 재개. 진척 손실
  없음(스카웃 지식은 backlog에 보존).

## fire 22 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser+@muse/mcp+@muse/cli · kind=C-browser · verdict=PASS · firesSinceDrill=6

ratchet: testFiles +2 (browser-upload.test 9 + upload-path-validator.test 7; browser 120, mcp 1868) · fabrication 0 · eval:tools 94% (upload 3/3, no regression) · eval:browser-agent 1/1 · smoke #24 LIVE · lint 0/0

- **무엇:** 새 역량 browser_upload — 로컬 파일을 페이지 폼에 첨부. {target,path} → <input type=file> resolve
  (ambiguous/비-file-input fail-close) → 주입된 allowlist 가드로 path 검증 → 한 번의 draft-first 승인
  (file→field) → confirm시에만 setInputFiles. file upload은 진짜 갭이었음(업로드 경로 전무, 확인됨).
- **왜:** 두 보안 표면 동시 처리 — (1)로컬 파일 읽기: @muse/mcp createAllowlistPathValidator가 file_read의
  lexical-roots + symlink-realpath-escape 가드 재사용, @muse/browser는 fs 의존성 0(validator DI, 없으면 거부
  =allow-all 없음, ~/.ssh exfil 차단) (2)outbound act: risk:execute, deny→setInputFiles 0.
- **리뷰지점:** judge가 (1)가드가 file_read와 동일(substring 아님)·약화시 6 RED(symlink-escape 포함)
  (2)가드가 read/act 전·rejected path는 파일 미개봉+게이트 미도달(gateCalls 0)·validator 없으면 fail-closed
  (3)deny/non-file-input→업로드 0 (4)smoke #24가 실제 this.files.length 읽음(fake 아님) (5)혼동쌍 무회귀.
- **리스크:** eval:browser-agent에 업로드 멀티스텝 체인은 아직 미포함(smoke#24+unit+선택 eval로 커버, 후속 ◦).
  full-suite eval:tools의 time-tool 비결정 miss는 무관 외부 flake.
