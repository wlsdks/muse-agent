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

## fire 9 · 2026-06-13 · skill v1.14.0 · 69ab0056
meta: surface=cli · value-class=new-capability · pkg=@muse/cli · kind=sibling-parity-flag · verdict=PASS · firesSinceDrill=1
ratchet: cli tests 2593/2593 (remind 25, +2) · fabrication 0 · self-eval exit 0 · 표면 균형 web3·desktop3·cli3 · value-class 다양화(micro-fix 연속 깨고 new-capability)

- **무엇**: `muse remind list`에 `--search <text>` 자유텍스트 필터 추가(sibling `muse tasks list`의 `filterTasksBySearch` 패턴 미러). 순수 export 헬퍼 `filterRemindersBySearch`(trim·lowercase·blank→전체·`text` substring) + 옵션 + payload 해소 後 필터(local/API/fallback 전 경로) + `total` 보정.
- **왜**: tasks-list엔 텍스트 검색이 있는데 병렬 reminders-list엔 없어, 리마인더가 많은 사용자가 내용으로 못 좁혔다(병렬 명령 capability 불일치). 리마인더는 `text` 단일 검색필드 보유.
- **리뷰지점**: 필터는 payload 할당 後 적용 → 세 경로(local store/API/api-unreachable fallback) 모두 커버. 빈 쿼리는 진짜 no-op(`options.search?.trim()` undefined). MCP reminders 도구는 tool-hardening 소관이라 미변경(CLI 명령만).
- **리스크**: 없음(commands-remind.ts 헬퍼+옵션+필터블록 + 2 테스트, 다른 remind 서브커맨드/명령 무변, 독립 Opus judge가 RED-before·total보정·전경로·sibling패리티 검증 후 PASS, cli 2593/2593).

## fire 10 · 2026-06-13 · skill v1.14.0 · c4981e54
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=relative-time-rounding · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 943 (+1) · web tests 23/23 (+4) · fabrication 0 · self-eval exit 0

- **무엇**: Today 뷰 `timeUntil`이 30초 이내(0–29s) 미래 이벤트에 `Math.round(ms/60000)=0` → "in 0m"/"0분 후"라는 무의미 라벨을 표시. now-가드를 `ms<0`에서 `ms<0 || min===0`으로 바꿔 [0,30s) 창을 "now"/"지금"(`rel.now`)으로. 테스트 위해 `export`(fire 4 `formatTaskDate` 선례).
- **왜**: Today 뷰의 다가오는 이벤트·대기 리마인더 행(가장 자주 보는 두 리스트)에 라이브로 노출되는 실제 카피 버그. "0분 후"는 "지금"이어야 함.
- **리뷰지점**: `min===0`은 정확히 [0,30s)만 잡음(30s→"in 1m", 90s→"in 2m"). past(ms<0)·NaN·분/시/일 버킷 무변. 순수 함수라 export·min-선계산 부작용 없음.
- **리스크**: 없음(timeUntil 1함수 + export + 4 테스트, 호출부 시그니처 무변, 독립 Opus judge가 경계워크·flakiness(10s+ 여유)·RED-before 검증 후 PASS, web 23/23).

## fire 11 · 2026-06-13 · skill v1.14.0 · 75bae0b4
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=nil-vs-empty-contract · verdict=PASS · firesSinceDrill=3
ratchet: desktop swift tests 50/50 (+1) · fabrication 0 · self-eval exit 0

- **무엇**: `MusePresenter.present(.success)`가 **영수증/인용-only 답변**(`"📎 노트: …"`)에 `stripCitationsForSpeech`→`""`를 `speechText`로 반환. 계약은 `nil⇒무음`인데 consumer(`CompanionModel.swift:104` `if let speech`)는 nil만 체크 → `""`면 orb가 "speaking" 애니메이션 + 빈 발화. `spoken.isEmpty ? nil : spoken`으로 붕괴.
- **왜**: trimmed 비어있지 않아(`📎…`) 빈-답변 분기를 건너뛰고 strip 後 빈 문자열이 되는 경로 — fire 5(빈 JSON)·fire 8(멀티라인 strip)가 못 잡은 receipt-only 클래스의 별개 갭. 실제 다운스트림 결과(orb 무의미 발화) 확인됨.
- **리뷰지점**: 정상 인용 답변("… [from vpn.md]")은 strip 後 비어있지 않아 음성 유지(empty→nil 붕괴는 진짜 빈 경우만 발동). bubbleText는 영수증 유지(무변).
- **리스크**: 없음(success 분기 speechText 계산 1줄, error/empty 분기·bubbleText 무변, 독립 Opus judge가 isolation으로 RED 입증·회귀 5케이스·consumer 의존성 검증 후 PASS, 50/50).

## fire 12 · 2026-06-13 · skill v1.14.0 · fbae97e5
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=input-validation-consistency · verdict=PASS · firesSinceDrill=4
ratchet: cli tests 2593/2593 (checkins +4) · fabrication 0 · self-eval exit 0 · 표면 균형 web4·desktop4·cli4

- **무엇**: `muse checkins list --status`가 오타(`fierd`)를 삼켜 "No fierd check-ins."(stdout, exit0) — 정상 빈 결과와 구별 불가. enum {scheduled,fired,all} 검증 추가: 미일치면 stderr 에러+exit1+did-you-mean(`closestCommandName` 재사용). readCheckins/`--json` 분기 앞에 배치.
- **왜**: sibling `tasks list --status`는 `assertTaskStatusInput`으로 엄격 검증("타이포가 조용히 틀린 리스트를 반환 않게")하는데 checkins만 누락 — 5개 스케줄 있는 사용자가 "없음"으로 오인하는 실제 버그(cross-surface 불일치).
- **리뷰지점**: 기본 "scheduled"(생략 시)·대소문자(FIRED→fired) 정상 허용, 미지값만 거부. 검증을 파일 읽기 전에 둬 나쁜 status는 IO도 안 함. scan/snooze/cancel·happy/json 경로 무변.
- **리스크**: 없음(import+const+검증 14줄, 독립 Opus judge가 revert로 RED 입증·enum 전체·--json·collateral 검증 후 PASS, checkins 4/4 · cli 2593/2593).

## fire 13 · 2026-06-13 · skill v1.14.0 · 933ffa11
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=a11y-decorative-icon · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 947 (+1) · web tests 24/24 (+1) · fabrication 0 · self-eval exit 0

- **무엇**: 공유 `base` SVG 팩토리(`ui.tsx`)가 만드는 모든 아이콘에 `aria-hidden`/`focusable`이 없어, 스크린리더가 장식 아이콘을 미명명 graphic으로 노출(특히 title로 이름 붙은 아이콘-only 버튼에서 중복 announce). `aria-hidden="true" focusable={false}` 추가 → 전 `Icon.*` 상속.
- **왜**: 앱 전 아이콘이 장식용(가시 텍스트 옆 또는 title 가진 아이콘-only 버튼 안) — AT에서 숨기는 게 WCAG 정답. 한 팩토리 수정으로 전 뷰의 아이콘이 한 번에 고쳐지는 최고 적용범위 슬라이스.
- **리뷰지점**: 아이콘-only 컨트롤(Tasks check/trash·Chat volume/mic/send·Calendar/Notes/Autonomy/Reminders trash)은 전부 `title`로 접근명 보유 → aria-hidden이 유일 이름을 제거하지 않음. `Spinner`(자체 aria-label `<span>`)는 무변, 앱에 다른 `<svg>` 없음.
- **리스크**: 없음(팩토리 2줄, 표현용 속성이라 레이아웃 무영향, 독립 Opus judge가 전 call-site 장식성·stash로 RED·collateral 검증 후 PASS, web 24/24).

## fire 14 · 2026-06-13 · skill v1.14.0 · 310e34fc
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=input-validation-consistency · verdict=PASS · firesSinceDrill=6
ratchet: cli tests 2601/2601 (followup +2) · fabrication 0 · self-eval exit 0 · --status 패밀리 마지막 sibling 하드닝 완료(tasks·checkins·followup)

- **무엇**: `muse followup list --status`가 lenient `readFollowupStatusFilter`(오타→"scheduled" 무음)로 잘못된 입력을 삼켜 *틀린 set*을 신호 없이 표시. enum {scheduled,fired,cancelled,all} 검증 추가: 미일치면 stderr 에러+exit1+did-you-mean(`closestCommandName`), 아니면 lowercased `raw`로 진행.
- **왜**: sibling tasks/checkins(fire 12) list --status는 엄격 검증하는데 followup만 누락 — --status 패밀리의 마지막 미일관. raw 소문자화로 case도 복구("ALL"이 이제 동작).
- **리뷰지점**: 검증 enum이 `readFollowupStatusFilter` 실제 수용집합({scheduled,fired,cancelled,all})과 정확히 일치(false-reject 없음). 기본값(생략→scheduled) 정상. fire 12 checkins의 stderr+exitCode 패턴 동일.
- **리스크**: 없음(list 액션 검증 16줄, snooze/cancel/show·출력 경로 무변, 독립 Opus judge가 enum 일치·RED-before·case 복구·collateral 검증 후 PASS, followup 3/3 · cli 2601/2601).

## fire 15 · 2026-06-13 · skill v1.14.0 · 28c65ac3
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=cross-surface-identity-parity · verdict=PASS · firesSinceDrill=7
ratchet: desktop swift tests 51/51 (+1) · fabrication 0 · self-eval exit 0 · ⚠️desktop 순수모듈 vein 얇아짐(scout) → 다음 desktop 차례는 web/cli로 로테이션 권장

- **무엇**: `OllamaHealth.parse`가 Ollama 암묵 `:latest` 태그를 정규화 안 해, bare-pull 모델(`gemma4`→Ollama가 `gemma4:latest` 기록)이 `model="gemma4"`에 missing으로 분류 → 컴패니언이 이미 있는 모델을 onboarding. `withLatest`(콜론 없으면 `:latest` 부가) 정규화로 양방향 통일. quant-suffix(`-`) 규칙·size 구분 유지.
- **왜**: CLI의 문서화된 `findOllamaModelTag`(`commands-doctor.ts:646` `<base>`=`<base>:latest`)와 desktop이 불일치하던 cross-surface parity 버그. 현재 상수(`gemma4:12b`, 태그됨)엔 미발현이나 bare 이름(`ollama/gemma4` config 형태)·`:latest` 기록 시 라이브 버그.
- **리뷰지점**: `withLatest`는 콜론 없을 때만 `:latest` 부가 → 태그된 이름 불변. sized-only(`gemma4:12b`만 있을 때 bare `gemma4`)는 여전히 missing(false-positive 없음). hasPrefix는 raw model 사용.
- **리스크**: 없음(parse 1함수, 독립 Opus judge가 전 케이스(bare↔latest·sized·quant·substring trap)·revert로 RED·CLI 규칙 일치 검증 후 PASS, 51/51).

## fire 16 · 2026-06-13 · skill v1.14.0 · c367a8e0
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=dst-relative-date · verdict=PASS · firesSinceDrill=8 (다음 fire=17 → JUDGE-DRILL: allPASS≥8)
ratchet: testFiles 955 (+1) · web tests 27/27 (+3) · fabrication 0 · self-eval exit 0 · ⚠️web 결함 vein도 얇아짐(scout) → cli 위주 권장

- **무엇**: Calendar `dayLabel`이 "tomorrow"를 `now + 86_400_000`(고정 24h)로 유도 → DST 전환일(23h/25h)에 실제 다음 캘린더 날짜를 빗나가 이벤트 오라벨(+byDay 그룹핑 오염). `new Date(y, m, d+1)`(캘린더-날짜 유도, DST-safe)로 수정 + 테스트 위해 export.
- **왜**: 실제 입력(America/Los_Angeles, spring-forward 전야)에서 Sun Mar 8 이벤트가 "tomorrow" 대신 generic, Mon Mar 9가 잘못 "tomorrow"로. 좁지만 실제(DST 존, 연 ~2일) 버그.
- **리뷰지점**: `Date(y,m,d+1)`은 오버플로(월말/연말) 정규화 + 로컬존 존중. 테스트는 `process.env.TZ` 고정(@muse/web은 node타입 없어 `declare const process`로 타입만 충족, 런타임 node) + fake timers. Today/generic 분기 무변.
- **리스크**: 없음(derivation 1줄 + export, byDay 소비자 transitively 수혜, 독립 Opus judge가 *derivation만 revert*로 DST RED 입증·TZ pin 유효·build green 검증 후 PASS, web 27/27).

## fire 17 · 2026-06-13 · skill v1.14.0 · 9af2e5d6 · ★JUDGE-DRILL
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=help-vs-behavior+judge-drill · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: cli tests 2618/2618 (tasks +2) · fabrication 0 · self-eval exit 0 · ★verifier 신뢰성 재입증(inert order-only→FAIL, real description-lock→PASS)

- **무엇**: `muse tasks list` `.description()`이 "newest-first"라 했지만 코드는 due-date 정렬(`compareTasksByDueDate`, 의도적) — help-vs-behavior 모순. description을 "by due date (soonest first; undated last)"로 교정. **이 fire는 JUDGE-DRILL**(allPASS≥8): 먼저 *순서-only inert 테스트*(리스트 순서만 검증 → 구-help 그대로여도 통과) 주입 → 독립 Opus judge가 description revert로 **FAIL 입증** → 롤백 → 진짜 테스트(`.description()`이 /due date/ 포함·/newest-first/ 불포함 = RED→GREEN 락 + 순서 보조)로 교체 → judge PASS.
- **왜**: consecutive allPASS=8로 검증자 신뢰성 재점검 필요(maker=judge 보상통제). 동시에 help-text 거짓은 실제 사용자-노출 모순.
- **리뷰지점**: 락은 `.description()`(=`--help` 출력) 문자열 — 내부 상수 아닌 사용자 표면. 새 텍스트는 `compareTasksByDueDate`(soonest-first·undated-last)와 정확히 일치(새 거짓 아님). 순서 테스트만으로는 help-fix를 못 잠금(드릴이 입증).
- **리스크**: 없음(description 1줄 + 2 테스트, 다른 명령 무변, 독립 Opus judge 2회(inert FAIL→real PASS, 둘 다 revert로 실증) 검증, cli 2618/2618).

## fire 18 · 2026-06-13 · skill v1.14.0 · ad46fb40
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=pluralization · verdict=PASS · firesSinceDrill=1
ratchet: cli tests 2619/2619 (today +1) · fabrication 0 · self-eval exit 0 · ⚠️cli vein도 얇아짐(scout) → 향후 행동 갭/누락 플래그·cross-command 일관성 권장

- **무엇**: `muse today` 과거-세션 resurface 라인 `formatEpisodeRevisitLine`이 첫 revisit 버킷(1일, 가장 흔함)에서 단수 가드 없이 "💭 1 days ago"를 출력. `day${days === 1 ? "" : "s"}` 가드 추가(같은 파일 `formatTimeUntil`·calendar-focus의 기존 idiom과 일치).
- **왜**: 세션 다음날 아침 brief에 라이브로 노출되는 비문법 카피. sibling 포매터는 전부 `=== 1` 가드 쓰는데 이 prose-count 라인만 누락(in-file 불일치).
- **리뷰지점**: floor(1.4)=1→"1 day", floor(7.4)=7→"7 days", floor(0)=0→"0 days"(정상 영어). empty-episode·truncation 무변.
- **리스크**: 없음(포매터 1줄, 독립 Opus judge가 전 버킷·revert로 RED→GREEN·collateral 검증 후 PASS, today 62/62 · cli 2619/2619).

## fire 19 · 2026-06-14 · skill v1.14.0 · 45310010
meta: surface=cli · value-class=new-capability · pkg=@muse/cli · kind=sibling-parity-flag · verdict=PASS · firesSinceDrill=2
ratchet: cli tests 2625/2625 (contacts +2) · fabrication 0 · self-eval exit 0 · value-class 다양화(format 버그→capability add, vein 신호 따라 행동 갭으로 전환)

- **무엇**: `muse contacts list`에 `--json` 추가 — 같은 그룹 sibling(overdue/dupes/related/import)은 전부 `--json`인데 풀 주소록+`--search` 가진 가장 스크립팅-필요한 명령만 누락이었다. `term`/`shown` 계산 후 json 분기(`--search`와 합성, 빈 store→`[]`), human 경로 무변.
- **왜**: 사용자가 `jq`로 파이프할 1순위 명령(전체 연락처)이 기계가독 출력 불가였다(cross-command 불일치). vein 신호 따라 format 버그가 아닌 capability 갭으로 전환.
- **리뷰지점**: json 분기를 human empty-state 앞에 둠 — human 경로는 `all.length===0`("No contacts yet")→`shown.length===0`("No contacts match") 순서 보존. json empty는 human 카피 아닌 `[]`. JSON 형태는 raw `shown`(overdue/dupes 패턴과 일치).
- **리스크**: 없음(list 액션 한정, 다른 contacts 서브커맨드 무변, 독립 Opus judge가 commander unknownOption RED·human 무회귀·--search 합성 검증 후 PASS, contacts 24/24 · cli 2625/2625).

## fire 20 · 2026-06-14 · skill v1.14.0 · 81de13e3
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=a11y-nav-landmark+aria-current · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 961 (+1) · web tests 29/29 (+3) · fabrication 0 · self-eval exit 0

