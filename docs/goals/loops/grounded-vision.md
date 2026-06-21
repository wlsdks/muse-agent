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

## fire 2 · 2026-06-21 · skill v2.0.0 · ae37c354
meta: value-class=hardening · pkg=@muse/cli · kind=vision-input-validation · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1066→1067 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · cli 2790 PASS(+5 신규) · check 2790 · mutation-first RED 확인(가드 revert→DROP/RECONCILE 2케이스 RED) · merge origin/main 충돌0(merge 모델 작동)
- 무엇: fire-1 형제 — `muse chat --image`의 readImage가 확장자만 믿던 입력 구멍을, fire 1이 만든 공유 leaf(sniffImageMime)를 재사용해 fail-close. readImage를 chat-ink-core.ts의 exported readImageAttachment로 추출(공유 leaf 경유), non-image면 undefined(원래 실패 shape), 이미지면 sniffed mimeType 보정. chat-ink.ts는 1줄 위임.
- 왜: 입력단 visual-integrity 구멍이 ask·chat 두 표면에 동일하게 있었음(형제-감사가 fire 1에서 발견). 두 surface 모두 닫아 입력 fabrication floor 완성. 공유 leaf 재사용으로 중복 sniffer 없음. arXiv:2404.18930.
- 리뷰지점: 독립 적응형 judge가 return/async 계약 정확 보존(undefined-on-failure·consumer `if(img)` 동일 처리·sync→async 변경 아님), over-reject 회귀 없음(실 receipt.png 로드), 가드 revert→DROP/RECONCILE RED 실증, accept-list 불변. 기계적 미러라 Sonnet 빌더 + Opus judge 티어링.
- 리스크: 낮음 — chat→Ollama 이미지 배선의 라이브 round-trip은 미검증(입력 게이트는 결정론으로 증명, consumer 코드 불변으로 보장). prefix-only sniff 한계는 fire 1과 동일.

## fire 3 · 2026-06-21 · skill v2.0.0 · 0f301103
meta: value-class=capability · pkg=@muse/cli · kind=vision-routing-grounding · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1067 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · cli 2794 PASS(+4 신규) · check 2794 · eval:vision-grounding 3/3 라이브 PASS · mutation-first 양방향 RED 확인
merge: main FF 스킵 (origin/main 고경쟁 — ~8 동시 루프가 main을 계속 밀어 FF 재시도도 짐; fire 3 작업은 브랜치에 안전, 다음 3배수 fire에서 재시도). lesson: 고경쟁 main에선 ⑤c FF가 자주 스킵 — 브랜치가 진짜 산출, main 머지는 best-effort
- 무엇: vision --apply가 한 필드라도 unverified면 전체 거부하던 것을 field-level partial-apply로 — un-grounded OPTIONAL 필드는 드롭하고 grounded 코어 적용, REQUIRED 필드 unverified면 전체 fail-close. splitUnverified+dropUnverifiedOptional, REQUIRED_FIELDS는 KIND_EXTRACT 스키마에서 파생.
- 왜: grounded merchant+total인데 hallucinated date(optional) 하나로 영수증 노트 전체가 막히던 usability+grounding-completeness 갭. fabrication=0 보존: dropUnverifiedOptional이 surviving source 필드로 재구성+shapeVisionAction 재실행해 파생 문자열(note/path/draftText)이 드롭 값 없이 재생성 → un-grounded 값은 절대 영속 안 됨, grounded 형제만 적용. 입력단(fire1·2)에서 라우팅/적용단으로 다운스트림 이동(다양성). arXiv:2404.18930.
- 리뷰지점: 독립 적응형 judge가 모든 kind의 persist 경로 추적해 드롭 값이 자기 슬롯에 안 남음 확인, required-map 파생+route-gate 일치 검증, mutation 양방향 RED 실증. eval:vision-grounding 라이브 3/3.
- 리스크: 낮음(cosmetic) — contact의 유일 연락처가 드롭되면 route:none·fields:{} 되어 오해성 "✅ Done:added:false" 출력(스토어가 fail-close라 fabrication/부분쓰기 없음). → backlog ◦.

