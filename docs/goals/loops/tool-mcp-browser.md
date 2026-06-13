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