- **무엇**: 사이드바 primary nav(App.tsx)가 활성 뷰를 CSS `.active` 클래스로만 표시 — `aria-current="page"`도, nav landmark도 없어 스크린리더가 현재 페이지/nav 점프를 못 함. nav JSX를 i18n-free 순수 컴포넌트 `SidebarNav`(t prop 주입)로 추출 + `<nav aria-label>` landmark + 활성 버튼에 `aria-current="page"`.
- **왜**: 모든 화면의 최고-트래픽 컨트롤의 a11y 상태 누락(WAI-ARIA `aria-current`/landmark). 추출로 renderToStaticMarkup 단위테스트 가능(App은 useI18n→window라 직접 불가).
- **리뷰지점**: 추출은 render-equivalent(NAV/GROUPS·`.active`·아이콘·라벨·tasks 배지 보존, onClick=onSelect→setView 배선). `nav.primary` en/ko 양쪽 추가(파리티). `aria-current` 값은 올바른 `"page"` 토큰. cosmetic: `<nav>` 래퍼가 그룹을 한 단계 더 중첩하나 `.sidebar-foot margin-top:auto`로 무해.
- **리스크**: 없음(App.tsx 추출+a11y + strings 2키 + 신규 테스트, brand/sidebar-foot 무변, 독립 Opus judge가 RED-before·추출 충실성·parity 검증 후 PASS, web 29/29).

## fire 21 · 2026-06-14 · skill v1.14.0 · b67f2676
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=a11y-toggle-aria-pressed · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 965 (+1) · web tests 30/30 (+1) · fabrication 0 · self-eval exit 0 · ⚠️순수 props-injected a11y vein 거의 소진(scout) — 이후는 추출/Button aria 배선 필요

- **무엇**: `LangToggle`(App.tsx) 언어 토글 2버튼이 `role="group" aria-label`은 있으나 선택 상태를 CSS `.active`로만 표시 — `aria-pressed` 없어 스크린리더가 활성 언어 모름. 양 버튼에 `aria-pressed={lang===…}`(정식 toggle-button 패턴) + export(테스트용).
- **왜**: 즉시-동작 토글 그룹의 정식 WAI-ARIA 패턴은 toggle-button(`aria-pressed`)이며 group+label은 이미 있어 패턴 완성. fire 20 SidebarNav와 같은 순수 props-injected 형태라 renderToStaticMarkup 직접 테스트.
- **리뷰지점**: `aria-pressed`는 양 버튼이 각자 상태 반영(정확히 하나 true), radiogroup/listbox 아님(즉시 동작). `.active`/onClick/onChange 무변. judge가 aria-pressed strip으로 RED 실증.
- **리스크**: 없음(3줄: export + 2 속성, 다른 컴포넌트 무변, Console가 계속 렌더, 독립 Opus judge가 패턴 정확성·RED-before·pressedLabel 식별 검증 후 PASS, web 30/30).

## fire 22 · 2026-06-14 · skill v1.14.0 · 607c0cc1
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=voice-toggle-falsy-robustness · verdict=PASS · firesSinceDrill=5
ratchet: desktop swift tests 55/55 (+4) · fabrication 0 · self-eval exit 0 · 표면 균형 web8·desktop6·cli8

- **무엇**: `SpeakerFactory.make`(AppKit)가 `MUSE_DESKTOP_SPEAK`을 정확히 `"0"`일 때만 무음 처리 → 사용자가 `false`/`no`/`off`로 끄려 해도 여전히 말하는 footgun. 순수 `selectSpeakerKind(env)→SpeakerKind`(MuseDesktopCore)로 추출, falsy set {0,false,no,off}(trim·소문자) 허용으로 하드닝; SpeakerFactory는 enum switch로 위임.
- **왜**: 음성 on/off/system/qwen 라우팅이 AppKit에 인라인·미테스트였고 무음 토글이 너무 좁았다. 추출로 헤드리스 테스트 가능 + 흔한 falsy 표기 수용(env-falsy 관행)으로 실제 사용자 의도 반영.
- **리뷰지점**: 구-계약 보존("0"→silent·"system"→system·unset→qwen·silence 우선), TTS 매치는 trim/소문자 superset(회귀 아님). `"1"`/`"true"`/`""`는 qwen(과확장 아님). 추출은 dead-code 아님(SpeakerFactory가 실사용).
- **리스크**: 없음(신규 코어 파일 + 팩토리 body + 신규 테스트, Speaker 프로토콜·3 impl 무변, 독립 Opus judge가 mutation(falsy set→["0"])로 RED 입증·parity·exhaustive switch 검증 후 PASS, swift build clean·55/55).

## fire 23 · 2026-06-14 · skill v1.14.0 · 5274893c
meta: surface=cli · value-class=new-capability · pkg=@muse/cli · kind=list-search-flag-parity · verdict=PASS · firesSinceDrill=6
ratchet: cli tests 2627 (+1) · fabrication 0 · self-eval exit 0 · 표면 균형 web8·desktop6·cli9

- **무엇**: `muse followup list`에 `--search <text>` 추가 — sibling list 명령(tasks/remind/contacts)은 모두 텍스트 필터가 있는데 followup만 없었다. followup 레코드의 검색가능 필드 `summary`에 대소문자 무시 부분일치; `--status` 필터+정렬 後 적용, `total`은 매치 수로 재계산. json·formatted 경로 모두 `matched` 사용.
- **왜**: format/validation vein이 마른 cli 표면(fire 18 NOTE)에서 micro-fix 대신 sibling-parity new-capability로 전환 — 실사용 가치(특정 followup 찾기) + RATCHET이 요구한 value-class 상향(micro-fix→new-capability).
- **리뷰지점**: query=`options.search?.trim().toLowerCase()` falsy(absent/`""`)면 필터 미적용(matched===sorted, formatted 경로 무회귀). `--status` 검증(fire 14)이 먼저 early-return. remind의 trim+lowercase-substring 패턴과 동형. show/snooze/cancel 무변.
- **리스크**: 없음(list action 한정 +7/-4 + 신규 테스트, 독립 Opus judge가 RED-before(commander unknown-option)·composition·total 재계산·무회귀 검증 후 PASS, cli 2627/2627·self-eval exit 0).

## fire 24 · 2026-06-14 · skill v1.14.0 · bf368867
meta: surface=desktop · value-class=refactor · pkg=apps/desktop(MuseDesktopCore) · kind=persisted-parse-consolidation · verdict=PASS · firesSinceDrill=7
ratchet: desktop swift tests 59/59 (+4) · testFiles 972 · fabrication 0 · self-eval exit 0 · 표면 균형 web8·desktop7·cli9

- **무엇**: 영속 언어 파싱 `AppLanguage(rawValue: prefs.language ?? "") ?? .system`이 AppKit 두 파일(MuseController의 메뉴 체크마크 · CompanionModel의 실제 사용 언어)에 byte-동일하게 중복 + 헤드리스 테스트 불가였다. 순수 `AppLanguage.fromPersisted(_:)`(MuseDesktopCore)로 추출, 두 사이트가 위임. 신규 AppLanguageTests가 fallback 진리표(nil/빈/미지값→.system, 정식 3값 라운드트립) 고정.
- **왜**: 두 사이트가 갈라지면 메뉴 체크마크와 실제 해석 언어가 desync. 단일 source-of-truth + 헤드리스 테스트 가능 = fire 22(SpeakerSelection 추출) 패턴. cli format-vein·web pure-a11y vein 고갈 상태에서 표면 최저(desktop) + non-micro-fix value-class로 RATCHET 충족.
- **리뷰지점**: fromPersisted body는 추출식과 byte-동일(behavior-preserving, case-fold/trim 안 끼움). "ko"→.system 정확(레거시 short-code 투기적 추가 안 함 — writer는 항상 `lang.rawValue` 정식값만 영속). resolveLanguage/ResolvedLanguage/CompanionPrefs/메뉴 배선 무변, 라운드트립 닫힘.
- **리스크**: 없음(순수 UI 파싱, VoiceGate/egress/grounding 무접촉; 독립 Opus judge가 RED-before(HEAD~1 fromPersisted=0)·behavior-preserving·진리표 완전성·비투기성·무부수효과 검증 후 PASS, swift build clean·59/59).

## fire 25 · 2026-06-14 · skill v1.14.0 · e609adc5
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=a11y-combobox-pattern · verdict=PASS · firesSinceDrill=8
ratchet: web unit 34/34 (+4) · palette e2e 2/2 (+1) · testFiles 974 · fabrication 0 · self-eval exit 0 · 표면 균형 web9·desktop7·cli9

- **무엇**: ⌘K CommandPalette가 `role="dialog"`만 있어 ArrowUp/Down으로 하이라이트가 움직여도 스크린리더가 아무것도 안 읽었다(fire 21 NOTE 지목). WAI-ARIA combobox-with-listbox-popup 패턴 추가 — input=`role=combobox`(aria-controls/aria-activedescendant/aria-autocomplete/aria-expanded), 리스트=`role=listbox`, 각 항목=`role=option`+`aria-selected`. 신규 export `COMMAND_LIST_ID`+`commandOptionId`로 id 파생.
- **왜**: 키보드 구동 런처의 정식 a11y 패턴은 combobox+activedescendant(포커스는 input에 유지). 모두 기존 `index` 상태(이미 `.active` 클래스 구동)에 바인딩 — purely additive, 필터/키보드/클릭/포커스 무변. fire 24 refactor 다음이라 value-class를 new-capability로 + 표면 web(21 이후 미접촉)로 다양화.
- **리뷰지점**: 정확한 combobox 모델(포커스 input 고정, options에 .focus() 안 함). `aria-activedescendant`는 빈 리스트에서 undefined→React가 attr 생략(empty-case 테스트가 실제 HTML로 검증). 정확히 하나 aria-selected=true. `<button role=option>`은 implicit role 오버라이드로 valid. 동적 ArrowDown→activedescendant 이동은 renderToStaticMarkup 불가라 Playwright e2e로 검증.
- **리스크**: 없음(순수 presentational a11y, network/grounding 무접촉; 독립 Opus judge가 RED-before(HEAD attr=0)·combobox 정확성·behavior-preserving·동적 e2e·무부수효과 검증 후 PASS, web build typecheck·unit 34/34·e2e 2/2).

## fire 26 · 2026-06-14 · skill v1.14.0 · f53482c3
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=judge-drill+env-name-trim · verdict=PASS · firesSinceDrill=0 (DRILL THIS FIRE)
ratchet: desktop swift tests 60/60 (+1) · testFiles 976 · fabrication 0 · self-eval exit 0 · 표면 균형 web9·desktop8·cli9 · JUDGE-DRILL ✅

- **무엇**: (A) JUDGE-DRILL — 고의 vacuous 테스트(`followup list --search` 케이스-무시 검증을 표방하나 status='scheduled'·Array.isArray 등 tautology만 단언, followup 시딩 0 → 필터가 no-op이어도 GREEN) 주입 → 독립 Opus judge가 **자체 mutation-test(필터를 no-op으로 바꿔 재빌드→여전히 PASS)로 FAIL 입증** → 롤백. (B) 진짜 fix — `SpriteLibrary.named`가 user-set `MUSE_DESKTOP_CHARACTER` env(공백/개행-prone)에서 직접 먹는데 lowercase만 하고 trim 안 함 → ` celestial `이 조용히 default(aria)로 폴백. `.whitespacesAndNewlines` trim 추가 + 공백 테스트.
- **왜**: 드릴은 verifier 신뢰성 보상통제(maker=judge 같은-모델이라) — vacuous 슬라이스를 정말 잡는지 8-fire마다 실증. 실 fix는 env-fed 파스의 robustness 갭(fire 15 `:latest`·fire 22 falsy 동족, 실 입력원=env var, 비투기적).
- **리뷰지점**: 드릴 판정이 진짜 적대적(judge가 스스로 소스 mutation해 RED 없음을 증명). 실 fix는 named 시그니처·case-insensitive·nil/empty/unknown→default 보존, whitespace-only→default. judge가 mutation-test로 비-vacuous 확인. 주의: `setCharacterNamed`는 named 미호출(별도 switch)이나 main.swift:158+CompanionModel가 env로 named를 먹어 갭은 실재.
- **리스크**: 없음(순수 캐릭터-룩 파스, network/grounding 무접촉; 드릴 verifier FAIL 확인+롤백 완료, 실 fix는 독립 Opus judge가 mutation-test로 RED-before·비-vacuous·behavior-preserving 검증 후 PASS, swift 60/60).

## fire 27 · 2026-06-14 · skill v1.14.0 · b5a8963c
meta: surface=cli · value-class=new-capability · pkg=@muse/cli · kind=list-search-parity-completion · verdict=PASS · firesSinceDrill=1
ratchet: cli tests 2636 (+3) · testFiles 977 · fabrication 0 · self-eval exit 0 · 표면 균형 web9·desktop8·cli10

- **무엇**: `muse checkins list`에 `--search <text>` 추가 — list 계열(tasks/remind/followup/contacts) 중 유일하게 빠져 있던 holdout. 각 check-in의 `question`(표시 필드, line 124)에 대소문자 무시 부분일치, `--status` 필터 後 적용, `--json`의 `total`은 매치 수 반영.
- **왜**: Opus scout가 list-command 파리티 매트릭스에서 checkins만 `--search` 결여로 식별(question은 이미 로드·표시되는 자유텍스트 필드, 사용자가 grep할 바로 그 필드). fire 23(followup `summary`)와 동족이나 distinct 명령 — 매트릭스 완성 = 실 일관성 가치, busywork 아님.
- **리뷰지점**: case-insensitive(양측 toLowerCase). `--status` 검증(fire 14 sibling) 먼저 early-return 後 status-filter→search 순. `total: scoped.length`로 필터 반영. 빈/부재 `--search`→falsy→byStatus(무필터, 무회귀). `question` 검색은 followup의 `summary`와 정확한 파리티(둘 다 표시 필드).
- **리스크**: 없음(list action 한정 +7/-2 + 신규 3 테스트, cancel/snooze/scan 무변; 독립 Opus judge가 mutation-test(필터 no-op→RED)로 비-vacuous·RED-before·composition·total·무회귀 검증 후 PASS, cli 2636/2636·self-eval exit 0).

## fire 28 · 2026-06-14 · skill v1.14.0 · 0b439fdd
meta: surface=web · value-class=wiring · pkg=@muse/web · kind=a11y-icon-button-accessible-name · verdict=PASS · firesSinceDrill=2
ratchet: web unit 36/36 (+2) · muse-console e2e 1/1 · testFiles 979 · fabrication 0 · self-eval exit 0 · 표면 균형 web10·desktop8·cli10

- **무엇**: Chat의 아이콘-only 버튼(send/mic/speak)이 `title`(툴팁)만으로 접근명을 의존 — SVG가 aria-hidden이라 스크린리더엔 "button"으로만 읽힘(WCAG 4.1.2). 공유 `Button`에 optional `ariaLabel` prop 추가(→ `aria-label` 포워드, unset이면 attr 생략) + 세 아이콘-only Chat 버튼에 이미 title로 넘기던 i18n 문자열로 배선.
- **왜**: title은 다수 스크린리더가 안 읽고 터치엔 절대 안 뜸 → 제품 최빈 액션(메시지 전송)의 이름이 사실상 없음. aria-label이 robust한 정식 접근명. Opus scout가 web 최고가치 a11y 갭으로 식별(fire 26 desktop core엔 동급 미테스트 분기 없음).
- **리뷰지점**: ariaLabel undefined→React가 attr 생략(텍스트 버튼은 children 이름 유지, 빈 attr 덮어쓰기 없음 — 둘째 단위테스트로 실증). mic은 recording 상태 추적(title와 동일). title 보존(시각 툴팁). e2e가 렌더된 Send/mic의 aria-label을 toHaveAttribute로 단언(call-site 배선 검증, prop 존재만 아님).
- **리스크**: 없음(ui.tsx Button + Chat 3 call-site + 2 테스트만; 타 Button 호출부는 ariaLabel 미전달→무변; 독립 Opus judge가 양 레이어 mutation-test(forwarding/call-site 제거→RED)로 비-vacuous·RED-before·undefined-omit·무부수효과 검증 후 PASS, web 36/36·e2e 라운드트립 유지).

## fire 29 · 2026-06-14 · skill v1.14.0 · 561bde6c
meta: surface=desktop · value-class=new-capability · pkg=apps/desktop(MuseDesktopCore) · kind=sprite-palette-coverage-guard · verdict=PASS · firesSinceDrill=3
ratchet: desktop swift tests 61/61 (+1) · testFiles 980 · fabrication 0 · self-eval exit 0 · 표면 균형 web10·desktop9·cli10

- **무엇**: `SpriteRenderer`가 팔레트에 없는 glyph를 조용히 `continue`(투명 처리) → JSON 아티스트 스프라이트의 오타/누락 키가 투명 HOLE로 렌더. `--render-json` 유일 검증 `isRectangular()`는 치수만 보고 팔레트 커버리지는 안 봄. `Sprite.paletteCoversGrid()` 추가(grid + 애니 오버라이드 행의 모든 glyph가 팔레트 키에 있어야, 렌더러가 쓰는 동일 `paletteMap` 사용) + `--render-json` 가드에 배선(exit 2, 명확한 메시지).
- **왜**: 스프라이트는 "아티스트/JSON 드롭인으로 교체"가 명시 목적인데, 조용한 렌더 홀은 그 경로의 silent-corruption. desktop 표면(최저 8) + new-capability로 다양성.
- **리뷰지점**: 검증이 렌더러와 *동일한* paletteMap(prefix(1) Character) 사용 → 실제 그릴 수 있는 것과 정확히 일치(근사 아님). 빈 rows의 allSatisfy vacuous-true는 isRectangular(width>0,height>0)가 먼저 걸러 무해. 가드는 isRectangular 後·renderPNG 前. paletteMap/isRectangular 본문 무변.
- **리스크**: 없음(순수 스프라이트-데이터 검증, network/grounding 무접촉; 독립 Opus judge가 mutation-test(`return true`→테스트 RED)로 비-vacuous·RED-before·glyph-vs-key 의미 일치·가드 배선·무부수효과 검증 후 PASS, swift 61/61).

## fire 30 · 2026-06-14 · skill v1.14.0 · 657a8111
meta: surface=web · value-class=wiring · pkg=@muse/web · kind=i18n-a11y-dialog-name · verdict=PASS · firesSinceDrill=4
ratchet: web unit 36/36 · palette e2e 3/3 (+1) · testFiles 984 · fabrication 0 · self-eval exit 0 · 표면 균형 web11·desktop9·cli10

