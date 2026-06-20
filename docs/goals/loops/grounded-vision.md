# Loop journal — `grounded-vision`

Theme: 근거-있는 비전/멀티모달 — Muse의 이미지→근거-추출→draft-first 액션 경로(gemma4 멀티모달,
`muse ask --image`, vision 추출 primitive)를 한 fire에 하나씩 STRENGTHEN하고 결정론/라이브 배터리로
PROVE한다. 다른 세션(신뢰성·컴퓨터컨트롤·hermes·협업/기억/도구·surfaces·컨텍스트)과 겹치지 않는
distinct 테마. grounded-surface 카운트는 절대 안 떨어진다.

Worktree `/tmp/muse-grounded-vision` · branch `loop/grounded-vision` (Tier2 push, merge-기반 git) ·
cron `abd98181` (15m, session-only). 매 fire ⓪에서 `git merge --no-edit origin/main`(rebase 금지 →
push 항상 FF). 3 fire마다 `:main` FF 머지. 규약: [README](README.md).

---

## fire 1 · 2026-06-20 · skill v2.0.0 · a670dec5
meta: value-class=hardening · pkg=@muse/cli · kind=vision-input-validation · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1062→1063 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · cli 2773 PASS(+6 신규) · check 2773 · eval:vision 4/4 PASS(라이브 gemma4 — 실 fixture over-reject 없음) · mutation-first RED 확인(가드 revert→DROP 2케이스 RED)
- 무엇: vision 입력 게이트 loadImageAttachment가 확장자만 검증하던 것을 magic-byte 콘텐츠 검사로 fail-close. 공유 leaf image-bytes.ts(sniffImageMime/looksLikeImage, 시그니처는 commands-show.ts에서 byte-faithful 추출·중복 제거) 추가, non-image 바이트면 거부, 이미지면 sniffed mimeType로 보정(JPEG-in-.png→image/jpeg).
- 왜: note.png인데 바이트가 텍스트/잘못된 포맷이면 통과해 잘못된 mimeType으로 gemma4에 전달되던 입력단 fabrication 구멍(추출-vs-증거 게이트로는 못 잡음 — 두 패스가 같은 나쁜 바이트를 봄). 입력단 visual-integrity는 생성단 grounding과 별개 환각원(MLLM 환각 서베이 arXiv:2404.18930). 차별화 엣지를 vision 입력 seam으로 확장.
- 리뷰지점: 독립 적응형 judge가 시그니처 byte-for-byte 충실(over-reject 회귀 없음 — 실 receipt.png fixture 로드 확인), 가드 revert→DROP-1/2 RED 실증, 조정은 sniff 성공시만(null이면 fail-close 동일 shape). commands-show 거동 불변(전체 스위트 그린).
- 리스크: 낮음 — sniff는 prefix-only라 truncated-but-valid-header non-decodable 파일은 통과 가능하나, pre-fix 확장자-신뢰보다 나쁘지 않음(out of scope).
- 형제-감사: chat-ink.ts readImage(~943)가 chat-ink-core.ts의 자체 IMAGE_MIME_BY_EXT(~396)로 콘텐츠 sniff 없이 같은 입력 구멍 보유 → backlog ◦ follow-up(muse chat --image 경로). 다른 image-load 콜사이트는 없음.
