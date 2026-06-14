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