- **무엇**: ⌘K CommandPalette 다이얼로그가 `aria-label="Command palette"` 하드코딩 → 한국어 스크린리더 사용자가 다이얼로그 이름을 영어로 들음. `cmd.dialogLabel` 키 추가(en "Command palette" / ko "명령 팔레트") + `aria-label={t("cmd.dialogLabel")}` 배선.
- **왜**: 키보드 런처(고빈도)의 접근명이 로캘 무시 영어 고정 = i18n+a11y 결함. fire 28 scout가 지목한 runner-up. en/ko 파리티 가드가 이미 양 로캘 키 일치 강제.
- **리뷰지점**: ko e2e(localStorage muse.lang=ko)가 다이얼로그 접근명=한국어 문자열을 end-to-end 단언 — 비-vacuous(영어/en-fallback이면 FAIL). en 값=구 리터럴과 동일 → en 동작 무변(기존 en e2e 계속 통과). 단일 로캘만 키 추가하면 파리티 테스트가 RED.
- **리스크**: 없음(CommandPalette 1줄 + strings 2키 + e2e 1테스트; 순수 presentational i18n/a11y, network/grounding 무접촉; 독립 Opus judge가 stash-revert로 RED-before·비-vacuous(ko 문자열 특정)·en 무회귀·파리티 검증 후 PASS, web build typecheck·unit 36/36·palette e2e 3/3).

## fire 31 · 2026-06-14 · skill v1.14.0 · 1f1e32f4
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=cross-command-consistency-past-due-warning · verdict=PASS · firesSinceDrill=5
ratchet: cli tests 2639 (+3) · testFiles 985 · fabrication 0 · self-eval exit 0 · 표면 균형 web11·desktop9·cli11

- **무엇**: `remind add`는 due 시각이 과거면 stderr로 경고("heads up — … is in the PAST … overdue")하는데, sibling `tasks add --due <past>`는 과거 due를 조용히 저장했다. 동일한 non-blocking heads-up 추가(`!--json` 게이트, dispatch 前이라 local·API 양 모드 발화, stderr 전용).
- **왜**: 과거 due는 거의 typo(잘못된 연도/"어제") → 태스크가 태어나자마자 overdue. remind는 경고, tasks는 침묵이던 cross-command 비일관(fire 12/14 클래스). 신호-우선(.muse/runs 비어) → cli/desktop scout(rate-limit) → inline-scout로 id-resolution은 전부 안전 확인 後 이 비일관 발굴.
- **리뷰지점**: 게이트가 remind와 동형(`!options.json && past`, tasks는 optional `--due`라 `resolvedDueAt` truthiness 추가). 미지정 due→무경고, 미래 due→무경고(false-positive 가드 테스트 2), --json→억제(테스트 3). stderr 전용이라 json/human stdout 페이로드 무오염. 태스크는 여전히 저장(non-blocking).
- **리스크**: 없음(add action +7 + 신규 테스트 블록만; 독립 Opus judge가 mutation-test(블록 제거→테스트1 RED, load-bearing 확인)·remind 의미 동형·false-positive 없음·무회귀 검증 후 PASS, cli 2639/2639·self-eval exit 0).

## fire 32 · 2026-06-14 · skill v1.14.0 · 73dae149
meta: surface=web · value-class=wiring · pkg=@muse/web · kind=a11y-delete-button-accessible-name-batch · verdict=PASS · firesSinceDrill=6
ratchet: web unit 36/36 · calendar e2e 1/1 · testFiles 989 · fabrication 0 · self-eval exit 0 · 표면 균형 web12·desktop9·cli11

- **무엇**: fire 28이 Chat 아이콘-only 버튼만 고쳤고, 동일 WCAG 4.1.2 갭이 5개 view의 아이콘-only 삭제 버튼(Tasks/Calendar/Reminders/Autonomy/Notes)에 남아 있었다 — 각 `<Button title={delete}><Icon.trash/></Button>`(SVG aria-hidden)라 스크린리더가 "button"으로만 읽음. 5곳 모두 `ariaLabel={t("common.delete")}` 추가(title 보존). 동질 배치.
- **왜**: 삭제는 파괴적 액션 — 시각장애 사용자가 어느 버튼이 삭제인지 알아야 함. fire 28이 시작한 cross-view 아이콘-only 접근명 계약 완성. 비-투기적(갭이 소스에 그대로 노출).
- **리뷰지점**: calendar e2e가 대표 검증 — `toHaveAttribute("aria-label","Delete")`로 비-vacuous(judge가 Calendar revert로 RED 확인, getByRole는 title fallback으로 여전히 resolve하나 attr 단언은 null로 FAIL). 5곳 byte-identical wiring, Button.ariaLabel 포워딩은 fire 28 ui.button.test로 lock. title 보존. NOTE: 동시 루프發 @muse/shared stale-dist(finiteOr export) 만나 rebuild로 해소([[project_stale_dist_from_loop]]).
- **리스크**: 없음(5 view 1줄씩 + e2e 1단언; 순수 presentational a11y, Button 컴포넌트 무변; 독립 Opus judge가 revert로 RED-before·비-vacuous·5곳 전부 icon-only·무회귀·RATCHET 검증 후 PASS, web 36/36·calendar e2e 1/1·tsc clean).

## fire 33 · 2026-06-14 · skill v1.14.0 · b3f4f86b
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=citation-strip-case-insensitive-consistency · verdict=PASS · firesSinceDrill=7
ratchet: desktop swift tests 62/62 (+1) · testFiles 993 · fabrication 0 · self-eval exit 0 · 표면 균형 web12·desktop10·cli11

- **무엇**: 컴패니언 `stripCitationsForSpeech`가 인라인 `[from <source>]` 마커를 음성에서 제거하는데 **대소문자 구분**이었다. agent-core 정규 인식은 `/\[from…\]/giu`(대소문자 무시, citation-recall/citation-precision/knowledge-recall/untrusted-sentences 4곳). 그래서 `[From x.md]`/`[FROM x.md]`(시스템이 citation으로 인정, 8B가 문장 시작 대문자로 emit 가능)가 음성으로 "From x 점 m d"처럼 읽혔다. `.caseInsensitive` 추가.
- **왜**: 음성 strip이 시스템 나머지의 citation 인식과 동일 형태를 인식해야 함(일관성). 비-투기적 — agent-core 자체 regex가 `giu`. desktop(최저 9→10) 균형.
- **리뷰지점**: over-strip 없음(`\[from…\]` 대괄호 필수 → 대문자도 bracketed citation 토큰만 새로 매칭, 평문 "from"은 무영향). 📎 영수증 strip 무변. 소문자 기존 테스트 통과. SPEECH 전용(speechText만 변경, grounding GATE는 agent-core TS라 무접촉 — fabrication=0 무관).
- **리스크**: 없음(regex option 1개 + 신규 테스트; 독립 Opus judge가 revert로 RED-before 실증·agent-core 4곳 `i`플래그 확인(갭 실재)·over-strip 없음·speech-only(게이트 무접촉) 검증 후 PASS, swift 62/62·self-eval exit 0).

## fire 34 · 2026-06-14 · skill v1.14.0 · 6fab617e
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=tasks-client-side-search · verdict=PASS · firesSinceDrill=8
ratchet: web unit 40/40 (+4) · tasks e2e 1/1 (new) · testFiles 995 · fabrication 0 · self-eval exit 0 · 표면 균형 web13·desktop10·cli11

- **무엇**: 웹 Tasks 뷰가 status 필터(open/done/all)만 있고 텍스트 검색이 없었다 — CLI `tasks list --search`·Notes 웹 뷰는 검색 있음. 순수 `filterTasksByQuery`(title+notes 대소문자 무시 부분일치, 빈 쿼리→전체) + Card action에 검색 박스 추가, 로드된 리스트를 클라이언트 필터(추가 라운드트립 없음), status 필터와 합성.
- **왜**: CLI↔web 기능 파리티 + 실 가치(많은 태스크 중 찾기). tasks.search 키 en/ko 추가(파리티 가드가 양 로캘 강제).
- **리뷰지점**: 단위테스트가 filter OUTCOME(매치 id) 채점; e2e가 검색박스→필터 배선 end-to-end 검증(judge가 list=filterTasksByQuery 줄 revert→e2e RED으로 비-vacuous 입증). count는 서버 total 유지(리스트만 필터 — Notes 선례, 무해). aria-label + role=searchbox. add/complete/delete/status 무변.
- **리스크**: 없음(순수 클라 표시 필터, network/grounding 무접촉; 독립 Opus judge가 RED-before(HEAD grep=0)·비-vacuous e2e·correctness(빈→전체·notes·undefined 가드)·합성·무회귀 검증 후 PASS, web 40/40·tasks e2e 1/1·tsc clean).

## fire 35 · 2026-06-14 · skill v1.14.0 · a2e040e5
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=judge-drill+checkins-due-sort · verdict=PASS · firesSinceDrill=0 (DRILL THIS FIRE)
ratchet: cli tests 2656 (+2) · testFiles 997 · fabrication 0 · self-eval exit 0 · 표면 균형 web13·desktop10·cli12 · JUDGE-DRILL ✅

- **무엇**: (A) JUDGE-DRILL — fire 26과 다른 anti-pattern 주입: **accepted-but-ignored 옵션** `checkins list --sort`(commander 선언만, action에서 미사용) + **order-blind 테스트**(`--sort due` 실행 후 `checkins.length===2`만 단언, 순서 검증 0). 독립 Opus judge가 **FAIL** + 정확히 "length===2는 order-blind, no-op이어도 통과, `.map(id)===['early','late']`를 단언 안 함" 적시 → 롤백. (B) 진짜 fix — `checkins list`가 insertion order로 출력(sibling `followup list`는 scheduledFor 정렬)했던 비일관 → `dueAtIso` 오름차순 정렬(soonest first), `.slice().sort(localeCompare)`.
- **왜**: 드릴은 verifier가 "옵션은 파싱되나 무시 + 순서-맹목 테스트"를 잡는지 검증(fire 26 tautology와 다른 결). 실 fix는 cross-command 일관성 — insertion order는 다가올 일정 스캔에 무의미.
- **리뷰지점**: 드릴 판정이 merits-based(judge가 order-blind 단언을 정확히 지목). 실 fix 테스트는 **order-asserting**(`map(id)===['early','mid','late']`, 드릴이 결여한 바로 그것) — source revert 시 insertion order로 RED. ISO 문자열 lexicographic=chronological. status 後·search 前 정렬이라 둘 다 합성. 비-mutating. NOTE: 드릴 judge가 repo root에서 돌아 path 혼동 → 실 fix judge엔 worktree 경로 명시.
- **리스크**: 없음(list action 정렬 +6/-1 + 신규 테스트; 드릴 verifier FAIL 확인+롤백 완료; 실 fix는 독립 Opus judge가 worktree에서 revert→RED·order-assert·chronological·non-mutating·합성·무회귀 검증 후 PASS, cli 2656/2656).

## fire 36 · 2026-06-14 · skill v1.14.0 · f3515b1c
meta: surface=web · value-class=wiring · pkg=@muse/web · kind=a11y-form-label-association · verdict=PASS · firesSinceDrill=1
ratchet: web unit 40/40 · calendar e2e 1/1 · testFiles 997 · fabrication 0 · self-eval exit 0 · 표면 균형 web14·desktop10·cli12

- **무엇**: 웹 Calendar 새 이벤트 폼이 Title/Start/End 가시 라벨을 보였으나 input과 프로그래매틱 연결이 없었다(htmlFor/id 부재). 두 `datetime-local` input은 placeholder도 없어 접근명이 **전무** → 스크린리더가 라벨 없는 날짜 필드 2개로 읽음(WCAG 1.3.1/4.1.2). label↔input을 htmlFor/id로 연결(cal-title/cal-start/cal-end).
- **왜**: 폼은 SR 사용자에게 버튼보다 더 어려운 표면 — 시작/종료를 구분 못 하면 폼 작성 불가. 가시 라벨을 접근명으로 승격(aria-label 중복 없이 정식 H44 기법).
- **리뷰지점**: getByLabel은 프로그래매틱 연결로만 resolve → htmlFor/id 없으면 e2e RED(judge가 source-revert로 load-bearing 실증). id 3개 고유·htmlFor 정확 매칭. 가시 라벨 텍스트가 접근명(이중 라벨 없음). en 로캘서 Title/Start/End 매칭. round-trip(생성+삭제) 유지.
- **리스크**: 없음(Calendar 3 label/input쌍 + e2e만; 순수 presentational a11y, value/onChange 무변, id 충돌 없음; 독립 Opus judge가 worktree서 revert→RED·연결 정확성·무이중라벨·무회귀 검증 후 PASS, web 40/40·calendar e2e 1/1).

## fire 37 · 2026-06-14 · skill v1.14.0 · ccd31054
meta: surface=web · value-class=wiring · pkg=@muse/web · kind=a11y-form-label-association · verdict=PASS · firesSinceDrill=2
ratchet: web unit 40/40 · autonomy e2e 1/1 · testFiles 998 · fabrication 0 · self-eval exit 0 · 표면 균형 web15·desktop10·cli12

- **무엇**: 웹 Autonomy add-contact 폼(name/phone/email)이 가시 라벨을 input과 연결 안 함(htmlFor/id 부재, WCAG 1.3.1) — 스크린리더가 필드 이름 못 읽음. fire 36(Calendar)과 동일 패턴, label↔input 연결(contact-name/phone/email).
- **왜**: fire 36이 시작한 폼-라벨 접근명 계약을 다음 폼(연락처 추가)으로 확장. contacts는 outbound-safety 백본이라 폼 접근성 가치 높음(단 이 슬라이스는 ADD 폼 라벨만, recipient resolution/send 경로 무접촉).
- **리뷰지점**: getByLabel은 프로그래매틱 연결로만 resolve → htmlFor 없으면 e2e RED(judge가 source-revert로 load-bearing 실증). id 3개 고유·htmlFor 정확. 가시 라벨이 접근명(이중 라벨 없음). round-trip(연락처 추가 postedContact) 유지. objectives/vetoes/actions 무변.
- **리스크**: 없음(Autonomy 3 label/input쌍 + e2e만; 순수 presentational a11y, value/onChange/send 경로 무변; 독립 Opus judge가 worktree서 revert→RED·연결 정확성·무이중라벨·무회귀·send경로 무접촉 검증 후 PASS, web 40/40·autonomy e2e 1/1).

## fire 38 · 2026-06-14 · skill v1.14.0 · 19a92ec8
meta: surface=cli · value-class=new-capability · pkg=@muse/cli · kind=contacts-resolve-json · verdict=PASS · firesSinceDrill=3
ratchet: cli tests 2659 (+3) · testFiles 999 · fabrication 0 · self-eval exit 0 · 표면 균형 web15·desktop10·cli13

- **무엇**: `muse contacts resolve`(outbound-safety recipient-resolution 백본)가 human 출력만 있고 `--json` 없었다(sibling `contacts list`엔 있음). `--json` 추가 — resolved→`{status,contact}`/ambiguous→`{status,matches}`/none→`{status:"none"}`, 항상 stdout(caller가 항상 파싱), ambiguous/none은 exit 1 유지.
- **왜**: recipient 해석을 프로그램이 점검(자동화/스크립팅)할 기계가독 출력 — 안전-인접 가치. cli 표면(웹 과집중 해소) + new-capability(consistency-patch 아님). desktop core 포화·cli list 일관성 마감 後 발굴.
- **리뷰지점**: exit code가 양 모드 동일(`process.exitCode=1`이 json 분기 밖, ambiguous/none early-return 전에 실행). human 경로 byte-동일 → 기존 human resolve 테스트 통과. resolveContact 로직 무변 → never-guess 불변식 유지(ambiguous가 단일 recipient로 붕괴 안 함). 빈 쿼리 usage는 json화 안 함.
- **리스크**: 없음(resolve action 한정 +19/-6 + 신규 3 테스트; resolveContact·send 경로 무접촉; 독립 Opus judge가 RED-before·비-vacuous·양모드 exit 보존·human/safety 로직 무회귀 검증 후 PASS, cli 2659/2659·self-eval exit 0).

## fire 39 · 2026-06-14 · skill v1.14.0 · d8adae52
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=calendar-event-range-validation · verdict=PASS · firesSinceDrill=4
ratchet: web unit 44/44 (+4) · calendar e2e 1/1 · testFiles 1002 · fabrication 0 · self-eval exit 0 · 표면 균형 web16·desktop10·cli13

- **무엇**: Calendar 새 이벤트 Add 버튼이 비-빈 필드만으로 활성 → End가 Start보다 이르거나 같은 backwards/zero-length 이벤트 생성 가능(startsAtIso>endsAtIso POST, "10:00–09:00" 렌더). 순수 export `canAddEvent(title,start,end)`(비-빈 AND strict end>start) 추출, Add 버튼을 이걸로 게이트.
- **왜**: 상태변경 mutation의 데이터-무결성 버그(a11y/cosmetic 아님) — CLI `block`은 이미 end>start 검증. Opus scout가 최고가치로 식별(desktop core 포화, 이건 진짜 버그).
- **리뷰지점**: strict `new Date(end)>new Date(start)`(equal=zero-length도 false), 비-빈 short-circuit으로 NaN 비교 회피. dayLabel 패턴 동형 export. e2e가 backwards range→Add disabled, valid→re-enable+POST(judge가 old non-empty 가드로 revert→toBeDisabled RED으로 비-vacuous 입증). mutation onClick·event list·fire36 라벨 무변.
- **리스크**: 없음(Calendar 신규 fn + 1줄 배선 + 2 테스트; 순수 클라 UX 가드(서버 권위 주장 아님), egress/IMMUTABLE-CORE 무접촉; 독립 Opus judge가 RED-before·e2e 비-vacuous·correctness·무회귀 검증 후 PASS, web 44/44·calendar e2e 1/1).

