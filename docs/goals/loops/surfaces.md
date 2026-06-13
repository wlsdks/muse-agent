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