## fire 4 · 2026-06-21 · skill v2.0.0 · 5b66ce16
meta: value-class=hardening · pkg=@muse/cli · kind=vision-extraction-grounding · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1067 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · vision-actions 26 PASS(+신규) · @muse/model 격리 325 PASS(check의 model 실패는 박스포화 flake) · mutation-first 2 RED 확인 · eval:vision-grounding 워커 미보고(judge가 self-eval+200k 퍼즈로 대체검증)
- 무엇: fieldIsGrounded가 hallucinated 짧은 숫자값(≤3자리)을 그 digit-run이 증거 어디든(할인%·시각·주소) 있으면 grounded로 오판하던 것을, weak-numeric 가드로 fail-close. hasTextToken 추가 → ≥4자리 significant run도 없고 텍스트/CJK 토큰도 없는 값은 word-token 분기 전에 false 반환(우회 불가).
- 왜: 오판된 값이 unverified에서 빠져 grounded 취급→partial-apply(fire 3) 경로로 영속되던 fabrication-floor 누수. grounding 게이트 자체를 조이는 hardening(추출-vs-증거 일관성, arXiv:2404.18930). 입력(fire1·2)→라우팅(fire3)→추출-grounding 정밀도로 다양성 이동.
- 리뷰지점: 독립 적응형 judge가 200k 퍼즈로 strictly-stricter 증명(NEW가 OLD보다 더 ground 0건), over-drop 없음(12,400→digitRuns 분리자정규화로 12400≥4 → 가드 미도달; 2026·phone·text 모두 ground), 가드 우회불가(weakNumericOnly return이 wordTokens보다 앞), mutation revert→2 RED. gate-level OUTCOME(짧은 hallucinated total이 unverified에 안착) 검증.
- 리스크: 낮음(fail-close) — 진짜 작은 숫자 필드(실제 ₩500 total, 수량 "2")도 항상 unverified로 드롭됨(안전하나 usability론 fail-close). 진짜 해결은 field-role 의미 필요(아래 ◦).

## fire 5 · 2026-06-21 · skill v2.0.0 · 2f3e933a
meta: value-class=hardening · pkg=@muse/agent-core · kind=primitive-validation · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1069 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · agent-core 2533 PASS(+신규 vision-extract 23) · check apps/api flake(격리 864 PASS) · mutation-first 확인(검증 call 삭제→4 RED, 조건 mutate→8 RED) · pkg를 cli→agent-core로 이동(다양성)
- 무엇: vision 추출 primitive extractStructuredFromImage가 출력이 JSON 객체인지만 보고 schema.required 검증을 안 하던 것을 — 순수 validateExtraction(required 전부 존재+non-empty string; declared-string prop이 non-string이면 위반; schema/required 없으면 ok:true back-compat) 추가해 fail-close. agent-core index export.
- 왜: hollow `{}`나 merchant 없는 영수증이 ok:true로 라우팅/grounding 레이어에 흘러가던 것을 source에서 차단(no-partial-result, AppWorld arXiv:2407.18901). enforce하는 required는 shapeVisionAction이 이미 라우팅에 요구하던 필드라 working flow 안 깨짐 — 실패를 앞당길 뿐. fires 1-4 전부 cli였는데 pkg를 agent-core로 이동(다양성 RATCHET). primitive 첫 테스트 커버리지.
- 리뷰지점: 독립 적응형 judge가 7개 실콜러 전수(KIND_EXTRACT 5 + commands-ask 2) 정당 추출 실패 없음 확인, back-compat(absent schema/required→ok:true), 성공경로에서 검증 실행, 테스트 non-inert(call 삭제→4 RED·조건 mutate→8 RED), groundedSurfaces=28. (judge가 실험 중 restore→diff로 byte-faithful 복원, 오케스트레이터가 빌드+23테스트 재확인.)
- 리스크: 낮음 — 미래에 non-string 타입 추출 prop을 의도적으로 원하는 caller면 fail-close(현재 모든 스키마 string-only라 무해, 향후 주의).