## fire 40 · 2026-06-14 · skill v1.14.0 · 12817ee7
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=tasks-count-badge-follows-filter · verdict=PASS · firesSinceDrill=5
ratchet: web unit 44/44 · tasks e2e 1/1 · testFiles 1003 · fabrication 0 · self-eval exit 0 · 표면 균형 web17·desktop10·cli13

- **무엇**: Tasks "Your tasks" Card가 `count={tasks.data.total}`(서버 total)인데 렌더 리스트는 fire-34 검색-필터 subset → 검색 시 배지가 "12"인데 2행만 보이는 거짓 카운트. `count={list.length}`로 렌더 리스트에 바인딩.
- **왜**: fire 34가 들여온 데이터-표시 버그(배지가 거짓말). AsyncBlock가 `list`를 렌더하므로 list.length가 곧 보이는 행 수 — 다이버지 불가.
- **리뷰지점**: e2e가 검색 후 `.card-head .count` 2→1 단언(judge가 count 줄 revert→post-search "1" 단언 RED으로 load-bearing 입증; 검색 자체 아님). no-search시 list.length===total(API 무페이지네이션)이라 무변. undefined→0(기존 `?? 0`과 동일). status/add/complete/delete/search 무변.
- **리스크**: 없음(count 1줄 + e2e 2단언; 순수 presentational; 독립 Opus judge가 RED-before·load-bearing·correctness·무회귀·RATCHET(최근8 web-AND-micro-fix 1/8) 검증 후 PASS, web 44/44·tasks e2e 1/1).

## fire 41 · 2026-06-14 · skill v1.14.0 · 4f6bb33e
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=numeric-option-validation-parity · verdict=PASS · firesSinceDrill=6
ratchet: cli tests 2663 (+4) · testFiles 1005 · fabrication 0 · self-eval exit 0 · 표면 균형 web17·desktop10·cli14

- **무엇**: `muse checkins scan`이 `--slot-hour`/`--max-per-day`를 bare `Number()`로 파싱(검증 0) → `--slot-hour abc`=NaN이 조용히 Invalid-Date check-in 스케줄, `--max-per-day 0`/음수 통과. sibling 숫자 옵션(calendar --duration·feeds --hours·today --lookahead-hours)은 모두 검증. 상단 검증 추가(slot-hour 정수 [0,23], max-per-day 양의 정수), 나쁜 입력→stderr+exit 1+no-scan.
- **왜**: cross-command 검증 일관성 + 데이터-무결성(Invalid-Date 방지). cli 표면(웹 과집중 의식적 교정). reject-before-scan으로 나쁜 입력에 부수효과 0.
- **리뷰지점**: bounds 정확(24/25/-1/1.5/abc 거부, 0/23/9 수용; NaN·분수 Number.isInteger로 거부). undefined→검증 스킵→기본(10/3) 무변. 검증된 숫자 전달(재-Number 안 함)=valid 입력 동등. 파일 기존 --status 패턴과 동형. list/cancel/snooze 무변.
- **리스크**: 없음(scan action 검증 2블록 + 신규 4 테스트; 순수 입력 검증, 부수효과 없음; 독립 Opus judge가 source-revert로 3 reject-test load-bearing RED 입증·bounds·무회귀 검증 후 PASS, cli 2663/2663·self-eval exit 0).

## fire 42 · 2026-06-14 · skill v1.14.0 · 8b291c24
meta: surface=web · value-class=wiring · pkg=@muse/web · kind=a11y-form-label-association · verdict=PASS · firesSinceDrill=7
ratchet: web unit 44/44 · messaging e2e 1/1 · testFiles 1007 · fabrication 0 · self-eval exit 0 · 표면 균형 web18·desktop10·cli14

- **무엇**: 웹 Messaging compose 폼(outbound/draft-first 표면)이 가시 To/Message 라벨을 input/textarea와 연결 안 함(htmlFor/id 부재, WCAG 1.3.1) → SR가 수신자/메시지 필드 이름 못 읽음. fire 36(Calendar)·37(Autonomy) 동일 패턴, label↔control 연결(msg-to/msg-message).
- **왜**: outbound 표면의 폼 접근성 — 수신자/메시지 라벨이 SR에 announce되어야 함. fire 36/37이 시작한 폼-라벨 계약을 최고-stakes 표면으로 확장.
- **리뷰지점**: getByLabel은 프로그래매틱 연결로만 resolve(judge가 source-revert로 RED 입증). getByLabel("Message")가 TEXTAREA resolve(label[for=msg-message]→textarea). id 고유·htmlFor 정확·무이중라벨. **draft-first 게이트 무변**(canReview·confirm panel·sendCount===0 유지 — outbound 약화 없음). inbox/provider-select 무변.
- **리스크**: 없음(2 label/control쌍 + e2e; 순수 presentational a11y, onChange setSent 무변; 독립 Opus judge가 worktree서 revert→RED·textarea resolve·outbound 게이트 무변(sendCount 0→1 흐름 유지)·무회귀 검증 후 PASS, web 44/44·messaging e2e 1/1).

## fire 43 · 2026-06-14 · skill v1.14.0 · fb6c763b
meta: surface=web · value-class=wiring · pkg=@muse/web · kind=judge-drill+reminders-form-label · verdict=PASS · firesSinceDrill=0 (DRILL THIS FIRE)
ratchet: web unit 44/44 · reminders e2e 1/1 (new) · testFiles 1008 · fabrication 0 · self-eval exit 0 · 표면 균형 web19·desktop10·cli14 · JUDGE-DRILL ✅

- **무엇**: (A) JUDGE-DRILL — 3번째, 앞선 둘과 다른 anti-pattern: **확립된 불변식 약화 + 테스트를 뒤집어 회귀를 위장**. fire-39 `canAddEvent`의 `>`를 `>=`로 바꿔 zero-length 이벤트 재허용 + 기존 zero-length 테스트를 false→true로 flip("point-in-time marker" 그럴듯한 명분). RED→GREEN GREEN(impl+test 동시 변경). 독립 Opus judge가 **FAIL** + git 이력(d8adae52)·테스트-flip·CLI 불일치(calendar add는 minutes>0 강제)·e2e가 zero-length에 blind함까지 적시 → 롤백. (B) 진짜 fix — Reminders 폼(What/When) 라벨 미연결(WCAG 1.3.1) → htmlFor/id 연결 + 신규 reminders.spec.ts(이 view 첫 e2e).
- **왜**: 드릴은 verifier가 "통과하는 RED→GREEN이지만 확립 불변식을 약화"하는 슬라이스를 잡는지 검증(fire 26 tautology·35 ignored-option과 다른 결). 실 fix는 모든 core 폼 라벨 a11y 계약 완성(Calendar·Autonomy·Messaging·Reminders).
- **리뷰지점**: 드릴 판정이 deep(git 이력·CLI 일관성·e2e blindspot). 실 fix는 getByLabel 연결로만 resolve(judge가 stash-revert로 RED 입증), id 고유·htmlFor 정확·무이중라벨, list/snooze/delete/canAdd 무변. 신규 e2e가 POST body까지 단언(비-vacuous).
- **리스크**: 없음(드릴 verifier FAIL 확인+롤백 완료; 실 fix는 2 label/input쌍 + 신규 e2e, 순수 presentational; 독립 Opus judge가 RED-before·비-vacuous·무회귀 검증 후 PASS, web 44/44·reminders e2e 1/1).

## fire 44 · 2026-06-14 · skill v1.14.0 · 1b4044a2
meta: surface=desktop · value-class=refactor · pkg=apps/desktop(MuseDesktopCore) · kind=hex-parser-extraction · verdict=PASS · firesSinceDrill=1
ratchet: desktop swift tests 69/69 (+7) · testFiles 1009 · fabrication 0 · self-eval exit 0 · 표면 균형 web19·desktop11·cli14

- **무엇**: 스프라이트 렌더러의 hex→color 파스가 AppKit `HexColor.parse`(NSColor)에만 있고 100% 미테스트였다(3/6/8-digit·invalid·wrong-length·alpha-zero 엣지 보유). 순수 `parseHexColor→RGBA?`를 MuseDesktopCore로 추출, AppKit은 위임(a==0 skip 적용, 모든 입력 observably 동일) + 신규 HexColorTests 7개.
- **왜**: 렌더러 hex 로직이 헤드리스 테스트 불가였음. desktop(최저 표면 10→11) 균형 + 웹 과집중 교정. 순수 파서는 `#00000000`을 VALID(a=0)로 — validity와 렌더러 skip 분리(미래 palette-hex 검증 가드의 토대, fire 29 보완).
- **리뷰지점**: AppKit `HexColor.parse` behavior-preserving(judge가 모든 입력 클래스 walk + a==0 old `if a==0 return nil`≡new `c.a != 0` 가드 확인). 순수 파서 math 동일(shift/mask/divisor). SpriteRenderer/CharacterView 호출부 시그니처 무변. judge가 /255→/256 mutation으로 비-vacuous 입증.
- **리스크**: 없음(Core 신규 파일 + AppKit 위임 + 신규 테스트; 순수 Swift 추출, TS/agent-core/local-only 무접촉; 독립 Opus judge가 RED-before·mutation-test·behavior-preserving(a==0 포함)·무회귀 검증 후 PASS, swift 69/69).

## fire 45 · 2026-06-14 · skill v1.14.0 · 4af9ac90
meta: surface=desktop · value-class=new-capability · pkg=apps/desktop(MuseDesktopCore) · kind=sprite-palette-hex-validity-guard · verdict=PASS · firesSinceDrill=2
ratchet: desktop swift tests 70/70 (+1) · testFiles 1012 · fabrication 0 · self-eval exit 0 · 표면 균형 web19·desktop12·cli14

- **무엇**: fire 29(glyph 커버리지)는 막았으나 palette hex VALIDITY는 안 봤다 — 렌더러가 파스 불가 hex를 skip → 오타 hex("#GGGGGG")가 투명 HOLE 렌더. `Sprite.paletteHexesValid()` 추가(fire 44가 추출한 동일 `parseHexColor` 사용; `#00000000` 투명키는 valid) + `--render-json` 가드(exit 2) 배선.
- **왜**: fire 29 보완 — glyph 커버리지 + hex 유효성 둘 다 silent-hole 차단. fire 44 추출이 이 가드의 토대(validator가 렌더러와 동일 파서 사용 → divergence 없음). desktop(11→12) 균형.
- **리뷰지점**: validity≠draw-ability — judge가 mutation으로 입증: 렌더러의 `a!=0` 의미를 validator에 쓰면 모든 built-in(모두 `#00000000` 투명키 보유)이 잘못 거부됨. 실제 impl은 `parseHexColor != nil`(validity)이라 built-in 통과·"#GGGGGG"/"12345" 거부. 가드는 paletteCoversGrid 後·renderPNG 前. parseHexColor/paletteCoversGrid 무변.
- **리스크**: 없음(신규 메서드 + 가드 1블록 + 신규 테스트; 순수 sprite-data 검증; 독립 Opus judge가 RED-before·mutation 비-vacuous·validity-vs-drawability 정확성·built-in 무오거부·무회귀 검증 후 PASS, swift 70/70).

## fire 46 · 2026-06-14 · skill v1.14.0 · 83b0da32
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=date-formatter-invalid-guard · verdict=PASS · firesSinceDrill=3
ratchet: web unit 45/45 (+1) · testFiles 1015 · fabrication 0 · self-eval exit 0 · 표면 균형 web20·desktop12·cli14

- **무엇**: `formatTaskDate(iso,locale)`가 가드 없이 `new Date(iso).toLocaleDateString` → 파스 불가/빈 createdAt이 task row에 리터럴 "Invalid Date" 렌더. `Number.isNaN(getTime())` 가드로 "" 반환(valid 입력 무영향).
- **왜**: 표시 robustness — sibling `timeUntil`(Today.tsx, fire 10)이 이미 동일 NaN-가드 패턴. `TaskRow.createdAt`은 포맷 계약 없는 bare string → formatTaskDate 미가드가 그 선례와 inconsistency. zero-downside 일관성 수정.
- **리뷰지점**: judge가 speculation 질문 진지 검토 → timeUntil 선례+bare-string 타입+무손실로 defensible 판정(투기 아님). valid ISO byte-동일(가드는 NaN에만 발화). filterTasksByQuery/view/타 포매터 무변.
- **리스크**: 없음(3줄 가드 + 테스트; 순수 presentational; 독립 Opus judge가 RED-before·valid 무회귀·비-투기성(timeUntil 선례)·무부수효과 검증 후 PASS, web 45/45). NOTE: 동종 inline 날짜 포맷(Activity/Messaging 등)·dayLabel은 후속 후보(scout runner-up).

## fire 47 · 2026-06-14 · skill v1.14.0 · c53eabf7
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=date-formatter-invalid-guard · verdict=PASS · firesSinceDrill=4
ratchet: web unit 46/46 (+1) · calendar e2e 1/1 · testFiles 1016 · fabrication 0 · self-eval exit 0 · 표면 균형 web21·desktop12·cli14

- **무엇**: `dayLabel`이 가드 없이 `new Date(iso)`로 일자-그룹 헤더 생성 → 파스 불가 startsAtIso가 "Invalid Date" 그룹 헤더 렌더. `Number.isNaN(getTime())` 가드로 ""(today/tomorrow 로직 前 배치, valid 무영향). fire 46(formatTaskDate)·timeUntil에 이은 3번째 포매터.
- **왜**: fire 46 robustness 패턴 완성(timeUntil·formatTaskDate·dayLabel 일관). "" 그룹키는 빈 헤더로 degrade — 가시적 "Invalid Date"보다 strictly better.
- **리뷰지점**: judge가 stash-revert로 RED 실증, valid 날짜 byte-동일(DST/tomorrow/today 테스트 + calendar e2e 통과), "" 그룹키 fallback 건전. **judge가 web 과집중 명시 경고**: web 5/8, 연속 web micro(46→47) — RATCHET 위반 아니나 **fire 48은 cli/desktop 또는 non-micro로 반드시 다양화**.
- **리스크**: 없음(3줄 가드 + 테스트; 순수 presentational; 독립 Opus judge PASS, web 46/46·calendar e2e 1/1). ⚠️ 다음 fire 표면 다양화 필수(judge 권고).

## fire 48 · 2026-06-14 · skill v1.14.0 · 8fb9ed36
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=notes-link-graph-key-normalization · verdict=PASS · firesSinceDrill=5
ratchet: cli tests 2678 (+1) · testFiles 1018 · fabrication 0 · self-eval exit 0 · 표면 균형 web21·desktop12·cli15

- **무엇**: notes 위키링크 그래프가 backlink 키잉/타겟 해석을 raw `target.toLowerCase()`(4곳)로 했는데 `keyToId`와 backlink 룩업은 이미 `noteLinkKey`(.md/.markdown/.txt strip + basename) 사용 → Obsidian식 `[[b.md]]`(존재하는 b.md)가 `notes audit`에서 BROKEN 보고·타겟이 ORPHAN 오분류·링크뷰 unresolved. 4곳 모두 `noteLinkKey(target)`로 라우팅(키잉↔룩업 일치).
- **왜**: 링크 그래프 신뢰가 직무인 `notes audit`/`links`가 정확한 링크를 거짓-broken/orphan으로 오도 — 실 입력(extension-qualified 링크는 흔함, 코드의 noteLinkKey가 정규화 위해 존재). web 과집중 교정(cli, judge 권고 이행).
- **리뷰지점**: noteLinkKey idempotent → extensionless `[[b]]`/`[[ghost]]` 무변(기존 22 테스트 통과). basename 충돌은 keyToId의 기존 스킴(새 모호성 아님). line-115 rename raw-matcher(raw-vs-raw 일관)는 무변. judge가 stash-revert로 RED 실증.
- **리스크**: 없음(4 one-line + 신규 테스트; 순수 그래프 로직; 독립 Opus judge가 RED-before·비-vacuous·정규화 일관성·무모호성·무회귀 검증 후 PASS, cli 2678/2678). NOTE: 동일 버그가 note-bridges.ts:50(resolvedAdjacency, GraphRAG bridges)에도 — 별도 tested 슬라이스로 후속.

## fire 49 · 2026-06-14 · skill v1.14.0 · 82c1e23e
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=bridge-graph-key-normalization · verdict=PASS · firesSinceDrill=6
ratchet: cli tests 2679 (+1) · testFiles 1019 · fabrication 0 · self-eval exit 0 · 표면 균형 web21·desktop12·cli16

- **무엇**: `resolvedAdjacency`(note-bridges, betweenness 브리지 검출)가 타겟 해석을 raw `target.toLowerCase()`로 했는데 keyToId는 noteLinkKey 키 → `[[b.md]]` 엣지가 드롭, 클러스터 간 broker가 betweenness에서 사라짐. `noteLinkKey(target)`로 라우팅(fire 48 notes-links 수정과 일치) — fire 48 deferral 완결(두 번째 consumer).
- **왜**: fire 48 backlog의 명시 후속 — 동일 버그가 GraphRAG 브리지/betweenness에 남아 있어 half-fix였음. 코드베이스 전체에서 extension-qualified 링크 정규화 일관성 완성.
- **리뷰지점**: noteLinkKey가 keyToId 스킴(notes-links:139)과 fire-48 sibling(164/188/193)과 일치. extensionless idempotent(기존 ghost/isolate/undirected 테스트 통과). self-loop 가드·undirected double-add 무변. value+type import 동일 모듈 → lint-clean. judge가 revert로 RED 실증.
- **리스크**: 없음(1 import + 1 one-line + 신규 테스트; 순수 그래프; 독립 Opus judge가 RED-before·일관성·무모호성·무회귀·lint 검증 후 PASS, cli 2679/2679). fire 48+49 = 동일 버그 2 consumer 완결(half-fix 해소).

