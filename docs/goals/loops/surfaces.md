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

## fire 2 · 2026-06-13 · skill v1.14.0 · 782c24ad
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=stale-default-model · verdict=PASS · firesSinceDrill=2
ratchet: desktop swift tests 46/46 (added 2) · fabrication 0 · self-eval exit 0 · consecutive allPASS=2

- **무엇**: macOS desktop 컴패니언이 health-check·온보딩하던 기본 모델이 구식 `qwen3:8b`였다 → 정규 기본값 `gemma4:12b`로 수정(`OllamaHealth.requiredModel`). `.notRunning` 안내(KO+EN)는 모델명을 하드코딩하던 걸 `\(OllamaHealth.requiredModel)` 보간으로 바꿔 다시 drift하지 않게.
- **왜**: CLI 정규 기본은 `LOCAL_FIRST_DEFAULT_MODEL = ollama/gemma4:12b`([[project_gemma4_default]])인데 desktop만 qwen3:8b를 확인·안내 → 사용자가 틀린 모델을 pull하거나 영영 modelMissing으로 보이는 실제 버그.
- **리뷰지점**: desktop은 Ollama `/api/tags`에 맞춰 **bare 태그**(`ollama/` 접두 없이 `gemma4:12b`)를 쓴다. 남은 desktop의 `qwen` 참조는 비-버그(parse doc 예시 + `.qwen3TTS_0_6b` TTS 음성모델).
- **리스크**: 없음(MuseDesktopCore 2-파일 미세 변경, `.modelMissing`/`parse` 무변, 독립 Opus judge가 정규 기본·bare태그·누락참조 검증 후 PASS, 46/46).

## fire 3 · 2026-06-13 · skill v1.14.0 · 1a1c9fc6
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=help-vs-output-inconsistency · verdict=PASS · firesSinceDrill=3
ratchet: cli tests 2567/2567 (find suite 6, +1) · fabrication 0 · self-eval exit 0 · consecutive allPASS=3 · 세 표면 모두 1+ fire (web·desktop·cli)

- **무엇**: `muse find`(`apps/cli/src/commands-find.ts`)는 4개 도메인(tasks·reminders·contacts·**calendar**)을 검색하는데 no-match 메시지만 "tasks, reminders, or contacts"라 calendar를 빠뜨렸다. 순수 헬퍼 `formatNoMatches(query)`를 `DOMAIN_LABELS`에서 유도(drift-proof)해 네 도메인 모두 명시 → "No tasks, reminders, contacts, or calendar match …".
- **왜**: help 텍스트·`DOMAIN_LABELS`·matcher 모두 calendar를 1급 도메인으로 다루는데 빈-상태 문구만 거짓 범위를 알려, 사용자가 "calendar는 검색됐는데 없는 건지, 아예 안 됐는지" 알 수 없었다(help-vs-output 불일치).
- **리뷰지점**: 빈-상태 목록은 이제 `DOMAIN_LABELS`에서 유도되므로 5번째 도메인 추가 시 자동 동기화. `--json`(total:0)·non-empty grouped 출력은 무변.
- **리스크**: 없음(empty-state 분기 1줄 교체 + 순수 헬퍼, 독립 Opus judge가 구-코드 RED·collateral·순서 검증 후 PASS, find 6/6 · cli 2567/2567).

## fire 4 · 2026-06-13 · skill v1.14.0 · f27253c0
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=i18n-locale-correctness · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 926 (+1) · web tests 17/17 (+2) · fabrication 0 · self-eval exit 0 · consecutive allPASS=4