## fire 6 · 2026-06-21 · skill v2.0.0 · f3ca1cb0
meta: value-class=hardening · pkg=@muse/cli · kind=vision-extraction-grounding · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1070 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · vision-actions 34/34 PASS · cli 2823/2823 · eval:vision-grounding 3/3 라이브 PASS · mutation-first 양방향 RED 확인
merge: main FF 스킵 (origin/main 고경쟁 — fire 3과 동일; fire 6 작업은 브랜치 안전, 다음 3배수서 재시도) [⑤c 시도 결과는 push 단계서 확정]
- 무엇: fieldIsGrounded의 amount 필드 2결함(① $2026이 연도 run에 grounding되는 누수 ② fire-4 weak-numeric 가드가 진짜 $40을 over-drop)을 field-role anchoring으로 한 번에 — 필드명 threading(name optional→back-compat), total=amount role, amount 값의 digit-run이 통화/금액 마커($₩€£¥·KRW/USD·total/amount/due 등)에 ~2자 인접해야 grounding.
- 왜: $2026(Concert 옆)은 통화마커 없어 FALSE(누수 닫음), $40($옆)은 TRUE(fire-4 over-drop 수리). 확정 fabrication 누수 닫기 + 알려진 over-drop 회복을 한 메커니즘으로. 비-amount 필드 불변. digit-run은 digitRuns의 순수 숫자라 regex-injection 없음(judge 200k 퍼즈 0ms 확인). arXiv:2404.18930.
- 리뷰지점: 독립 적응형 judge가 새 false-pass 없음·back-compat byte-exact(name 생략시)·테스트 non-inert(revert→4 RED)·ReDoS-safe·cli 2823/2823·byte-clean 확인. fire 4의 잔여 ◦를 fire 6이 self-correct.
- 리스크: 낮음 — 같은 값+마커 인접의 hallucinated total(티켓 $40 vs 가짜 $40 total)은 구별 불가하나 literal-presence 게이트의 본질적 한계(어떤 게이트도 동일). 단일자리 total($5)은 fail-close(안전).
- lesson(무관·pre-existing): `pnpm check`가 commands-logo.test.ts의 raw ESC 바이트(타 루프 commit e10ac6c2 "muse goddess mascot", origin/main 존재)로 repo-wide RED — 내 슬라이스 무관(backlog ◦ 기록). [[feedback_no_raw_control_bytes_in_tests]] 재발.

## fire 7 · 2026-06-21 · skill v2.0.0 · a68647b0
meta: value-class=hardening · pkg=@muse/model · kind=adapter-image-validation · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1070 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · model adapter-ollama 52/52 PASS · @muse/shared byte-hygiene 44/44(commands-logo main-sync 후) · mutation-first 5 RED 확인 · pkg를 cli→model로 이동(다양성 — 5/6 cli 모노컬처 완화)
- 무엇: Ollama 어댑터 image 경로(adapter-ollama.ts ~340)가 base64를 length>0만 보고 forward하던 것을 — 순수 isWellFormedBase64(canonical RFC-4648, data: prefix는 거부)로 malformed 첨부를 드롭. 메시지가 images 없이 나가 downstream grounding이 fail-close.
- 왜: malformed base64가 Ollama에 도달하면 Ollama가 이미지를 조용히 버리고 텍스트만으로 "비전" 답을 날조 — transport-seam ungrounded 소스. 입력단(fire1·2 magic-byte)과 다른 seam(어댑터 경계)을 닫음. 모든 valid base64는 byte-identical(실 caller 전부 Buffer.toString 확인). arXiv:2404.18930.
- 리뷰지점: 독립 적응형 judge가 4개 실 fixture + 모든 base64 producer 추적해 over-drop 없음 확인(canonical만 — 미래 MIME-wrap caller면 over-drop 가능, 문서화), 테스트 non-inert(revert→5 RED wire-body seam), groundedSurfaces=28. 무관 pre-existing commands-logo byte 이슈는 main의 fix를 sync해 해소(check unblock).
- 리스크: 낮음 — 미래에 MIME-wrap(76-col \n) base64를 이 seam에 보내는 caller가 생기면 decodable 이미지를 fail-close 드롭(현재 call graph 전부 Buffer.toString이라 무해, 문서화됨).