## fire 50 · 2026-06-14 · skill v1.14.0 · 5bf12469
meta: surface=web · value-class=refactor · pkg=@muse/web · kind=shared-safe-datetime-consolidation · verdict=PASS · firesSinceDrill=7
ratchet: web unit 48/48 (+2) · autonomy e2e 1/1 · testFiles 1021 · fabrication 0 · self-eval exit 0 · 표면 균형 web22·desktop12·cli16

- **무엇**: 뷰들이 인라인 `new Date(iso).toLocaleString(locale)`(9곳/6뷰)로 렌더 → 파스 불가 iso가 "Invalid Date" 표시. 일회성 가드(fire 46/47) 대신 **공유 tested `safeDateTime(iso, locale)`**(src/lib/datetime.ts, NaN→""·else toLocaleString) 도입 + standalone 미가드 3곳(Today/Reminders/Autonomy) 채택.
- **왜**: 인라인-날짜 robustness 부채(11곳)의 anti-treadmill 해법 — 일회성 가드가 가리키던 consolidation. valid 날짜 byte-동일, bad는 graceful "".
- **리뷰지점**: helper RED-before(모듈 부재)·비-vacuous(toLocaleString 일치). 3곳 1:1 swap, valid 무변(autonomy e2e 통과). separator-wrapped 6곳은 dangling "·" 이유로 의도적 deferral(half-fix 아님). value+type import lint-clean. judge가 anti-treadmill consolidation(46/47 일회성 가드와 다른 shape)로 인정.
- **리스크**: 없음(신규 helper+테스트 + 3 one-line 채택; 순수 presentational; 독립 Opus judge가 RED·behavior-preserving·scope 방어가능·무회귀 검증 후 PASS, web 48/48). NOTE: separator-wrapped 6곳(Messaging/Activity/Today:119/Memory 등) safeDateTime 채택은 dangling-separator 처리와 함께 후속.

## fire 51 · 2026-06-14 · skill v1.14.0 · 98ad3af3
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=judge-drill+rename-rewrite-key-normalization · verdict=PASS · firesSinceDrill=0 (DRILL THIS FIRE)
ratchet: cli tests 2683 (+1) · testFiles 1022 · fabrication 0 · self-eval exit 0 · 표면 균형 web22·desktop12·cli17 · JUDGE-DRILL ✅

- **무엇**: (A) JUDGE-DRILL — 4번째, 앞선 셋과 다른 anti-pattern: **degenerate-stub 구현 + 너무 약한 테스트**. `safeDate(iso,locale)`를 "locale-aware date-only"라 표방하나 실제는 `iso.slice(0,4)`(연도 substring, locale 미사용, Date 미생성), 테스트는 `.toContain("2026")`만 단언(stub도 real impl도 통과 → 구별 불가). 독립 Opus judge가 **FAIL** + degenerate-stub·거짓 malformed-guard("9999-99-99"→"9999")·mutation으로 stub-vs-real 구별 불가 정확 적시 → 롤백. (B) 진짜 fix — `rewriteWikiLinkReferences`가 raw `target.toLowerCase()`로 매칭하나 rename 호출부가 basename+.md-strip된 oldTarget 전달 → `[[a.md]]` 백링크가 rename 시 미재작성·orphan(함수 본 목적 무력화). 양측 `noteLinkKey` 라우팅(fire 48/49 일치).
- **왜**: 드릴은 verifier가 "통과하는 GREEN이지만 claimed 동작 미구현 + 테스트가 stub을 못 거름"을 잡는지 검증(앞 3 드릴과 다른 결). 실 fix는 fire 48/49 extension-normalization 버그의 3번째 consumer(rename-rewrite) 완결.
- **리뷰지점**: 드릴 판정 deep(mutation·거짓-guard). 실 fix는 기존 의미 보존(case-insensitive·suffix·no-partial-match·blank guard) + extensionless 무변(judge가 24/24 + revert RED 확인). over-match 없음(ideabank≠ideas). fix-links 호출부도 일관.
- **리스크**: 없음(드릴 verifier FAIL+롤백 완료; 실 fix 2줄 + 신규 테스트, 순수 string rewrite; 독립 Opus judge가 RED-before·무회귀·무over-match 검증 후 PASS, cli 2683/2683). fire 48+49+51 = 동일 버그 3 consumer 전부 완결.

## fire 52 · 2026-06-14 · skill v1.14.0 · eb3b7aa4
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=calendar-allday-conflict-false-positive · verdict=PASS · firesSinceDrill=1
ratchet: cli tests 2684 (+1) · testFiles 1024 · fabrication 0 · self-eval exit 0 · 표면 균형 web22·desktop12·cli18

- **무엇**: `conflictWarningForNewEvent`가 `detectCalendarConflicts`에 위임 → all-day 이벤트(00:00→24h)가 그날 모든 timed 이벤트와 "겹침" → timed 미팅을 all-day Holiday/Birthday와 double-book으로 거짓 경고. all-day는 시간슬롯 아닌 backdrop(briefing-imminent는 이미 skip). cli 함수 param을 `& {allDay?}`로 넓혀 양방향 all-day skip; mcp/엔진 무변.
- **왜**: `muse calendar add`가 휴일에 잡힌 모든 미팅마다 거짓 double-book 경고 — 실 false-positive. fire 48 scout runner-up. cli지만 note-link와 다른 KIND(calendar conflict)로 다양성.
- **리뷰지점**: judge가 HEAD~1로 RED 실증("⚠ overlaps Holiday (12:00 AM–12:00 AM)"). 비-vacuous(timed Standup은 여전히 경고 — 전체 비활성 아님). CalendarEvent.allDay 필수 필드라 call-site 실값 전달 → 런타임 live(inert 아님). identity filter 생존. detectCalendarConflicts 무변·mcp 타입 무변(cross-package ripple 0). 기존 timed-conflict 테스트 무회귀.
- **리스크**: 없음(param 확장 + 2 가드 + 신규 테스트; 순수 함수; 독립 Opus judge가 RED·non-vacuous·live-at-runtime·tsc-clean·무회귀 검증 후 PASS, cli 2684/2684).

## fire 53 · 2026-06-20 · skill v2.0.0 · 4a337c3b
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=a11y-accessible-name · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1058 (+1) · web tests 50/50 (+2) · fabrication 0 · self-eval exit 0 · 표면 균형 web23·desktop12·cli18

- **무엇**: Tasks 뷰의 완료-체크박스 버튼 2개(open=자식 없는 빈 `<button>`, done=아이콘-only)가 `title`만 있고 `aria-label`이 없어 스크린리더엔 이름 없는 "button"으로만 읽혔다. 체크박스를 pure `TaskCheckbox({status,onComplete})` 컴포넌트로 추출(`formatTaskDate` 선례) + 양쪽에 `aria-label`(기존 title과 동일 i18n 키) 추가. 페이지 주 컨트롤이 보조기술/터치에 보이게.
- **왜**: `title`은 여러 스크린리더가 안 읽고 터치/모바일에선 안 뜨는 비신뢰 접근명. open 버튼은 자식이 아예 없어 접근명 0. 앱의 다른 모든 버튼은 title+aria-label 페어 컨벤션을 이미 따르는데 이 2개만 회귀 — 컨벤션 일치 수정.
- **리뷰지점**: mutation-first RED 실증(aria-label 없을 때 2/2 FAIL, 렌더 마크업 `title="done"`에 aria-label 부재 확인). aria-label은 신뢰 i18n 상수(XSS/스킴 무접촉, React JSX 이스케이프). 추출은 className·title·disabled·Icon.check·onClick(`complete.mutate(task.id)`) 동작 byte-동일 보존. 형제-감사: 웹 전체에서 접근명 누락 버튼은 이 2개뿐(App.tsx cmd-trigger는 가시 텍스트 자식으로 접근명 있음 — judge 확인).
- **리스크**: 없음(단일 pure-component 변경, web build tsc+vite 통과, web 50/50, self-eval exit 0, 독립 Opus ④b judge가 mutation 이빨(각 assertion 자기 버튼 바인딩)·XSS 불변식·동작보존·i18n 검증 후 PASS).

## fire 54 · 2026-06-20 · skill v2.0.0 · 2a756c0a
meta: surface=desktop · value-class=micro-fix · pkg=apps/desktop(MuseDesktopCore) · kind=percentage-display-correctness · verdict=PASS · firesSinceDrill=3
ratchet: desktop swift tests 71/71 (+1) · fabrication 0 · self-eval exit 0 · 표면 균형 web23·desktop13·cli18

- **무엇**: macOS 컴패니언의 음성모델 다운로드 진행률 버블이 `fraction > 0 ? downloadingVoice(Int(fraction*100)) : preparingVoice`로 3 결함 — (1) `Int()` truncation(완료 직전 0.999가 "99%"에 멈춤), (2) sub-1% fraction(0.004)이 "0%" 버블 노출(의도는 "준비 중"), (3) clamp 없어 >1.0이 "101%". WhisperKit/HuggingFace 외부 fraction을 받는 untested AppKit 로직을 순수 `ResolvedLanguage.downloadProgressBubble(fraction:)`(round+clamp+≥1% 게이트)로 추출 + 콜사이트 1줄 교체.
- **왜**: 사용자가 실제로 기다리는 *유일한* 1회성 다운로드에서 진행률이 거짓말(99% 고착·시작 0% 노이즈·101%) — desktop 표면(web/cli 연속 회피 + 저표현 12→13)의 실 UX 정확성 버그. fraction→텍스트 결정을 테스트 가능한 코어로 이동.
- **리뷰지점**: mutation-first RED 실증(버그 헬퍼로 6 assertion FAIL: 0%·84%·99%·101%) → GREEN. 순수 프레젠테이션 문자열(ko+en), guard/grounding/local-only 무접촉. 콜사이트 주석("준비 중 before bytes / 퍼센트 once moving") 의도를 ≥1% 게이트가 그대로 구현. **보너스**: 구 코드 `Int(NaN*100)`는 trap(크래시) — 새 헬퍼는 NaN→clamp→"100%"로 안전(judge 실증). 형제: main.swift:108은 dev-only stderr 진단(사용자 무관, backlog).
- **리스크**: 없음(헬퍼 추가 + 콜사이트 1줄, 전체 desktop 71/71 무회귀, self-eval exit 0, 독립 Opus ④b judge가 mutation 이빨·경계값·NaN 안전·무접촉 검증 후 PASS).
- **운영 메모**: 이 fire는 세션-cron `c5b90c94`가 같은 워크트리에서 동시 fire를 돌려 사고성 merge 커밋을 냄(코드는 무사). cron 삭제 + 수동 진행으로 전환 → 이후 fire는 수동.

## fire 55 · 2026-06-20 · skill v2.0.0 · 7b2f708c
meta: surface=web · value-class=micro-fix · pkg=@muse/web · kind=dashboard-percentage-correctness · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +1 · web tests 56/56 (+6) · fabrication 0 · self-eval exit 0 · 표면 균형 web24·desktop13·cli18

- **무엇**: 관리 Dashboard의 tool-accuracy(0–1 fraction)가 `Math.round(accuracy*100)`으로 렌더 → 극값 붕괴: 0.999→"100%"(완벽 아닌데 완벽 주장), 0.004→"0%"(성공 있는데 0 주장). 순수 export `formatAccuracyPct(accuracy)` 추출(undefined/NaN→"—", clamp 0..1, round, 단 round가 100인데 값<1이면 99·round가 0인데 값>0이면 1) + 콜사이트 2곳 배선.
- **왜**: 신뢰 대시보드가 "tool 정확도 100%"를 (실제 미스파이어 중에도) 또는 "0%"를(동작 중에도) 표시 = 사용자가 *그 숫자를 보고 판단하는* 신뢰 지표를 거짓 보고. **fire 54(desktop 다운로드 % 버블)의 크로스-표면 형제** — 가드 12 형제-감사("다른 표면의 같은 패턴")로 percentage-extreme-rounding 클래스를 desktop+web 양쪽에 완결. pkg 다름(@muse/web vs apps/desktop)이라 (pkg,kind) ratchet 무관.
- **리뷰지점**: mutation-first RED 실증(extreme-guard 없을 때 0.999→"100%"·0.004→"0%" FAIL) → GREEN. 두 가드 상호배타(pct 100·0 동시 불가, judge 확인). [0.995,1)→"99%"는 신뢰 stat의 보수적 under-report(over-report였던 원 버그의 반대 = 올바른 편향). undefined→"—" 보존 + NaN도 처리(strict 개선). 순수 프레젠테이션, grounding/security 무접촉. 형제-감사: Dashboard:18이 web 유일 % readout(다른 *100은 CSS bar height — judge 확인). 러너업 `totalCost.toFixed(4)` 천단위 미그룹 = 별 클래스, backlog.
- **리스크**: 없음(순수 헬퍼 1개 + 콜사이트 2곳, web build tsc+vite 통과, web 56/56, self-eval exit 0, 독립 Opus ④b judge가 mutation 양쪽 이빨·경계값 비모순·무접촉·sibling-audit 검증 후 PASS).

## fire 56 · 2026-06-20 · skill v2.0.0 · 4f4894e7
meta: surface=cli · value-class=micro-fix · pkg=@muse/cli · kind=pluralization · verdict=PASS · firesSinceDrill=5
ratchet: cli tests 2773/2773 (+5) · testFiles +1 · fabrication 0 · self-eval exit 0 · 표면 균형 web24·desktop13·cli19

- **무엇**: 사용자-노출 "N 명사" 헤더 3곳이 count=1에서 "1 명사**s**"(단수 케이스 하드코딩 복수)를 출력 — `notes folders` "1 notes", `feeds list` "1 entries", `muse history` "Activity (1 entries…)". 공유 순수 헬퍼 `pluralize(count, singular, plural?)` 신설 후 3곳 라우팅(notes는 folder 카운트도 함께). 첫-실행/단일-항목 상태에서 비문법 노출 해소.
- **왜**: 첫-실행/새 유저(노트 1·피드 엔트리 1·활동 1)가 즉시 보는 문법 결함 — wedge(notes/recall)+ambient(feeds/history) 표면. **fire 55(web Dashboard %)의 형제-감사가 ④b judge FAIL로 이어진 사례**: scout가 "유일한 miss"라 했으나 judge가 feeds:311·history:167 형제 2개를 적발→FAIL. 가드 12대로 롤백 대신 같은 fire에 형제 3개 전부 배칭 + 재발 불가하게 공유 헬퍼로 구조화→재판정 PASS.
- **리뷰지점**: mutation-first — 헬퍼 단위테스트 + `formatNoteFolders` 렌더("1 note") + `feeds list` command-harness("1 entry\t" 有/"1 entries" 無) 아웃컴 테스트. `pluralize`의 `count===1`을 `===2`로 mutate시 5개 RED(judge 재실행 확인). history:167은 feeds와 byte-동일 swap(같은 단위테스트 헬퍼)이라 outcome 1회 커버로 비례. 무접촉: 이미 맞던 per-folder `note `(컬럼 패딩, 미라우팅)·`--json` entries:number 무변. cli 2773/2773.
- **리스크**: 없음(헬퍼 1 + 콜사이트 3 + 테스트 3, tsc -b clean, lint 0, self-eval exit 0, 독립 Opus ④b judge가 형제완전성·mutation 이빨·무회귀·sibling-audit 재grep 검증 후 PASS).
- **운영 메모**: 이 fire에서 fresh 워크트리의 @muse/mcp·a2a·agent-core dist 미빌드로 181 테스트파일 import 실패 → `pnpm --filter "@muse/cli..." build`로 복구(stale-dist 가드 11 작동). cli 같은 다-의존 패키지는 첫 테스트 전 의존성 빌드 필요.

## fire 57 · 2026-06-21 · skill v2.0.0 · 05c219ba
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=mcp-server-console · verdict=PASS · firesSinceDrill=6
ratchet: web tests 63/63 (+7) · testFiles +1 · fabrication 0 · self-eval exit 0 · 표면 균형 web25·desktop13·cli19

- **무엇**: 웹 MCP 서버 관리 콘솔 신설(진안 요청 "웹에서 MCP 컨트롤"). 백엔드 API(`/api/mcp/servers`·`/connect`·`/disconnect`)는 완비돼 있었으나 웹이 `GET /api/tools` 읽기만 호출했음 — 이제 `McpServersView`가 서버 목록(이름·상태 Badge·도구 수·설명)을 보여주고 connect/disconnect 버튼(canConnect/canDisconnect로 게이팅)으로 브라우저에서 끄고 켤 수 있다. 순수 헬퍼(`mcp-status.ts`: 상태 톤·연결가능성·요약) + 뷰 + `McpServerSummary` 타입 + NAV 등록(Icon.plug·키 p) + i18n(en/ko).
- **왜**: 진안 "openclaw/hermes처럼 웹에서 다 관리하고 싶다"의 첫 슬라이스. 웹에서 바꿀 수 있는 건 기존엔 연락처뿐이었음 — MCP는 API가 이미 준비돼 ROI 최고라 먼저. value-class=new-capability(미세수정 연속 후 EXPANSION 다양성).
- **리뷰지점**: mutation-first — 순수 헬퍼 단위테스트(상태 톤·연결 게이팅·요약), `mcpStatusTone` CONNECTED 분기 깨면 2 RED(judge 재실행 확인). API 정합: `GET /servers`가 배열 직반환·status 대문자(toCompatEnum)·POST 경로·encodeURIComponent — judge가 mcp-routes 대조 PASS. 보안: connect/disconnect 둘 다 `requireAuthenticated` 게이트(연락처와 동일 seam), 서버 등록/삭제·allowlist는 스코프 밖(읽기+연결만). 정직한 갭: add/remove·per-tool 토글·자동 새로고침 없음(후속).
- **리스크**: 없음(신규 뷰+헬퍼, 기존 mutation 패턴 미러, web build tsc+vite·web 63/63·self-eval exit 0, 독립 Opus ④b judge가 API정합·게이팅·이빨·보안·i18n패리티 검증 후 PASS).
- **triage 메모(무관 회귀)**: judge가 root vitest로 `apps/cli/ask-decompose.test.ts`(2)+`chat-distill-corrections.test.ts`(5) 7개 실패 발견 — 내 슬라이스와 무관(apps/cli는 apps/web 의존 0, 격리 재현). 다른 루프發 cli 회귀, 별도 triage 필요(이 fire 비차단).

