# Loop journal — `cli-excellence`

Theme: muse CLI를 타사 대비 최고급으로 — ① 첫 화면 완성도 ② 표시 정보(상태/근거/학습/안내/진행) 품질 ③ CLI 성능. 여신 마스코트 아트는 진안 소유(불가침). Tier2 (worktree `/tmp/muse-cli-excellence`, branch `loop/cli-excellence`, push + PR; main 머지는 진안). cron `a4520c8e` (20m, session-only).

Convention: [README](README.md).

## fire 1 · 2026-06-21 · skill v2.1.0 · <commit>
meta: value-class=new-capability · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +0 (added 5 cases to existing commands-status.test.ts) · @muse/cli 2881 green · check exit 0 · smoke:cli 9/9 · lint 0 · fabrication 0

- **무엇**: `muse status` at-a-glance 대시보드 + `--json` 스냅샷에 프라이버시 posture(local-only) 라인 추가. 새 export 순수 헬퍼 `formatPrivacyPosture(snapshot)` + `collectStatus`에 `localOnly: evaluateLocalOnlyPosture(process.env)`(additive, schema v1 유지) + `renderStatus` providers 블록 뒤 `privacy:` 라인 1줄.
- **왜**: Muse의 #1 정체성("local by default, cloud egress refused")이 `muse doctor`엔 있으나 매일 보는 at-a-glance 첫화면 대시보드엔 누락이었다. facts는 doctor와 **동일한 단일 진실원** `evaluateLocalOnlyPosture`에서 파생 → 두 표면이 posture를 두고 절대 어긋날 수 없다. fabrication=0: 4분기 문구가 각 (enabled,status)에 strictly entailed("egress blocked/possible", "no cloud credentials").
- **리뷰지점**: 문구는 glance-sized(detail-verbatim 아님)이고 정밀 진단(어떤 클라우드 키/off-box 임베더 URL)은 `muse doctor`로 위임 — 단일 진실원은 facts(enabled/status)이지 prose가 아니므로 divergence 없음. 독립 Opus ④b judge PASS.
- **리스크**: 낮음. diff는 commands-status.ts + 그 테스트로 한정. 여신 아트 불가침 준수. ④b judge가 잡은 nit(와이어링 테스트가 canonical 5개 클라우드 키 중 4개만 삭제 → GOOGLE_API_KEY 누락)은 즉시 하드닝(5개 전부 삭제)으로 수정함.
- **레퍼런스**: claude-code(트리 포맷)·gemini-cli(박스 레이아웃)·starship/oh-my-posh(at-a-glance 상태 표기) 첫화면 관행 — 표시 정보는 "한눈에, 정직하게". https://shipyard.build/blog/claude-code-vs-gemini-cli/ · https://github.com/ratatui/ratatui

### sibling-audit (이번 fire 미적용 → backlog)
- chat REPL 하단 HUD(chat-ink.ts:822-833)는 model·proactive·agent·tools·skills·tokens를 보여주나 **local-only posture 미표시** — 같은 클래스 형제. 공간 제약 + 라이브 상태라 별도 fire로(다른 (pkg,kind)).
