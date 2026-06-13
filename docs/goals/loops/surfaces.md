# Loop journal — `surfaces`

> Theme: Muse의 3대 제품 표면 — CLI (`@muse/cli`) · macOS desktop app (`apps/desktop`, Swift) · web (`@muse/web`) — 검증하며 계속 강화.
> Worktree `/tmp/muse-surfaces` (branch `loop/surfaces`), Tier1 + 로컬 main ff-머지 (push 없음). Cron session-only, 30분 주기.
> Convention: [README](README.md). One entry per fire; `meta:` lines are grep-able counters for the SURFACE+VALUE-CLASS ratchet.

## fire 1 · 2026-06-13 · skill v1.14.0 · 060810c4
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=link-scheme-hardening · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 918 (added 2 cases to existing file) · fabrication 0 · web tests 15/15 · self-eval exit 0

- **무엇**: web Markdown 렌더러(`apps/web/src/components/markdown.tsx`)의 링크 스킴 allowlist를 `http(s)`-only에서 `http(s)`/`mailto:`/`tel:`로 확장. 모델이 답하는 `[bob@x.com](mailto:bob@x.com)` / `[the desk](tel:+1…)` 링크가 이제 클릭 가능(이전엔 `href="#"`로 죽음). `javascript:`/`data:`/`vbscript:`는 계속 `#`로 차단.
- **왜**: 채팅 답변에 연락처가 자주 등장하는데 안전한 `mailto:`/`tel:`까지 무력화돼 UX 손실이었다. 안전 스킴만 허용 + 위험 스킴 명시 차단 테스트로 보안 불변식(실행 가능한 URL 주입 0)을 *유지하면서* 표면을 강화.
- **리뷰지점**: 스킴 allowlist는 정규식 `^(https?:\/\/|mailto:|tel:)/i` 한 줄 — 새 스킴 추가 시 *반드시* 비실행(inert) 스킴인지 확인하고 차단 테스트를 함께 추가할 것. `data:`/`vbscript:`는 영구 차단.
- **리스크**: 없음(순수 렌더러 단일-줄 변경, 독립 Opus 적대 judge가 bypass probe 포함 PASS, 무관 마크다운 기능 13종 무변).
