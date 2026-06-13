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