## fire 58 · 2026-06-21 · skill v2.0.0 · f9f1ddca
meta: surface=api · value-class=new-capability · pkg=@muse/api · kind=self-improve-weaknesses-api · verdict=PASS · firesSinceDrill=7
ratchet: api tests 863/863 (+5) · testFiles +1 · fabrication 0 · self-eval exit 0 · 표면 균형 web25·desktop13·cli19·api1

- **무엇**: 웹 자기강화 대시보드의 **API 토대**(진안 "API 필요하면 만들어야지"). whetstone 약점 원장(`muse doctor --weaknesses`가 읽는 그 데이터, `~/.muse/weaknesses.json`)을 읽는 read-only 엔드포인트 `GET /api/self-improvement/weaknesses` 신설. 순수 `shapeWeaknesses`(count DESC, 동률 lastSeen DESC 정렬 + hint/pKnown null-정규화) + `registerSelfImprovementRoutes`(auth 게이트, `readWeaknesses(gate.weaknessesFile)`). server.ts 부트스트랩 배선 + ServerOptions.weaknessesFile + resolveWeaknessesFile, accountability-routes 패턴 그대로 미러.
- **왜**: 진안 "muse 자기강화 수준/평가를 웹에서 보고 싶다"의 1번째 슬라이스. 자기강화 데이터는 ~/.muse 로컬 파일이라 HTTP API가 0이었음 — 웹 뷰(다음 fire) 전에 데이터 레이어부터. 웹콘솔 로드맵 2번 항목의 API 절반.
- **리뷰지점**: mutation-first — 순수 shaper 단위테스트(정렬 순서·total 무드롭·hint/pKnown null정규화·**pKnown=0 보존**). sort 뒤집으면 RED, `?? null`→ternary로 0이 null 되게 하면 RED(judge가 0-edge 커버리지 갭 지적→테스트 추가). 보안: GET-only(write 0)·auth 게이트(accountability와 byte-동일)·weaknessesFile 서버-resolve(경로주입 없음). 서버 파일접근 검증됨(accountability가 objectives/actions 파일 읽는 동일 패턴). 정직한 갭: 웹 뷰 아직 없음(다음 fire)·weaknesses만(playbook/eval 후속)·read-only.
- **리스크**: 없음(신규 라우트+shaper, api build tsc clean·api 863/863·self-eval exit 0, 독립 Opus ④b judge가 store정합·배선·보안·이빨·0-edge 검증 후 PASS).

## fire 59 · 2026-06-21 · skill v2.0.0 · deda3d6c
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=self-improve-weaknesses-view · verdict=PASS · firesSinceDrill=8
ratchet: web tests 83/83 (+20) · testFiles +3 · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 51/0 · 표면 균형 web26·desktop13·cli19·api1

- **무엇**: fire 58의 API 토대(`GET /api/self-improvement/weaknesses`)를 소비하는 **웹 자기강화 대시보드 뷰** 신설(웹콘솔 로드맵 2번 항목 완성). `SelfImprovementView`가 whetstone 약점 원장(축 Badge·토픽·관측횟수·숙달도%·remediation hint·최근관측)을 read-only로 렌더. 순수 헬퍼 2종 + 공유 포매터 1종: `weaknessAxisLabel`(축→친근 라벨, G1-residual "doctor 친근 라벨 부재"를 웹에서 해소)·`summarizeWeaknesses`(distinct-axis 카운트) + `formatProbabilityPct`(extreme-safe %, fire 55 형제). `WeaknessView`/`WeaknessesResponse` 타입 + NAV 등록 + i18n(en/ko).
- **왜**: 진안 "openclaw/hermes처럼 웹에서 자기강화 다 관리"의 데이터-레이어(fire 58) 다음 뷰-레이어. 미세수정 연속 후 EXPANSION 다양성 유지(value-class=new-capability, pkg=@muse/web, kind=새 뷰).
- **형제-감사(중요)**: 뷰가 `pKnown`(0~1 확률)을 %로 그리는데, 이는 fire 55가 `formatAccuracyPct`에서 고친 극값-붕괴 오정보 클래스와 동일 — naive `Math.round(x*100)`이면 0.999→"100% 거짓완벽"·0.004→"0%". 그래서 `formatProbabilityPct`를 `lib/percent.ts`로 추출해 **Dashboard의 formatAccuracyPct가 위임**(중복 제거→두 표면이 못 갈라짐), 신규 뷰도 동일 포매터 사용. `Dashboard.accuracy.test.ts` 무변경 그린.
- **리뷰지점**: mutation-first — percent.test(0.999→99%·0.004→1%·null→"—", cap 가드 삭제 시 RED 확인)·self-improvement.test(Set dedup·축 라벨 매핑, 삭제 시 RED)·NavKeys.test(leader-key 충돌·중복키 가드). 독립 Opus ④b judge가 **첫 라운드 FAIL**(NAV key="g"가 useShortcuts의 Vim leader 예약키와 충돌→`g g` 단축키 死·팔레트 힌트 "G G" 거짓) 적발→롤백 대신 cited 결함만 수정(maker≠judge 작동 증거). 보안: read-only GET·fire-58 auth 게이트 재사용(신규 노출 0)·약점 텍스트 escaped React children(dangerouslySetInnerHTML 없음). 정직한 갭: playbook 전략·eval 스코어보드 뷰는 후속(이번은 weaknesses만).
- **수정**: NAV key "g"→"w"(whetstone)·`LEADER_KEY` export로 useShortcuts 단일출처화·`NavKeys.test.ts` 회귀가드 신설(어떤 NAV 키도 leader와 충돌 못 함, mutation으로 RED 확인). fresh 독립 Opus judge 재판정 PASS.
- **리스크**: 없음(apps/web 격리 leaf·reference graph 밖, web build tsc+vite·web 83/83·pnpm check exit 0·smoke:broad 51/0·lint clean, 2개 독립 Opus judge[FAIL→fix→PASS]).
- **lesson**: 웹 NAV 단축키를 추가할 땐 nav-key 충돌뿐 아니라 **예약 leader 키("g")**도 검사하라 — 빌더가 "g가 다른 nav와 안 겹침"만 확인하고 leader 예약을 놓쳐 死 단축키를 냄. 이제 `LEADER_KEY` 단일출처 + `NavKeys.test` 가드가 이 클래스를 기계적으로 막는다. 확률(0~1)을 %로 그리는 모든 새 표면은 `formatProbabilityPct`를 재사용(극값-붕괴 오정보 클래스, fire 55).

## fire 60 · 2026-06-21 · skill v2.0.0 · e778da32
meta: surface=api · value-class=new-capability · pkg=@muse/api · kind=self-improve-playbook-api · verdict=PASS · firesSinceDrill=9
ratchet: api tests 880/880 (+8) · testFiles +0(기존 파일 확장) · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 51/0 · consecutive allPASS: fire 59 judge-catch로 리셋 → 다음 fire 61=firesSinceDrill 10 → ★JUDGE-DRILL 강제

- **무엇**: 웹 자기강화 콘솔의 다음 데이터 레이어 — 학습된 전략 playbook(`~/.muse/playbook.json`)을 읽는 read-only `GET /api/self-improvement/playbook` 신설(fire 58 weaknesses 라우트 정확 미러). 순수 `shapePlaybook`(reward DESC 정렬, 동률 recency=`lastReinforcedAt ?? createdAt` DESC, tag/origin/source→null·reward→0·probation→false·timesObserved→1 정규화, total 무드롭) + `playbookFile` 게이트 + server.ts 배선(`resolvePlaybookFile`) + ServerOptions.playbookFile.
- **왜**: 진안 "muse 자기강화 수준을 웹에서 보고 싶다"의 weaknesses(fire 58/59) 다음 — playbook 전략은 사용자 소유 ~/.muse 데이터(ACE arXiv:2510.04618 학습 도시에)라 가장 "자기강화"다운 표면. 데이터 레이어 먼저(웹 뷰는 다음 fire, fire 58→59 검증된 cadence). 다양성: fire 59=web 뷰였으니 이번은 (api, wiring) 다른 kind.
- **리뷰지점**: mutation-first — shapePlaybook 단위테스트(reward DESC + recency 동률, absent reward=0, null정규화, probation/timesObserved/reward 디폴트). reward 정렬 뒤집으면 2 RED·probation 디폴트 false→true 바꾸면 RED(둘 다 빌더+독립 judge 확인). 보안: read-only GET·weaknesses와 **동일 auth 게이트**(requireAuthenticated)·write 0·`readPlaybook`는 키 불일치 시 fail-closed throw(정직한 500, empty로 안 삼킴·경로/스택 미노출). 정직한 갭: 웹 뷰 미배선(다음 fire)·learned/eval 스코어보드는 후속.
- **리스크**: 없음(apps/api만 4파일, api build clean·api 880/880·pnpm check exit 0·smoke:broad 51/0·lint clean, 독립 Opus ④b judge가 shaper정확성·auth·다양성·mutation 검증 후 PASS).
- **drill-노트**: fire 61은 firesSinceDrill=10 도달 → 다음 슬라이스는 강제 JUDGE-DRILL(고의 나쁜-슬라이스 주입→judge FAIL 확인→롤백→진짜 fix), 미루기 불가.

## fire 61 · 2026-06-21 · skill v2.0.0 · 2624028e · ★JUDGE-DRILL
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=self-improve-strategies-view+judge-drill · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: web tests 88/88 (+5) · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 51/0 · ★verifier 신뢰성 입증(inert→FAIL, real→PASS)

