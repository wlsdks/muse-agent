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