- **무엇**: `Tasks.tsx`만 유일하게 task 생성일을 `toLocaleDateString()`(locale 인자 없음)으로 렌더 → 사용자 선택 언어 무시, 런타임 기본 로케일로 표시. 순수 헬퍼 `formatTaskDate(iso, locale)` 추출 + `useI18n()`에서 `locale` 추출해 배선.
- **왜**: 다른 9개 뷰(Today/Calendar/Reminders/…)는 전부 `useI18n().locale`을 포매터에 넘기는데 Tasks만 누락 → 한국어 모드에서 task 날짜가 `6/13/2026`처럼 엉뚱한 로케일로 나오는 실제 i18n 정확성 버그.
- **리뷰지점**: `locale`은 `LOCALES`(en→en-US, ko→ko-KR) BCP-47 문자열. 헬퍼 추출은 Calendar.tsx의 기존 선례와 일치하며 React 하네스 없이 단위테스트 가능.
- **리스크**: 없음(3줄 변경: 헬퍼+locale 추출+렌더 교체, tsc+vite build clean, 독립 Opus judge가 sibling 패턴·ICU-robust 검증 후 PASS, web 17/17).

## fire 5 · 2026-06-13 · skill v1.14.0 · 1502e897
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=raw-json-leak · verdict=PASS · firesSinceDrill=5
ratchet: desktop swift tests 48/48 (+2) · fabrication 0 · self-eval exit 0 · consecutive allPASS=5

- **무엇**: `MuseBridge.parseAnswer`가 **유효 ChatJSON인데 `response`가 빈** 경우(`{"response":""}` 등) `cleanAnswer(raw)`로 폴백해 **raw JSON을 버블에 표시하고 Speaker가 소리내어 읽었다**. decode 성공 시 (빈 문자열이라도) text를 바로 반환하도록 고쳐 빈-응답이 `MusePresenter`의 무음 "노트에 없음" 분기로 흐르게.
- **왜**: doc은 "JSON이 아닐 때만 cleanAnswer 폴백"을 약속하는데 빈-응답 케이스가 잘못 폴백 → 모델 hiccup·CLI 변경 시 사용자가 `{"response":""}`를 보고 *듣는* 실제 버그. cleanAnswer 폴백은 진짜 비-JSON에만 유지(graceful degradation 보존).
- **리뷰지점**: JSONDecoder는 미지의 키 무시 → `{"runId":…}`도 response/answer nil→"". 비-JSON(bare string/number/array/ANSI)은 decode 실패 → cleanAnswer 경로 보존.
- **리스크**: 없음(empty-text 가드 1개 제거 + 2 테스트, cleanAnswer/유일 caller ask() 무변, 독립 Opus judge가 leak 수정·폴백 보존·잘못된 빈값 없음 probe 검증 후 PASS, 48/48).

## fire 6 · 2026-06-13 · skill v1.14.0 · 6c93d7c1
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=input-validation-consistency · verdict=PASS · firesSinceDrill=6
ratchet: cli tests 2576/2576 (contacts 22, +2) · fabrication 0 · self-eval exit 0 · consecutive allPASS=6 · 표면 균형 web2·desktop2·cli2

- **무엇**: `muse contacts birthdays --within`가 잘못된 값을 조용히 삼켰다 — `abc`→NaN→무음 30 폴백(exit0), `-5`→"next -5 days" 출력(exit0), float/무한대 통과. 이제 비-유한·`<1`이면 stderr 에러+exit1, 아니면 `Math.min(365, Math.trunc(parsed))`로 clamp(MCP 도구 twin과 동일 1..365 계약).
- **왜**: 동일 개념의 MCP 도구(`contacts-tool.ts`)는 1..365 clamp하고 sibling CLI 플래그(`parsePositiveInt`/`clampScanLimit`)는 exit1로 거부하는데, `--within`만 에러를 삼켜 사용자가 의도와 다른 창을 신호 없이 받았다(cross-surface 불일치).
- **리뷰지점**: clamp(reject 아님)이라 기존 `--within 400` 테스트는 365로 통과 유지. throw 아닌 `io.stderr+exitCode=1+return` 패턴(이 파일 sibling과 동일, `run` 하니스가 exitOverride+process.exitCode를 읽으므로 깨끗한 exit1).
- **리스크**: 없음(birthdays 액션 --within 파싱 블록 한정, default-30/listing 경로 무변, 독립 Opus judge가 경계(0/1/365/400/10.5)·회귀·하니스 적합성 검증 후 PASS, 2576/2576).