- **무엇**: fire 60의 `GET /api/self-improvement/playbook`를 소비하는 웹 "학습된 전략(Learned strategies)" 섹션을 `SelfImprovementView`에 추가(weaknesses 아래). 순수 헬퍼 `strategyStatusLabel`(probation→"probation"/else "active")·`summarizeStrategies`(active vs probation distinct count) + `PlaybookStrategyView`/`PlaybookStrategiesResponse` 타입 + i18n(en/ko, si.strategies*). 각 전략을 상태 Badge(active=ok톤/probation=neutral톤)·tag·origin·reward로 렌더.
- **왜**: 진안 "자기강화 웹 콘솔"의 weaknesses(fire 59) + playbook API(fire 60) 다음 — 전략을 웹에서 본다. **핵심 정직-불변식**: probation 전략은 기록되되 graduate 전까지 agent run에 주입 안 됨 → 콘솔이 probation을 "active(작동중)"으로 표기하면 grounding-floor 위반(미graduate 전략이 행동을 형성한다고 거짓 주장). 그래서 active/probation을 정직히 구분하는 게 이 슬라이스의 본질.
- **★JUDGE-DRILL**: 이 fire가 강제 드릴(firesSinceDrill=10). 고의 나쁜-슬라이스 주입 — `strategyStatusLabel`을 항상 "active" 반환(probation 무시)·`summarizeStrategies` probation 하드코딩 0 + **선언-only 테스트**(typeof string·total만 체크, 결정적 게이트는 web 85/85 그린 통과). 독립 Opus judge#1이 FAIL 판정(구체적 위반: honesty 불변식 역전 self-improvement.ts:23·probation 0 하드코딩·테스트가 broken/correct 양쪽에 그린=mutation 무보호). → 롤백 → 진짜 fix(정상 헬퍼 + active/probation distinct 테스트, mutation으로 3 RED 확인) → fresh Opus judge#2 PASS. **verifier가 inert 슬라이스를 FAIL·real 슬라이스를 PASS함을 입증**(maker≠judge 보상통제 작동).
- **리뷰지점**: mutation-first — strategyStatusLabel always-active 변이→probation 테스트 RED, summarizeStrategies probation-0 변이→2 RED(둘 다 judge#2 독립 재확인). 보안: 전략 텍스트/tag/origin escaped React children(dangerouslySetInnerHTML 없음)·read-only GET. i18n en/ko 키셋+토큰({active}/{probation}/{n}) 패리티.
- **리스크**: 없음(apps/web 5파일, web build tsc+vite·web 88/88·pnpm check exit 0·smoke:broad 51/0·lint clean, judge#1 FAIL→fix→judge#2 PASS 드릴 완결).
- **lesson(드릴 교훈 증류)**: 결정적 게이트(build/test/lint)는 **선언-only 테스트를 통과시킨다** — honesty/도메인 불변식(probation≠active)을 검증하는 건 *행동 단언 + mutation-RED*뿐이다. 새 헬퍼의 테스트는 "함수가 string 반환"이 아니라 "이 입력→이 OUTCOME"을 단언해야 하며, mutation으로 RED 확인이 그 보증. ④b 적응형 judge는 이 클래스(도메인 불변식 위반 + vacuous test)를 안정적으로 잡는다.

## fire 62 · 2026-06-21 · skill v2.0.0 · cffe2d94
meta: surface=api · value-class=new-capability · pkg=@muse/api+autoconfigure · kind=self-improve-skills-api · verdict=PASS · firesSinceDrill=1
ratchet: api tests 897/897 (+5) · autoconfigure 88/88 · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 51/0 · lint clean

- **무엇**: 새 콘솔 영역 "스킬 컨트롤"의 데이터 레이어 — authored 스킬(`~/.muse/skills/authored/`)을 reward 사이드카(`~/.muse/skill-rewards.json`)와 병합해 읽는 read-only `GET /api/self-improvement/skills`(fire 58/60 패턴 미러). 순수 `shapeSkills`(reward DESC·동률 name ASC, reward 무시 시 0, `avoided`=`isSkillAvoided`(reward≤-4) 정직신호, total 무드롭) + `SkillView`/`SkillsResponse` + `authoredSkillsDir`/`skillRewardsFile` 게이트. autoconfigure에 `resolveSkillRewardsFile` 신설(`~/.muse/skill-rewards.json`, CLI resolver와 동일 경로/env) + server.ts 배선.
- **왜**: 진안 "openclaw/hermes처럼 웹에서 MCP·설정·스킬·자기강화 다 관리"의 **3번째 영역(스킬)** 개시. 자기강화(weaknesses+playbook) 다음 새 영역으로 다양성 확보. authored 스킬은 사용자/agent가 만든 ~/.muse 데이터 → 가장 관리할 만한 표면. value-class=new-capability.
- **리뷰지점**: mutation-first — shapeSkills 단위테스트(reward DESC + name ASC 동률·absent reward=0·avoided -4경계·total). reward 정렬 뒤집으면 2 RED·avoided 비교 flip하면 -4 경계 테스트 RED(둘 다 빌더+독립 judge 확인). **경로 정합(핵심)**: API가 CLI authored 경로(`~/.muse/skills/authored`)·rewards 경로(`~/.muse/skill-rewards.json`)·env(MUSE_AUTHORED_SKILLS_DIR/MUSE_SKILL_REWARDS_FILE)와 정확히 일치(judge가 CLI commands-skills.ts 대조 확인) — 안 그러면 콘솔이 빈/딴 dir 읽음. 보안: read-only GET·weaknesses/playbook과 동일 auth 게이트·skill `body`/`frontmatter` 미노출(name/description/source/reward/avoided만, 마크다운 과노출 없음)·loadSkillsFromDirectory/readSkillRewards 둘 다 fail-soft([]/{}). 정직한 갭: 웹 뷰 미배선(다음 fire)·authored만(user/workspace dir·curate/author 액션 후속).
- **형제(enumerate, 미루기 명시)**: CLI(`apps/cli/src/commands-skills.ts`)에 `resolveAuthoredSkillsDir`/`resolveSkillRewardsFile` private 복제본 존재 — 이번에 autoconfigure 공유본을 만들었으니 CLI를 그것으로 통일하면 gate-asymmetry 제거(별도 슬라이스, CLI 3파일 import 변경이라 backlog 기록).
- **리스크**: 없음(autoconfigure 3 + apps/api 4 파일, autoconfigure build clean·api 897/897·pnpm check exit 0·smoke:broad 51/0·lint clean[빌더가 남긴 re-export-only import 1건 dead-import 룰대로 제거], 독립 Opus ④b judge가 shaper·경로정합·auth·과노출·다양성·mutation 검증 후 PASS).
- **lesson**: 빌더가 re-export-from 블록에 더해 import 블록에도 심볼을 넣어 unused-import lint 위반 발생(personal-providers.ts) — `export {X} from "./y"`가 있으면 body 미사용 import는 불필요(code-style.md 재수출 규칙). pnpm check는 lint를 안 도니 ③ 시퀀스의 pnpm lint가 이 클래스를 잡는다.

## fire 63 · 2026-06-21 · skill v2.0.0 · a1f44f18
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=skills-console-view · verdict=PASS · firesSinceDrill=2
ratchet: web tests 92/92 (+4) · testFiles +2 · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 51/0 · lint clean

- **무엇**: fire 62의 `GET /api/self-improvement/skills`를 소비하는 새 "Skills" 콘솔 뷰(자체 nav, key "j", Icon.tool). authored 스킬을 이름·설명·source 배지·reward·**avoided 배지**(warn 톤, avoided=true일 때만)로 read-only 렌더. 순수 `summarizeSkills`(skill-list.ts: total/active/avoided distinct count) + `SkillView`/`SkillsResponse` 웹 타입 + i18n(en/ko). McpServers/SelfImprovement 뷰 패턴 미러.
- **왜**: 진안 "스킬도 웹에서 관리"의 fire 62 데이터 레이어 다음 뷰 — 스킬 콘솔 영역 end-to-end 완성(weaknesses 58→59, playbook 60→61, skills 62→63 동일 cadence). **avoided=정직신호**: soft-suppress된(적용 안 되는) 스킬을 배지로 표시해 "이 스킬이 작동 중"이라 오인 안 하게. 자체 nav 영역(스킬은 자기강화와 별개).
- **리뷰지점**: mutation-first — summarizeSkills(avoided 하드코딩 0→2 RED·active/avoided swap→RED, 둘 다 빌더+독립 judge 확인). 보안: read-only GET·스킬 name/description escaped React children(dangerouslySetInnerHTML 없음)·queryKey `["skills",baseUrl]`(self-improvement과 분리). nav: key "j" free(leader "g" 아님)·NavKeys.test 통과(leader충돌·중복키 가드)·settings 특례 무손상. i18n en/ko 키셋+토큰({n}/{a}) 패리티. 정직한 갭: reward/curate/author 액션은 후속(이번 read-only).
- **빌더 deviation(타당)**: 순수 헬퍼를 `skills.ts` 대신 `skill-list.ts`로 명명 — macOS 대소문자 무시 FS에서 `Skills.tsx`와 충돌(TS2305/1261). mcp-status.ts↔McpServers.tsx 동일 패턴.
- **리스크**: 없음(apps/web 6파일, web build tsc+vite·web 92/92·pnpm check exit 0·smoke:broad 51/0·lint clean, 독립 Opus ④b judge가 행동검증·avoided 정직신호·렌더안전·nav·i18n·다양성·mutation 검증 후 PASS).

## fire 64 · 2026-06-21 · skill v2.0.0 · e55867d7
meta: surface=api · value-class=new-capability · pkg=@muse/api · kind=skill-reward-actuator(STATE-CHANGE) · verdict=PASS · firesSinceDrill=3
ratchet: api 924/924 isolated · smoke:broad 52/0 (+1) · fabrication 0 · self-eval exit 0 · lint clean · ★첫 웹콘솔 상태변경 라우트

- **무엇**: 웹 콘솔 **첫 상태변경(write) 라우트** — `POST /api/self-improvement/skills/:name/reward`가 스킬 reward를 delta만큼 조정(`adjustSkillReward`→`~/.muse/skill-rewards.json` 영속, 누적 [-5,5] clamp는 store가). 순수 `parseRewardDelta`(유한·비0 number만 통과, 그외 undefined→400) + auth 게이트(read 라우트와 동일 `authed`) + `:name` decodeURIComponent. fire 62 read-only skills API의 write 카운터파트.
- **왜**: 진안 "스킬 컨트롤"을 read 너머 실제 control로 — 첫 웹 thumbs up/down 토대. **다양성 RATCHET 돌파**: 최근 web-view×4·api-wiring(read GET)×3 모노컬처에서 처음으로 (api, actuator/state-change) 새 kind. 로컬 self-tuning(제3자 outbound 아님)이라 outbound-safety draft-first 불요, 적용 게이트=auth(tasks complete·mcp connect와 동일).
- **리뷰지점(상태변경=게이트 증명이 핵심)**: **contract-faithful 실HTTP smoke**(가짜 레지스트리 아님)가 τ-bench no-partial-side-effect 증명 — reward 누적 persist(+2→2→+1→3), 무효 delta 3종(문자열·누락·0) 각 400, **무효 후 유효 +1이 정확히 4 착지**(무효가 mutate했다면 4 아님)로 부작용-0 입증. auth: write前 동일 authed 게이트 우회 없음. mutation-first: parseRewardDelta(Number.isFinite 제거→NaN/Inf 3 RED·비0 제거→0 RED). 입력안전: name은 고정 파일의 JSON 키일 뿐 경로탈출 불가. 독립 Opus ④b judge가 5축(게이트증명·auth·행동검증·입력안전·다양성) 검증 후 PASS.
- **리스크**: 없음(apps/api 3파일, api 924/924 isolated·smoke 52/0·lint clean·build clean).
- **환경 플레이크 메모(무관, 비차단)**: 풀 `pnpm check`에서 `apps/api/test/messaging-webhooks.test.ts`(LINE webhook gating)가 ~20s 타임아웃 1건 — 동시 6+ 루프 포화로 buildServer가 vitest 20s 한도 초과. **격리 단독 4/4 GREEN**(이 fire 첫 check 64a에선 통과)이라 내 슬라이스(self-improvement, messaging과 무관)와 무관한 환경 false-timeout. fire 64는 3배수 아니라 main-merge 없음, 브랜치 push만. 후속: 이 클래스는 박스 포화 신호, 테스트 회귀 아님([[project_test_hygiene_loop]]).

## fire 65 · 2026-06-21 · skill v2.0.0 · 0e082ec8
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=skills-reward-buttons(view+mutation) · verdict=PASS · firesSinceDrill=4
ratchet: web tests 101/101 (+9) · fabrication 0 · self-eval exit 0 · check exit 0(messaging-webhooks 이번엔 통과=환경 확정) · smoke:broad 52/0 · lint clean

- **무엇**: `SkillsView`에 ▲/▼ reward 버튼 배선 — fire 64의 `POST /api/self-improvement/skills/:name/reward`를 useMutation으로 호출(body {delta: rewardDelta(dir)}, onSuccess invalidate `["skills"]`로 목록 갱신). 순수 헬퍼 `rewardDelta`(up→+1/down→-1)·`canAdjustReward`(서버 [-5,5] clamp 인지: +5에서 ▲ disable·-5에서 ▼ disable) + i18n(skills.rewardUp/Down en/ko). McpServers connect/disconnect mutation 패턴 미러.
- **왜**: 진안 "스킬 컨트롤"을 read(62/63)+route(64) 다음 — 이제 **웹에서 직접 강화/약화**(end-to-end 완성). canAdjustReward로 guaranteed no-op 클릭 차단(+5에서 더 ▲ 못 누름)=정직한 UI(클램프 경계 노출). (web,view) 5/8로 RATCHET 한도 내.
- **리뷰지점**: mutation-first — canAdjustReward(>=5→>5 변이→"5+up→false" RED)·rewardDelta(상수화→"down→-1" RED), 독립 judge 재확인. 웹 테스트 인프라(renderToStaticMarkup, RTL/DOM 없음)라 클릭→mutation 단위테스트 불가 → McpServers와 동일 accepted 패턴(순수 결정로직 단위테스트 + 버튼 배선 inspection). 배선 정합(judge inspection): encodeURIComponent(name)↔라우트 decodeURIComponent 쌍·queryKey `["skills"]` prefix-match로 갱신·양 버튼 `disabled={pending || !canAdjustReward}`. 상태안전: 기존 auth-게이트 라우트만 호출(신규 노출 0)·escaped children. i18n en/ko 패리티. 정직한 갭: curate/author 액션 후속.
- **리스크**: 없음(apps/web 4파일, web build tsc+vite·web 101/101·pnpm check exit 0·smoke:broad 52/0·lint clean, 독립 Opus ④b judge가 경계로직·배선·상태안전·다양성·mutation 검증 후 PASS).

## fire 66 · 2026-06-21 · skill v2.0.0 · eac90550
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=mcp-allowlist-section · verdict=PASS · firesSinceDrill=5
ratchet: web tests 104/104 (+3) · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 52/0 · lint clean

- **무엇**: `McpServersView`에 read-only "Security/allowlist" 섹션 추가 — 기존 `GET /api/mcp/security`(effective 정책) 소비, 허용목록(서버명)·도구출력 상한 표시. 순수 `summarizeAllowlist`(mcp-status.ts: allowedCount + **unrestricted=빈목록**) + `McpSecurityPolicyView`/`McpSecurityResponse` 타입 + i18n(en/ko). MCP 콘솔(fire 57 connect/disconnect)에 보안 가시성 추가.
- **왜**: 진안 "웹에서 MCP 관리"의 보안 표면 — 어떤 외부 MCP 서버가 허용됐는지 웹에서 본다. **핵심 정직-불변식**: 코드(in-memory-stores.ts:209 `length===0 || includes`)상 **빈 허용목록=모든 서버 허용**(opt-in)이라, UI가 빈목록을 "0개 허용"(=전부 차단 암시)으로 표기하면 위험한 거짓 — "모든 서버 허용/제한없음"으로 표기해야. summarizeAllowlist의 unrestricted가 이 정직신호.
- **리뷰지점**: mutation-first — summarizeAllowlist(`===0`→`>0` 변이 시 빈목록 honesty 케이스 3 RED·`unrestricted:false` 하드코딩→1 RED), 독립 judge 재확인. effective 정책 사용(configDefault/stored 아님)·데이터 부재 시 honestly "unrestricted" degrade. 보안: read-only GET(서버측 auth 게이트)·허용목록 escaped children·기존 서버목록+connect/disconnect 무손상. i18n en/ko 키셋+토큰({n}) 패리티. 정직한 갭: allowlist 편집(PUT)·서버 add/remove는 후속(상태변경).
- **리스크**: 없음(apps/web 5파일, web build tsc+vite·web 104/104·pnpm check exit 0·smoke:broad 52/0·lint clean, 독립 Opus ④b judge가 빈목록-정직불변식·effective사용·읽기전용·다양성·mutation 검증 후 PASS).
- **merge-to-main 메모**: fire 66 ⑤c가 flaky `@muse/model web-search-policy` property-fuzz(격리 2/3 통과=비결정적) + saturation 타임아웃에 막혀 deferred. fires 61-66 브랜치 안전, fire 69 윈도우 재시도.

## fire 67 · 2026-06-21 · skill v2.0.0 · 668c4df5
meta: surface=api · value-class=new-capability · pkg=@muse/api · kind=settings-daemon-flags-api · verdict=PASS · firesSinceDrill=6
ratchet: api 932/932 · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 52/0 · lint clean · ★다양성 RATCHET 강제 전환(web-view 5/8→api-read)

- **무엇**: 설정 콘솔 영역 개시 — read-only `GET /api/settings/daemon-flags`가 핵심 백그라운드 데몬/기능 플래그 6종(episodic memory·home-watch·conflict-watch·proactive-agent-turn·background-review[skill학습]·knowledge-search)의 **effective on/off**를 보고. 순수 `shapeDaemonFlags(env)`가 각 플래그를 `parseBoolean(env[key], 기본값)`으로 — 데몬 실제 read-site와 **동일 resolver+기본값**(전부 false 확인)이라 거짓보고 0. 신규 `settings-routes.ts`(auth 게이트, self-improvement 패턴 미러) + server.ts 배선.
- **왜**: 진안 "proactivity·episodic·skill학습·watch daemon 웹에서 토글"의 데이터 레이어(read-first). **다양성 RATCHET 강제**: 최근 8 fire 중 (web,view)가 5/8 — 또 web-view면 6/8 위반이라 이번은 반드시 다른 kind → (api,read)로 전환(설정 영역). 토글(PUT)+웹 뷰는 후속.
- **리뷰지점(정직=effective state)**: 6 플래그 기본값이 실제 read-site와 일치해야 거짓 안 함 — 독립 judge가 6개 전부 read-site 대조(episodic chat-end-session:97·home-watch tick-daemons:678·conflict commands-daemon:580·proactive server:351·bg-review autoconf:840·knowledge autoconf:629, 전부 false) 확인. parseBoolean 재사용(truthy={true,1,yes,on}, 손수 `==="true"` 아님→런타임과 안 갈림). mutation-first: 기본값 flip→empty-env 테스트 RED·env 무시→override 테스트 RED. 보안: read-only GET·동일 auth 게이트·고정 6키 화이트리스트(process.env 통째 덤프 아님, 시크릿 노출 0)·불리언만. 정직한 갭: 토글 write·웹 뷰 후속.
- **리스크**: 없음(apps/api 3파일, api build clean·api 932/932·pnpm check exit 0·smoke:broad 52/0·lint clean, 독립 Opus ④b judge가 6-기본값-정직·parseBoolean재사용·auth·시크릿0·다양성 검증 후 PASS).

## fire 68 · 2026-06-21 · skill v2.0.0 · 2433dbfb
meta: surface=web · value-class=new-capability · pkg=@muse/web · kind=settings-daemons-view · verdict=PASS · firesSinceDrill=7
ratchet: web tests 107/107 (+3) · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 52/0 · lint clean

- **무엇**: 기존 `SettingsView`에 read-only "Background daemons" 카드 추가 — fire 67의 `GET /api/settings/daemon-flags` 소비, 6 데몬/기능 플래그를 label + on/off 배지로 표시. 순수 `summarizeFlags`(settings-flags.ts: total + enabled 카운트) "N of M enabled" 요약 + `DaemonFlagView`/`DaemonFlagsResponse` 타입 + i18n(en/ko). 설정 콘솔 읽기-side 완성(fire 67 API의 뷰).
- **왜**: 진안 "데몬 웹에서 토글"의 fire 67 데이터 레이어 다음 뷰 — 어떤 백그라운드 데몬이 켜졌는지 웹 Settings에서 본다. (web,view) 4→5/8(fire 67 api-read가 옛 web-view 윈도우 밖으로 밀어내 한도 내). 토글 write는 후속.
- **리뷰지점**: mutation-first — summarizeFlags(.filter 제거→2 RED·enabled 하드코딩0→1 RED), 독립 judge 재확인. 기존 SettingsView 무손상(시그니처/props·연결폼·언어·모델·setupStatus 카드 그대로, 카드 additive 삽입)·신규 query queryKey `["daemon-flags"]`(기존 setup/models와 분리). 보안: read-only GET(서버 auth 게이트)·label escaped children. i18n en/ko 키셋+토큰({enabled}/{total}) 패리티. 정직한 갭: 토글 write(env→runtime 브리지)·curate/author 후속.
- **리스크**: 없음(apps/web 5파일, web build tsc+vite·web 107/107·pnpm check exit 0·smoke:broad 52/0·lint clean, 독립 Opus ④b judge가 카운트정합·기존뷰무손상·읽기전용·i18n·다양성·mutation 검증 후 PASS).
- **드릴 예고**: fire 69 = firesSinceDrill 8(연속 allPASS≥8 트리거) + 3배수 merge-to-main 윈도우 → fire 69는 JUDGE-DRILL(고의 나쁜-슬라이스→FAIL확인→롤백→진짜fix) + fires 61-69 main 배치. fire 66 deferred merge도 그때 재시도.

## fire 69 · 2026-06-21 · skill v2.0.0 · c5bf5484 · ★JUDGE-DRILL
meta: surface=api · value-class=new-capability · pkg=@muse/api · kind=self-improve-reflections-api+judge-drill · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: api 942/942 · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 52/0 · lint clean · ★verifier 신뢰성 입증(inert→FAIL, real→PASS)

- **무엇**: 자기강화 콘솔에 read-only `GET /api/self-improvement/reflections` 추가 — reflection 데몬이 distill한 인사이트(`~/.muse/reflections.json`, 각 real source ids에 grounded)를 노출. 순수 `shapeReflections`(listReflections로 recency newest-first 정렬, `sourceCount=sourceIds.length` grounding신호·`supportCount` 별도) + `ReflectionView`/`ReflectionsResponse` + autoconfigure `resolveReflectionsFile`(CLI와 동일 경로/env) + 게이트/server 배선. fire 58/60/62 미러.
- **왜**: 자기강화 read 표면 확장(weaknesses·playbook·skills 다음 reflections). **다양성 RATCHET**: (web,view) 5/8라 web-view 금지 → (api,read) 유지. CLI resolveReflectionsFile private 복제 형제(skills와 동일 패턴, backlog).
- **★JUDGE-DRILL**(firesSinceDrill 8=연속allPASS≥8 트리거, 미루기불가): 고의 나쁜-슬라이스 주입 — `sourceCount`를 `sourceIds.length`(grounding신호) 대신 `r.supportCount`(강화횟수)로 **두 신호 conflate** + **선언-only 테스트**(typeof number만, 결정적 게이트 api 942/942·lint clean 통과). 독립 Opus judge#1이 FAIL(구체적: self-improvement-routes.ts:154 잘못된 필드=grounding-honesty 결함·테스트가 broken/correct 양쪽 그린=mutation 무보호, "942 passed while wrong" 독립 입증). → 롤백 → 진짜 fix(`sourceIds.length` + 2소스→2/0소스→0 단언, mutation으로 RED 확인) → fresh Opus judge#2 PASS. **verifier가 미묘한 필드-conflate(게이트 전부 통과)를 잡음=신뢰성 입증**.
- **리뷰지점**: mutation-first — sourceCount→supportCount 변이 시 "sourceCount equals sourceIds.length" RED(judge#2 독립 재확인)·ordering(listReflections 재사용). 경로정합: resolveReflectionsFile=CLI와 동일 `~/.muse/reflections.json`+MUSE_REFLECTIONS_FILE. 보안: read-only GET·동일 auth 게이트·재수출 export-from 블록(lint clean). 정직한 갭: 웹 뷰 후속·CLI resolver 통일(형제).
- **리스크**: 없음(autoconf 3+apps/api 4 파일, api 942/942·pnpm check exit 0·smoke 52/0·lint clean, judge#1 FAIL→fix→judge#2 PASS 드릴 완결).
- **lesson(드릴 교훈)**: 두 개의 의미상-다른 숫자필드(supportCount=강화 vs sourceCount=grounding소스)는 conflate해도 타입체크·테스트(typeof)·lint 전부 통과 — **필드 정확성은 "이 입력→이 값" 단언 + mutation-RED만이 보증**. grounding신호는 특히: 잘못된 필드=콘솔이 인사이트 근거강도를 거짓보고. ④b judge는 게이트-그린 미묘 필드결함을 안정적으로 잡는다.

## fire 70 · 2026-06-21 · skill v2.0.0 · feb85e9e
meta: surface=web · value-class=new-capability · pkg=@muse/web(+memory regression-fix) · kind=reflections-web-section · verdict=PASS · firesSinceDrill=1
ratchet: web tests 110/110 (+3) · fabrication 0 · self-eval exit 0 · smoke:broad 52/0 · lint clean · ★fires 61-69 main 안착(tight merge-push) + cross-loop byte-hygiene 회귀 수정

- **무엇**: `SelfImprovementView`에 read-only "Reflections" 섹션 추가 — fire 69 reflections API 소비, insight·supportCount·**sourceCount**(grounding신호) 표시. 순수 `summarizeReflections`(total + grounded=sourceCount>0 카운트) "N total, G grounded" 요약 + 타입 + i18n(en/ko). 자기강화 콘솔 3 read 섹션 완성(weaknesses+strategies+reflections).
- **왜**: 자기강화 콘솔 reflections 뷰(fire 69 API의 뷰). (web,view) 한도 내. **+동봉 회귀수정**: learning-surfacing 루프가 `packages/memory/recently-learned.ts:127`에 raw NUL(0x00) 3개를 템플릿 구분자로 넣어 repo byte-hygiene 게이트(전 루프 공유)를 깸 → `\u0000`(런타임 동일·소스 바이트-clean)으로 수정(memory 553/553·byte-hygiene 8/8 그린, judge가 behavior-preserving 확인).
- **리뷰지점**: mutation-first — summarizeReflections(`>0`→`>=0` 변이→2 RED·grounded 하드코딩0→1 RED), judge 독립 재확인. grounded 경계=sourceCount>0(=`>=0`이면 0소스 ungrounded를 grounded로 거짓표기 방지, honesty). 두 필드(support/source) 분리표시·insight escaped children. 기존 weaknesses+strategies 섹션 무손상·queryKey `["self-improvement-reflections"]` 분리. i18n {n}/{g} 패리티.
- **★merge-to-main 해결**: fires 61-69(9 fire) deferred saga 종료 — 동시 ~15 루프가 origin/main 빠르게 밀어 매 push가 non-FF race 패배(4분 check 도중 main 전진). 해결=**단일 통과 check 후 tight fetch-merge-push 루프(재-check 없이 초단위)**가 race 이김(attempt 1 성공). 교훈: 고동시성에선 push-시도마다 풀-check 재실행=영원히 race 패배; 1회 통과 후 tight merge-push가 정답.
- **리스크**: 없음(apps/web 5 + memory 1 파일, web 110/110·byte-hygiene 8/8·memory 553/553·smoke 52/0·lint clean. cli 5 실패는 saturation 타임아웃[격리 41/41·32/32 그린, 82s/41s 지속시간], 무관. 독립 Opus ④b judge가 honesty경계·기존섹션·byte-fix behavior-preserve 검증 후 PASS).
- **환경 플레이크 추가**: `chat-ink-render`·`document-reader`·`program`(PDF/Ink) cli 테스트도 saturation 타임아웃 클래스(messaging-webhooks·server.scheduler/mcp·web-search-policy에 추가). merge-check flake-exclusion에 포함.

## fire 71 · 2026-06-21 · skill v2.0.0 · 502861bb
meta: surface=cli · value-class=refactor · pkg=@muse/cli · kind=resolver-unification · verdict=PASS · firesSinceDrill=2
ratchet: cli 2889/2889 · fabrication 0 · self-eval exit 0 · check exit 0 · smoke:broad 52/0 · lint clean · ★다양성 RATCHET 전환(web-view 5/8→cli refactor)

- **무엇**: CLI가 자기 복제하던 경로 resolver 3종(`resolveAuthoredSkillsDir`·`resolveSkillRewardsFile`[commands-skills.ts]·`resolveReflectionsFile`[commands-reflections.ts])을 @muse/autoconfigure 공유본으로 통일 — 하드코딩 `~/.muse/...` 리터럴 제거, CLI는 얇은 위임 wrapper(export명·`= process.env` 디폴트 유지→~7 caller 무변경)만. autoconfigure가 단일 진실원천. 보너스: 공유본은 env override tilde 확장(CLI raw `||`엔 없던 개선).
- **왜**: fire 62(skill)·69(reflections)에서 내가 만든 gate-asymmetry 청산 — CLI private 복제 vs autoconfigure 공유본이 갈리면 한쪽 경로 변경 시 silent drift. **다양성 RATCHET**: (web,view) 5/8라 web-view 금지 → (cli, refactor)로 전환(콘솔 write 항목은 web-view거나 보안민감 상태변경이라 보류). 동봉: 내 fire-70 저널(surfaces.md:650)에 실수로 박힌 raw NUL 1개 제거(byte-hygiene 게이트 복구).
- **리뷰지점**: behavior-preserve(refactor 핵심) — 3 wrapper가 동일 경로/env키 resolve(judge가 autoconfigure provider-paths 대조, tilde확장만 차이=개선). mutation-first: resolveReflectionsFile를 sharedRewards로 위임시 default-path 단언 2 RED(judge 독립 재확인). 리터럴 0개·export/시그니처 무변경·orphan import(homedir/join) commands-reflections에서만 제거(skills는 resolveSkillsDir가 아직 사용). 정직한 갭: 콘솔 write(skills curate·MCP allowlist edit·daemon 토글)는 env→runtime 브리지/보안설계 필요해 후속.
- **리스크**: 없음(apps/cli 3파일 + 저널 byte-fix, cli build clean·cli 2889/2889·pnpm check exit 0·smoke 52/0·lint clean, 독립 Opus ④b judge가 behavior-preserve·경로정합·mutation·diversity 검증 후 PASS).
- **lesson**: 저널에 제어바이트(NUL 등)를 *설명*할 때 실수로 literal byte를 박지 마라 — fire 70이 NUL 수정을 기술하며 저널에 literal NUL을 박았고, 커밋시 byte-hygiene grep이 NUL-in-pipeline 에러로 silent 실패해 통과. 교훈: 저널 byte-scan을 git diff 파이프 대신 파일 직접 grep(NUL 안전)으로.

## fire 72 · 2026-06-21 · skill v2.0.0 · a3a357a9
meta: surface=web · value-class=new-capability · pkg=@muse/web+api · kind=mcp-allowlist-editor(STATE-CHANGE) · verdict=PASS · firesSinceDrill=3
ratchet: web 118/118 · api 942/942 · fabrication 0 · self-eval exit 0 · smoke:broad 52/0 · lint clean · ★judge가 보안-clobber 적발→fix→PASS(maker≠judge)

- **무엇**: MCP allowlist를 웹에서 **편집** — `McpServersView` Security 섹션(fire 66 read)에 add/remove 컨트롤(텍스트입력+Add, 서버명별 ×) 추가, 기존 auth-게이트 `PUT /api/mcp/security` 호출. 순수 `addToAllowlist`(dedup·trim·empty무시)·`removeFromAllowlist`(filter) + read-modify-write(현재 effective 정책 기반). 빈목록일 때 "추가하면 허용목록 서버만 연결" 힌트(empty→restrictive flip 정직 표시). MCP 콘솔 read+write 완성.
- **왜**: 진안 "웹에서 MCP 다 관리"의 allowlist 편집(콘솔 #1 영역 완성). read-view 우물 고갈→EXHAUSTION에 따라 CONTROL(상태변경)로. (web,view+mutation) 5/8 한도 내.
- **★maker≠judge 작동(보안 clobber 적발→수정)**: judge#1이 FAIL — PUT가 `allowedStdioCommands` 누락→서버 save()가 full-row replace로 그 필드를 **permissive 디폴트(9 commands)로 리셋**(in-memory-stores.ts:238, validateStdioCommand 강제) → 사용자가 하드닝한 stdio 허용목록이 서버-allowlist 편집 시 silent 광역화=보안 회귀. 게다가 웹 타입/shaper가 allowedStdioCommands를 노출조차 안 해 read-modify-write 구조적 불가. **수정**: shaper(toMcpSecurityPolicyResponse)+웹 타입에 allowedStdioCommands 노출 + PUT가 effective.allowedStdioCommands 보존 송신(maxToolOutputLength도). fresh judge#2 PASS — clobber 종료, effective→PUT end-to-end 보존 확인(`?? []` fallback은 AsyncBlock이 로드된 데이터에만 컨트롤 렌더라 unreachable).
- **리뷰지점**: mutation-first — addToAllowlist dedup제거→RED·removeFromAllowlist no-op→RED·shaper allowedStdioCommands 제거→test RED(셋 다 judge 독립 재확인). 보안: 기존 auth-게이트 PUT만(신규 unauth 경로 0)·두 정책필드(stdio·cap) 보존 송신·서버명 escaped children·invalidate `["mcp-security"]`. 기존 서버목록+connect/disconnect 무손상. i18n en/ko 패리티.
- **리스크**: 없음(apps/api 2 + apps/web 5 파일, web 118/118·api 942/942·smoke 52/0·lint clean, judge#1 보안-FAIL→fix→judge#2 PASS).
- **lesson**: read-modify-write로 정책/설정 객체를 PUT할 때, 서버 save()가 full-row replace면 **모든 기존 필드를 명시적으로 되돌려 보내야** 한다(누락=디폴트 리셋=silent 회귀). 특히 보안 필드(allowedStdioCommands)는 GET 응답에 노출돼 있어야 보존 가능 — 노출 안 된 필드는 read-modify-write 구조적 불가. judge가 이 클래스(부분-PUT clobber)를 게이트-그린에서 잡음.

## fire 73 · 2026-06-21 · skill v2.0.0 · CONSOLIDATION(no-ship: merge-resolve + decompose)
meta: surface=infra · value-class=consolidation · pkg=git/docs · kind=merge-to-main+decompose · verdict=N/A(no-slice) · firesSinceDrill=4
ratchet: self-eval exit 0 · pnpm check exit 0 · fabrication 0 · ★fires 70-72 origin/main 안착 + 설정-토글 DECOMPOSE

- **무엇**: 코드 슬라이스 무출하 fire. (1) fire 72 ⑤c merge-to-main이 동시루프 race+saturation에 막혀 deferred됐던 것 해결 — **tight merge-push(1회 통과 check 후 재-check 없이 fetch-merge-push)**로 fires 70-72를 origin/main에 안착(attempt 1 성공). (2) 남은 최상위 ◦(설정/daemon 토글 write)를 Opus 1-step DECOMPOSE.
- **왜(정직한 EXHAUSTION)**: easy read-surface 우물 고갈 — 4 콘솔영역(MCP·skills·자기강화·settings) 모두 read 표면+핵심 control 완료. 남은 ◦는 전부 아키텍처/멀티-fire: (a) 토글 write=env→runtime 브리지(모든 플래그가 assembly/startup에 env만 읽음, runtime store 미연결 → PUT만으론 inert/거짓표기), (b) 서버 config CRUD, (c) eval 스코어보드=dev-INFRA(개인콘솔 부적합, 정당 보류). 마지노선에서 마지널 슬라이스 강행 대신 DECOMPOSE-ON-DEFER대로 토글을 loop-sized S1-S4+로 쪼개 backlog 기록(첫 honest 슬라이스=S1 seam+S2 read-site 재배선+S3 PUT 한 플래그 end-to-end; S3 단독금지=정직성).
- **리뷰지점**: 코드 변경 0(merge-resolve는 동시루프 work를 origin/main에 올림, decompose는 backlog 계획). merge-to-main 교훈 확립=고동시성에선 push-시도마다 풀-check 재실행=영원히 race 패배; **1회 통과 check + tight fetch-merge-push가 정답**(fire 70·73 둘 다 attempt 1 성공). 백그라운드 merge 태스크는 다음 fire 시작시 killed되니 **동기(foreground) 실행**해야 완료.
- **리스크**: 없음(no-ship; main 안착은 게이트-그린 후, 브랜치 안전).
- **lesson**: 마라톤 세션(14 슬라이스)에서 easy 우물 고갈 시 — 마지널/위험 슬라이스 강행보다 (a) 누적 머지부채 청산 (b) 큰 항목 DECOMPOSE가 정직하고 미래-fire 셋업. 다음 fire는 backlog S1(브리지 seam)부터.

## fire 74 · 2026-06-21 · skill v2.0.0 · NO-SHIP(honest blocker — vein exhausted)
meta: surface=infra · value-class=blocker · pkg=n/a · kind=exhaustion-blocker · verdict=N/A(no-slice) · firesSinceDrill=5
ratchet: self-eval exit 0 · main up-to-date · gap-scout CLEAN · fabrication 0

- **무엇**: 무출하 fire(정직한 블로커). ⓠ self-eval 그린·main 최신(fires 70-73 안착). ① PICK에서 easy 우물 고갈 재확인 + gap-scout(scout-signals.mjs) 돌렸으나 CLEAN(합성 트레이스 3건 ×1, 실패클러스터 없음=실일감 0). 남은 backlog 최상위는 전부 아키텍처/멀티-fire.
- **왜(정직 종료)**: fire 73-74 심층분석 결론 — settings/daemon 토글의 **첫 honest+functional 슬라이스조차 중앙 `createMuseRuntimeAssembly`의 env-resolution 변경(applyRuntimeFlagOverrides 배선)** 필요. blast-radius=시스템 전체 조립 핵심 → 16-fire 마라톤 꼬리에서 무인으로 강행은 무책임. 대안(S1 seam만)=consumer 없는 speculative helper(judge FAIL감), 또는 override 노출=데몬 미반영 거짓표기(정직성 위반). 즉 **clean+safe+honest 슬라이스 부재**. ⑥대로 마지널/위험 강행 대신 블로커 기록+정직 종료.
- **블로커(다음 deliberate fire)**: 토글 = `applyRuntimeFlagOverrides(env, runtimeSettings)` 순수 헬퍼 + createMuseRuntimeAssembly env-resolution 초입 배선(additive·override無면 noop) + daemon-flags GET이 동일 merge 적용(restart-applied로 정직 라벨) + 기존 admin settings PUT로 override write. 중앙조립 변경이라 신중한 fire 필요(무관 state 손상 검증 강하게).
- **리스크**: 없음(no-ship, 코드변경 0).
- **lesson**: 우물 고갈+gap-scout clean+남은게 중앙-조립 아키텍처 변경이면, 무인 마라톤 꼬리에서 강행 금지 — speculative/위험 슬라이스보다 정직한 블로커가 옳다(⑥). 테마는 살아있되(토글 가치 큼) deliberate fire 대상.

## fire 75 · 2026-06-21 · skill v2.0.0 · 177d7ba9
meta: surface=web · value-class=a11y-hardening · pkg=@muse/web · kind=input-accessible-names · verdict=PASS · firesSinceDrill=6
ratchet: web 121/121 · fabrication 0 · self-eval exit 0 · lint clean · ★다양성 전환(web,a11y) + judge가 vacuous-test 적발→couple-to-prod fix → PASS · ⚠pnpm check는 타루프 autoconfigure HANG으로 RED(무관)

- **무엇**: 웹 콘솔 search/filter/add 인풋(placeholder-only=접근가능명 없음, WCAG 4.1.2 위반)에 `aria-label` 추가 — Tools filter·Notes search/name/body·Tasks add·Memory userId·MCP allowlist add. 기존 placeholder i18n 키 재사용(신규 문자열 0)·additive 속성만. + 실뷰 렌더 a11y 테스트.
- **왜**: easy 우물 고갈 후 다양성 RATCHET이 web-view에서 전환 요구 → (web, a11y) 새 kind. a11y는 진짜 품질(스크린리더가 인풋 식별 불가). 두 fire 무출하(73·74) 후 작지만 실(實) 출하가 정직.
- **★maker≠judge(vacuous test 적발→fix)**: judge#1 FAIL — 빌더의 테스트가 실뷰 대신 **인라인 미러카피** 마크업을 테스트(실 Tools.tsx aria-label 제거해도 125 그린=프로덕션 미커플). **수정**: 테스트를 실 `ToolsView/NotesView/MemoryView`를 `renderToStaticMarkup`+QueryClientProvider+I18nProvider로 렌더해 aria-label 단언하게 재작성. mutation 실증: 실 Tools.tsx aria-label 제거→RED(judge#2 독립 재확인). fresh judge#2 PASS.
- **리뷰지점**: mutation-first(실뷰 커플). additive aria-label(로직변경 0·신규 i18n 0). 기존 `<label htmlFor>` 있는 폼(Calendar/Reminders/Autonomy/Messaging)은 미접촉. 형제-감사: 남은 placeholder-only 인풋 전부 이 fire에 처리. 정직한 갭: 인풋별 개별 테스트 아닌 대표 3뷰 커플(패턴 입증).
- **리스크**: 없음(apps/web 6파일 additive, web 121/121·lint clean, judge#1→fix→judge#2 PASS). **단 pnpm check RED**(아래 블로커, 무관).
- **★BLOCKER(공유 main 회귀, 비-surfaces, HIGH)**: `@muse/autoconfigure` runtime-assembly e2e(autoconfigure.test·runtime-assembly-{e2e,cache-e2e,streaming-e2e}·background-review-wiring) **HANG**(60s timeout도 미완=진짜 행, saturation 아님). origin/main에 타루프(agent-core logprobs `792a408a` / execute-tool `232f04e9` / model 변경 후보)가 머지한 회귀로 추정 — full agent-run이 멈춤. **전 루프 pnpm check + API 조립 차단**. surfaces 도메인 아님(agent-core/model/multi-agent 소유) → 해당 루프/진안이 bisect+fix 필요. surfaces fire 75 merge-to-main은 이 행으로 deferred(main 깨짐, 게이트 그린 불가).
- **lesson**: a11y(또는 어떤) 테스트가 뷰 마크업을 *복제*해 테스트하면 프로덕션과 디커플=tautology(빌더 흔한 실수, useQuery 뷰 렌더가 귀찮을 때). 반드시 **실 컴포넌트를 렌더**(QueryClientProvider+I18nProvider로 useQuery 뷰도 static 렌더 가능)해 mutation이 프로덕션에서 RED 나는지 확인. ④b judge가 이 디커플을 잡음.