## fire 7 · 2026-06-13 · skill v1.14.0 · 0dcc6cc2
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=i18n-dangling-label · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 932 (+1) · web tests 19/19 (+2) · fabrication 0 · self-eval exit 0 · consecutive allPASS=7 (다음 fire=8 → JUDGE-DRILL)

- **무엇**: `memory.subtitle`이 타임스탬프 도입용 라벨("Updated"/"업데이트")을 문자열에 박아둬, `updatedAt` 부재 시(404→`{}` 도달 경로) 두 로케일 모두 "...about you. Updated" 댕글링 라벨 노출. subtitle을 완결 문장으로 바꾸고 라벨을 신규 키 `memory.updated`({when} 슬롯)로 분리 + 순수 헬퍼 `memorySubtitle(t, locale, updatedAt)` 추출.
- **왜**: `updatedAt`이 없을 때 값 없는 라벨이 잘려 보이는 실제 사용자-노출 카피 버그(en+ko 둘 다). 라벨을 값에 바인딩하는 키로 분리하면 부재 시 깔끔한 문장, 존재 시 "· Updated <날짜>".
- **리뷰지점**: i18n 불변식 유지 — `memory.updated`를 en/ko 양쪽에 추가(키셋 패리티), 둘 다 `{when}` 토큰(토큰 패리티), 빈값 없음. 헬퍼는 fire 4 `formatTaskDate`와 동일한 추출 패턴.
- **리스크**: 없음(subtitle 2줄 + 신규 키 + 헬퍼 + JSX 호출, tsc+vite clean, 독립 Opus judge가 양 로케일·불변식·구-코드 RED 검증 후 PASS, web 19/19 + strings parity).

## fire 8 · 2026-06-13 · skill v1.14.0 · bbccd21d · ★JUDGE-DRILL
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=multiline-receipt-strip+judge-drill · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: desktop swift tests 49/49 (+1) · fabrication 0 · self-eval exit 0 · ★verifier 신뢰성 입증(inert→FAIL, real→PASS)

- **무엇**: `stripCitationsForSpeech`의 영수증 strip 정규식 `\s*📎[^\n]*`(헤더 줄만)을 `\s*📎[\s\S]*`(첫 📎부터 끝까지)로 확장. 멀티라인 영수증(`📎 Sources:\n- a.md\n- b.md`, `present.ts` 포맷)에서 소스 파일경로가 음성으로 읽히던 누출을 막음. **이 fire는 JUDGE-DRILL**: 먼저 *inert 테스트*(멀티라인인데 "답변 남음"만 검증, 구-코드서도 통과)를 주입 → 독립 Opus judge가 **FAIL로 잡음**(실증: 구 정규식서도 green, 소스 누출 미검증) → 롤백 → 진짜 RED→GREEN 테스트(`== "The MTU is 1380."` + 소스 줄 부재)로 교체 → judge PASS.
- **왜**: consecutive allPASS=7로 검증자가 PASS만 해와, 실제로 나쁜 슬라이스를 FAIL시키는지 점검 필요(maker=judge 보상통제 — agent-testing.md). 동시에 영수증 멀티라인 누출은 진짜 desktop 음성 버그(파일경로 낭독).
- **리뷰지점**: 영수증은 항상 trailing(`present.ts` 38/163/328) → 📎-to-end strip 안전. 드릴이 검증자가 rubber-stamp가 아님을 증명; firesSinceDrill 0 리셋.
- **리스크**: 없음(정규식 1줄 + 행동 테스트, 기존 single-line/inline 테스트 무변, bubbleText 무영향, 독립 Opus judge 2회(inert FAIL→real PASS) 검증, 49/49). ⚠️동시 codebase-quality 루프 주석편집이 worktree에 bleed-over → 비-desktop 8파일 `git checkout`으로 복원 후 내 슬라이스만 커밋.
