# Loop journal — tool-hardening

> Per-loop append-only journal (loop-creator v1.14.0+). One entry per fire, newest at bottom.
> Schema (going-forward entries):
>
>     ## fire N · YYYY-MM-DD · skill vX.Y.Z · <commit-sha>
>     meta: value-class=micro-fix|new-capability|wiring|refactor · pkg=@muse/… · kind=… · verdict=PASS|FAIL · firesSinceDrill=N
>     ratchet: testFiles … · fabrication 0 · <eval delta>
>     - 무엇 …  - 왜 …  - 리뷰지점 …  - 리스크 …
>
> 테마: TOOL expansion & hardening. Why per-loop (not a shared digest): 4 loops run concurrently; a shared
> append file collides every fire and pollutes the version↔outcome correlation. Disjoint
> paths → no merge race, no pollution. Convention: [README](README.md).
> (Entries below the schema line are MIGRATED from the old shared loop-digest.md, original headers kept.)

## fire 1 — 2026-06-12 · 테마: TOOL expansion & hardening

- **무엇:** `muse.tasks.update` 툴에 `groundedArgs: ["notes"]` 추가 (+ 선언 검증 단위테스트).
- **왜:** update의 free-text `notes`가 anti-fabrication 경계 밖이라, 8B가 사용자가 말 안 한 notes를 지어내 디스크에 저장 가능했음(tasks add·calendar는 이미 보호). 그라운딩 엣지 확장.
- **리뷰지점:** `packages/mcp/src/loopback-tasks.ts`(update 툴 def 한 줄) + `packages/mcp/test/tasks-reminders-tool-schema.test.ts`(테스트). 게이팅 검증자(Opus)가 런타임 경로 추적해 PASS — `agent-runtime.ts:857-860`이 groundedArgs를 generic하게 적용하므로 선언으로 충분.
- **리스크:** 테스트가 *선언*만 검증(드롭 *동작*은 공유 메커니즘+상류 테스트가 보장). projection 배선 회귀는 이 테스트가 못 잡음. `title`은 의도적으로 ungrounded(rename 의도). 빌드/테스트(mcp 1655)·lint 0.

## fire 2 — 2026-06-12 · 테마: TOOL expansion & hardening

- **무엇:** `add_contact` 툴에 `groundedArgs: ["relationship"]` 추가 (+ 선언 검증 테스트).
- **왜:** contacts add의 free-text `relationship`("doctor"/"manager")가 anti-fabrication 경계 밖 — "Bob 추가해" 했는데 8B가 관계를 지어내 저장 가능. tool-arg grounding 항목의 다음 actuator(fire 1 tasks.update에 이어).
- **리뷰지점:** `packages/mcp/src/contacts-tool.ts`(한 줄) + `packages/mcp/test/contacts-tool.test.ts`. 게이팅 검증자(Opus)가 *다른 등록 경로*(직접 MuseTool, MCP loopback 아님)를 추적해 확인 — `toModelTool`(tools/index:385)이 groundedArgs를 carry, `agent-runtime:857-859`이 적용. inert 아님.
- **리스크:** fire 1과 동일(선언 테스트, 드롭 동작은 공유 메커니즘 보장). `name`은 required라 ungrounded. vision-auto(`commands-ask:2573`)는 결정적 추출 경로라 위협모델 밖. mcp 1656·lint 0.

> ⚠️ **다음 fire(fire 3) = 리뷰 관문.** 빌드 멈추고 fire 1–2 누적 다이제스트를 진안이 머지 전 읽도록 요청.

## fire 3 — 2026-06-12 · 리뷰 관문 + 루프 자기개선

- **무엇:** fire 1–2 리뷰 관문에서 진안이 평가 → 루프 4개 약점을 계약·스킬에 가드로 박음(§4.5): ①가치 우선(검증 쉬운 것 아님, defer는 명시) ②다양성(같은 패턴 반복 금지) ③행동 acceptance(선언-only 테스트 금지) ④토큰(배칭+리스크-티어) ⑤실패 드릴. + **fault-injection 드릴 실행**.
- **왜:** 2 fire가 *기계*는 잘 돌았지만 *산출*이 저야망(같은 마이크로 패턴·선언-only 테스트·비싼 토큰·실패 경로 미검증). 메커니즘 신뢰를 위해 실증 필요.
- **리뷰지점:** `loop-engineering.md §4.5`(가드) + `SKILL.md` ②③④b. **드릴 증거:** 고의 inert 슬라이스(tasks add에 스키마에 없는 `category` grounding) 주입 → Opus 게이팅 검증자가 **VERDICT: FAIL**(inert·행동테스트 없음·기존 테스트 깸 3축) → `git restore` 롤백 → mcp 1656 green 복구.
- **리스크:** 4개 가드는 *프롬프트 지시*라 다음 fire들이 실제로 따르는지는 라이브에서만 확인됨(드릴로 ④b는 실증). 드릴은 1회(반복 드릴은 토큰).

## fire 5 — 2026-06-12 · 회귀 수정 (skill v1.8.0)

- **무엇:** main의 실패 테스트 `program.test.ts > pluralises 'day' (goal 129)`를 고침 — 하드코딩 날짜(2026-05-13~15)를 `daysAgoIso(n)` 상대 날짜로.
- **왜:** 회귀-우선 규칙(①). `muse routine` window가 `Date.now()-30d`(commands-routine.ts:122, 주입 불가)라 하드코딩 날짜가 시간 흘러 window 밖으로 밀려나 0세션 → "across 1 day" 기대가 깨짐. **production pluralise 코드는 정상**(line 147), brittle 테스트가 원인.
- **리뷰지점:** `apps/cli/test/program.test.ts`만 변경(tsIso 값만). 어설션 불변. 게이팅 검증자(Opus)가 "테스트 약화 게이밍 아닌가" 적대 판정 → UTC 날짜 카운팅·off-by-one 없음 확인 PASS.
- **리스크:** 동종 시간-폭탄 테스트가 더 있을 수 있음(다른 하드코딩 날짜). cli 2492 green·lint 0. (별개 flake: chat-grounding "fails soft" 5s 타임아웃 — 이번엔 통과, 미해결.)

## fire 6 — 2026-06-12 · 신호 scout 하드닝 (skill v1.8.1)

- **무엇:** 신호 scout(`run-log-analysis.ts`)가 **빈-답(non-answer) ungrounded를 실패로 안 세도록** 제외 + 스크립트가 answer 추출.
- **왜:** 가치-우선으로 scout의 #1 발견(browser-read ungrounded ×7)을 잡았더니 **dev 노이즈**였음 — 2026-06-11 내 브라우저 테스트의 빈 답(tools []). 막 만든 발굴 도구의 #1이 노이즈면 신뢰 불가 → 도구 자체를 고침(diversity: fire 5와 다른 KIND).
- **리뷰지점:** `apps/cli/src/run-log-analysis.ts`(isFailureEvent: success===false 먼저 short-circuit, 그 후 ungrounded+빈답만 제외) + test 3건 + `scout-signals.mjs`(answer 추출). **end-to-end 증명:** 실데이터 재실행 1 클러스터 → **0 클러스터**(노이즈 제거) + "clean board → tier 2" 메시지로 3단 사다리 작동. backlog의 노이즈 항목은 Dropped로 정정.
- **리스크:** 실패한 run(success:false)은 빈 답이어도 여전히 카운트(검증자 확인). 패러프레이즈 병합·실사용 vs 합성 트레이스 구분은 future. cli 2495·lint 0.
## fire (TOOL loop) — 2026-06-12 · mac reader 슬라이스 GATE FAIL → 롤백 (skill v1.9.0)

- **무엇:** `mac_reminders_read` 빌드했으나 ④b 게이팅 검증자 **VERDICT: FAIL** → `git restore` 롤백. backlog에 블로커.
- **왜:** 가치-우선으로 mac readers(새 역량) 선택, 기존 injectable-runner로 mock 행동검증(8 테스트, build green). 하지만 도구를 `actuator-tools.ts`(모델-노출 셋)에 **미배선 = inert** — 모델이 선택 못 함(tool-calling.md "선택 안 되면 전달 안 됨"). eval:tools 케이스도 없음.
- **리뷰지점:** 롤백돼 코드 변경 0(macos 66 tests 원복). backlog mac 항목에 블로커: **다음 슬라이스 = reader + actuator-tools.ts 배선 + eval-tool-selection.mjs 골든 케이스**(완전체).
- **리스크:** 없음(롤백). 교훈: "새 도구" 슬라이스 = 정의만 아니라 **배선+eval 선택 케이스까지**. 게이팅 검증자가 *test-green이지만 inert*를 잡음 — 정상 fire 첫 진짜 FAIL, "verifier you trust" 실증.

## fire (TOOL loop) — 2026-06-12 · mac Reminders read — COMPLETE (배선+eval), gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `reminders` SOURCE 추가(새 도구 아님 — 작은-셋 규칙). osascript가 미완료 리마인더 title/due 읽음. 5 행동 테스트(fake runner) + eval:tools 골든 2건(EN+KO).
- **왜:** 직전 fire의 INERT 실패(미배선 별도 도구) 교훈을 적용 — Option A로 *이미 배선된* mac_app_read의 enum을 확장하니 배선 0 + 모델이 즉시 선택 가능. 가치-우선 mac readers의 첫 앱(Reminders) 완성.
- **리뷰지점:** `packages/macos/src/macos-tools.ts`(source enum+buildReadScript+parseReadOutput case+desc/keywords) + test 5건 + `scripts/eval-tool-selection.mjs` 2 케이스. 게이팅 검증자(Opus)가 **built dist의 enum에 reminders 실재** 확인(inert 아님) + read-risk(mutation 없음) + 무회귀(70/70).
- **리스크:** Calendar/Notes source는 아직(다음 fire, 같은 패턴). 리마인더 list 많으면 osascript 느릴 수 있으나 30s watchdog 캡. backlog: Reminders DONE, Calendar/Notes REMAINING.

## fire (TOOL loop) — 2026-06-12 · mac Calendar+Notes read (배칭) — mac readers DONE, gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `calendar`(오늘 일정)+`notes`(최근 제목) source 2개를 **배칭**으로 추가(reminders 패턴 미러링). 8 행동 테스트 + eval 골든 4건(EN+KO). mac readers 3앱 완성.
- **왜:** backlog가 "Calendar/Notes는 같은 패턴 다음 슬라이스"라 명시 → 동종이라 **배칭 가드**로 한 fire에(토큰 절약, 2 fire→1). 직전 reminders 완전체 패턴 재사용.
- **리뷰지점:** `macos-tools.ts`(enum+script+parse+desc, calendar/notes case) + test 8건 + eval 4건. 게이팅 검증자(Opus, 리스크-티어 가볍게 — 검증된 경로 반복)가 둘 다 enum 도달·read-only(mutation 없음 정밀 확인)·무회귀(78/78) PASS.
- **리스크:** 캘린더 많으면 osascript 느릴 수 있으나 today 필터+30s watchdog. notes는 body 아닌 title만(거대 방지). mac readers 항목 Done → 다음 fire는 다른 KIND(다양성).

## fire (TOOL loop) — 2026-06-12 · tool-arg grounding: followup.cancel.reason, gate PASS (skill v1.9.0)

- **무엇:** `followup.cancel`의 optional free-text `reason`에 `groundedArgs: ["reason"]` 추가. 행동 드롭 테스트(조작 reason 드롭/진술 reason 유지, groundToolArguments 직접) + 선언 테스트.
- **왜:** 다양성 가드(최근 3=mac readers)로 다른 KIND. reminders 타겟이었으나 **fabricable free-text 필드 없음**(text/dueAt/recurrence) → 정직히 next-best(followup.cancel)로 피벗. anti-fabrication floor를 actuator 하나 더 확장.
- **리뷰지점:** `loopback-followups.ts`(한 줄) + agent-core 행동 테스트 2건 + mcp 선언 테스트. 게이팅 검증자(Opus)가 followup.cancel을 tasks/contacts와 동일 경로(agent-runtime:857-859)로 추적 — inert 아님. reason은 서버 기본값 fallback이라 드롭돼도 안전.
- **리스크:** 없음. mcp 1667·agent-core 1705·lint 0. 남은 actuator free-text 감사는 다음 fire 후보(또는 다른 KIND).

## fire (TOOL loop) — 2026-06-12 · per-tool not-when: followups family, gate PASS (skill v1.9.0)

- **무엇:** `followup` 3도구(list/cancel/snooze)에 "use when / NOT when" 클로즈 추가 — followup을 tasks/reminders와 디스앰비그(followup=에이전트 자동 캡처 thread, 사용자 항목 아님). + eval:tools `buildFollowupScenario`(6 positive + 4 disambiguation).
- **왜:** TOOL 테마 얇아진 가운데, followups가 **유일하게 not-when 0개 패밀리** = 8B 오선택 위험 최고 → value-first. 다른 KIND(설명/선택 하드닝, groundedArgs·mac 아님).
- **리뷰지점:** `loopback-followups.ts`(설명만) + `eval-tool-selection.mjs`(시나리오+main 배선). 게이팅 검증자(Opus)가 disambig 케이스 변별력·배선·expectTool 실재 확인 — 선택-변경의 행동 acceptance=eval:tools(tool-calling.md). 코드 behavior 무변경.
- **리스크:** 라이브 eval:tools 미실행(Ollama 필요, CI/smoke:live가 돌림) — 케이스는 golden 자산. mcp 1667·lint 0.
> ✅ **리뷰 관문 CLEARED (2026-06-12, 진안):** fires 4–6 승인. **배치 머지됨 → 로컬 main `427193c3`**(branch+25 ↔ main+3 동시-루프 커밋, 3-way; loop-digest만 충돌→양쪽 보존; 머지 후 -r build clean + memory 355·agent-core 1703 green). push는 보류(진안이 origin). **fire 7 = 멀티에이전트 오케스트레이션(#3, 미착수 테마)** — MAST 실패모드(step repetition·reasoning-action mismatch·unaware-of-termination)를 council/MoA/harness 경계에서 결정적 가드. fires 7–9가 다음 리뷰 사이클.

## fire (TOOL loop) — 2026-06-12 · web_download post-redirect SSRF re-check (EXPANSION-scouted), gate PASS (skill v1.9.0)

- **무엇:** `web_download`가 redirect 후 최종 `response.url`을 SSRF 재검사 안 하던 구멍을 닫음 — fetch 후·디스크 쓰기 전 assertPublicHttpUrl 재적용(형제 web-read/fetch-readable-url 미러링). 행동 테스트(메타데이터로 redirect→refused+미기록).
- **왜:** TOOL backlog 얇음 → 3단 사다리의 **EXPANSION gap-scout**가 진짜 보안 갭 발굴(busywork 아님). public→사설 redirect로 메타데이터/내부호스트 도달해 디스크 기록되던 실제 SSRF.
- **리뷰지점:** `web-download-tool.ts`(재검사 4줄, 쓰기 전·fail-closed) + `.test.ts`(redirect→private 케이스). 게이팅 검증자(Opus, security-grade full)가 순서·fail-closed·형제일치·happy-path·STABLE 3/3 확인 PASS.
- **리스크/잔여:** production lookup 미배선이라 sync-only(리터럴 사설IP는 잡고 DNS-rebinding은 못 잡음) — 기존 가드와 동일, 새 ◦로 backlog 기록. mcp 1668·lint 0.

## fire (TOOL loop) — 2026-06-12 · DNS-rebinding SSRF closed (FAIL→test-fix→re-PASS), gate PASS (skill v1.9.0)

- **무엇:** web_download/web_action의 `deps.lookup ? async : sync` 우회 제거 → 항상 async 가드(defaultLookup=node dns가 resolve+체크) → no-lookup production 경로도 DNS-rebinding(public-name이 private IP로 resolve) 차단. hermetic 테스트(주입 privateLookup + dns-stub no-lookup).
- **왜:** 직전 SSRF fire가 surface한 잔여 ◦(value-first 보안). sync 가드는 리터럴 사설IP만 잡아 rebinding 무방비였음.
- **리뷰지점:** `web-download-tool.ts`·`web-action-tool.ts`(우회 제거)·`run-actuator-by-name.ts`(lookup 배선) + 테스트들. **2-단계 게이트:** 1차 Opus가 가짜 테스트(NXDOMAIN 의존, rebinding 아님) FAIL → 테스트를 hermetic(주입 privateLookup + dns-stub)으로 고침 → 2차 Opus가 **bypass 재도입해 no-lookup 테스트 FAIL 확인**(진짜 변별) 후 PASS.
- **리스크:** 없음. production이 이제 매 web fetch에 실DNS lookup(보안 위해 수용). mcp 1670·lint 0. 교훈: production 옳아도 *테스트가 OUTCOME을 증명*해야 통과(behavioral acceptance).

## fire (TOOL loop) — 2026-06-12 · loopback-filesystem symlink-escape closed, gate PASS (skill v1.9.0)

- **무엇:** MCP filesystem 서버의 allowlist가 lexical-only라 symlink 탈출(/allowed/x→/etc/passwd) 가능하던 것을, `checkAllowed`에 realpath 2차 게이트 추가(path·root 둘 다 realpath, 실경로가 root 밖이면 refuse, throw/ENOENT면 fail-closed) read/list/stat 전부.
- **왜:** EXPANSION scout runner-up(value-first 보안, SSRF와 다른 벡터=경로/symlink). file_read엔 realpath 가드 있었으나 MCP 변종엔 없던 갭.
- **리뷰지점:** `loopback-filesystem.ts`(checkAllowed async 2-게이트 + injectable realpath) + 신규 test 8건. 게이팅 검증자(Opus full)가 escape 차단·boundary 정확·**optional realpath 구멍 아님**(production 항상 default realpath, caller grep 확인)·macOS /var 대칭·무회귀 PASS.
- **리스크:** realpath→read TOCTOU 잔여(모든 realpath 가드 공통, 회귀 아님). mcp 1678·lint 0.
## fire (TOOL loop) — 2026-06-13 · mac_screenshot arbitrary-write closed (FAIL→fix→re-PASS), gate PASS (skill v1.9.0)

- **무엇:** `mac_screenshot`의 무가드 `path`(임의 파일 덮어쓰기)를 닫음 — allowlist(~/Desktop·Downloads·tmp) + ~확장 + basename + parent realpath + **full-target realpath**(symlink-at-target 거부, fail-closed, runner 미호출). 6 행동 테스트.
- **왜:** EXPANSION scout가 "유일하게 남은 무가드 WRITE 경로"로 발굴(최고 severity 파괴적 write). 보안 sweep 마지막 항목.
- **리뷰지점:** `macos-tools.ts`(resolveScreenshotPath + injectable realpath) + test 6건. **2-단계 게이트:** 1차 Opus가 *silent* symlink-at-target 잔여(직전 fire 77004a6f가 닫은 class 재도입) FAIL → full-target realpath로 닫음 → 2차 Opus가 변별·무회귀 확인 PASS.
- **리스크:** realpath→write TOCTOU 잔여(모든 realpath 가드 공통). macos 83·lint 0. 보안 sweep(SSRF×2·symlink·write) 완료 → 다음 fire는 다른 KIND.
## fire (TOOL loop) — 2026-06-12 · web_download post-redirect SSRF re-check (EXPANSION-scouted), gate PASS (skill v1.9.0)

- **무엇:** `web_download`가 redirect 후 최종 `response.url`을 SSRF 재검사 안 하던 구멍을 닫음 — fetch 후·디스크 쓰기 전 assertPublicHttpUrl 재적용(형제 web-read/fetch-readable-url 미러링). 행동 테스트(메타데이터로 redirect→refused+미기록).
- **왜:** TOOL backlog 얇음 → 3단 사다리의 **EXPANSION gap-scout**가 진짜 보안 갭 발굴(busywork 아님). public→사설 redirect로 메타데이터/내부호스트 도달해 디스크 기록되던 실제 SSRF.
- **리뷰지점:** `web-download-tool.ts`(재검사 4줄, 쓰기 전·fail-closed) + `.test.ts`(redirect→private 케이스). 게이팅 검증자(Opus, security-grade full)가 순서·fail-closed·형제일치·happy-path·STABLE 3/3 확인 PASS.
- **리스크/잔여:** production lookup 미배선이라 sync-only(리터럴 사설IP는 잡고 DNS-rebinding은 못 잡음) — 기존 가드와 동일, 새 ◦로 backlog 기록. mcp 1668·lint 0.

## fire (TOOL loop) — 2026-06-12 · DNS-rebinding SSRF closed (FAIL→test-fix→re-PASS), gate PASS (skill v1.9.0)

- **무엇:** web_download/web_action의 `deps.lookup ? async : sync` 우회 제거 → 항상 async 가드(defaultLookup=node dns가 resolve+체크) → no-lookup production 경로도 DNS-rebinding(public-name이 private IP로 resolve) 차단. hermetic 테스트(주입 privateLookup + dns-stub no-lookup).
- **왜:** 직전 SSRF fire가 surface한 잔여 ◦(value-first 보안). sync 가드는 리터럴 사설IP만 잡아 rebinding 무방비였음.
- **리뷰지점:** `web-download-tool.ts`·`web-action-tool.ts`(우회 제거)·`run-actuator-by-name.ts`(lookup 배선) + 테스트들. **2-단계 게이트:** 1차 Opus가 가짜 테스트(NXDOMAIN 의존, rebinding 아님) FAIL → 테스트를 hermetic(주입 privateLookup + dns-stub)으로 고침 → 2차 Opus가 **bypass 재도입해 no-lookup 테스트 FAIL 확인**(진짜 변별) 후 PASS.
- **리스크:** 없음. production이 이제 매 web fetch에 실DNS lookup(보안 위해 수용). mcp 1670·lint 0. 교훈: production 옳아도 *테스트가 OUTCOME을 증명*해야 통과(behavioral acceptance).

## fire (TOOL loop) — 2026-06-13 · 정직 보고 + backlog hygiene (skill v1.9.0)

- **무엇:** 비싼 build 대신 "둘 다 마르면 정직 보고" 티어 실행 — backlog의 중복 항목(이전 fire들이 PROGRESS 추가하며 남긴 `(orig)` 짝)을 정리하고 TOOL 테마 상태를 정직 기록.
- **왜:** self-eval green·신호 scout clean(0)·보안 sweep 완료(scout가 입력경계 hardened 확인). 남은 ◦는 not-when/groundedArgs의 incremental 연속뿐 = 고가치 슬라이스 고갈. 가짜 일감 만들기 금지 → 정직 보고가 이번 fire의 산출.
- **리뷰지점:** `backlog.md`(not-when `(orig)` 제거, tool-arg grounding 2항목→1 통합, done-list 정리). 코드 변경 0. (origin 대비 미머지 0 — 진안이 비동기 머지 중, non-blocking 설계대로.)
- **리스크:** 없음. **추천: TOOL 고가치 벤이 말라 새 테마 필요** — 계속 같은 테마면 marginal increment(spotlight query-cap, web_download content-type 등)만 나옴. 다음 fire는 다양성 가드로 그 incremental 중 하나 또는 새 테마.

## fire (TOOL loop) — 2026-06-13 · mac wifi_status read (capability), gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `wifi_status` shell-read source — "와이파이 연결됐어? 어떤 네트워크?"에 답. networksetup(-listallhardwareports→device, -getairportnetwork→파싱) read-only. 행동 테스트(연결/미연결) + eval 읽기-vs-쓰기 디스앰비그.
- **왜:** 보안 벤 고갈 후 capability scout가 발굴 — `mac_system_set`은 wifi 토글만 있고 read 없던 write/read 비대칭(calendar/notes 때와 같은 갭 패턴). value-first 역량·다른 KIND(보안 아님).
- **리뷰지점:** `macos-tools.ts`(parseWifiStatusOutput + wifi_status 브랜치, parseWifiDevice 재사용) + test 2건 + eval 5건. 게이팅 검증자(Opus)가 enum 도달·read-only(-setairportpower는 mac_system_set에 그대로)·읽기/쓰기 디스앰비그·무회귀 PASS.
- **리스크:** 없음. macos 85·lint 0. **scout 정직 노트: 표면 이제 broadly capable → 다음은 테마 전환 권장**(남은 capability 갭은 niche/live-only).

## fire (TOOL loop) — 2026-06-13 · mac ip_address + running_apps reads (배칭) — reader 표면 완성, gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `ip_address`(shell: ipconfig getifaddr) + `running_apps`(osascript: System Events) source 2개 배칭. 8 행동 테스트 + eval 4건. capability scout의 마지막 niche 갭 2개 소진.
- **왜:** real-but-niche 역량(가짜 일감 아님 — busywork 가드는 *지어낸* 일감 금지지 niche 금지가 아님). 진안이 계속 firing = 루프 생산 유지 원함. ip_address는 wifi와 같은 networksetup 패턴이라 배칭.
- **리뷰지점:** `macos-tools.ts`(parseIpAddressOutput shell 브랜치 + running_apps osascript case, parseWifiDevice 재사용) + test 8 + eval 4. 게이팅 검증자(Opus)가 enum 도달·read-only(set은 로컬 문자열)·무회귀 PASS.
- **리스크:** ip_address는 Wi-Fi 디바이스만(Ethernet 제외, 스펙대로). macos 94·lint 0. **mac reader 표면 완성** — capability 갭 소진.
## [TOOL loop] fire 1 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** notes 패밀리 도구선택 커버리지(eval:tools buildNotesScenario 6케이스) + save/append 설명에 use-when/NOT-when 절. 부수로 main의 사전존재 회귀 2건 청소: scout raw-NUL byte-hygiene, SSRF-가드 fallout(web_action reserved-TLD 호스트 테스트 4건).
- **왜:** notes는 not-when 0개 + eval 부재였고, RED 베이스라인(live gemma4 3런)이 실제 save-vs-append 혼동(KO 노트 쓰기 → append 0/3 instead of save)을 드러냄 → 절 추가로 GREEN 12/12 STABLE 3/3. 회귀 2건은 pnpm check가 red여서(quick self-eval은 못 잡음) 커밋 전 필수 정리 — 회귀-우선 원칙.
- **리뷰지점:** loopback-notes.ts(save/append 설명) + eval-tool-selection.mjs(buildNotesScenario+등록) / run-log-analysis.ts:85(raw NUL을 backslash-u0000 escape로) / actuator-tools.ts·commands-approvals.ts(optional lookup DI seam)+테스트 4건. Fable-5 게이팅 검증자 PASS(SSRF: production은 lookup 미주입 → defaultLookup → 가드 무손상; notes 케이스 discriminating + 미과적합). 3 게이트 green: check 0·lint 0·eval notes 12/12.
- **리스크:** buildNotesScenario의 cases.filter(byName.has)는 도구명 drift 시 케이스를 조용히 드롭(검증자 비차단 노트). 남은 not-when 타깃: messaging/episodes/context. grounding floor 무관(설명·테스트·회귀픽스만, 게이트 로직 무변경).


## [TOOL loop] fire 2 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** @muse/calendar의 두 파일 스토어(LocalCalendarProvider, FileCalendarCredentialStore)에 quarantine-on-corrupt 도입 — 손상 파일을 조용히 비우는 대신 <file>.corrupt-<ts>로 보존. 공유 헬퍼 corrupt-quarantine.ts 1개를 4개 corrupt 분기에서 호출.
- **왜:** 손상(파싱실패/스키마불일치) 읽기가 빈 결과를 반환 → 다음 atomic 쓰기가 손상-하지만-복구가능한 원본을 영구 덮어씀 = 데이터 손실. sibling reminders-store는 이미 quarantine. 쓰기는 이미 atomic이라 빠진 건 quarantine뿐.
- **리뷰지점:** corrupt-quarantine.ts(신규 헬퍼) + local-provider.ts readAll(parse catch + events 비배열 분기) + credential-store.ts readAll(스키마불일치 + catch). TDD 3건 RED 3/3 → GREEN, calendar 152, check 0, lint 0. Fable-5 검증자 PASS(ENOENT/transient-IO는 미quarantine, predicate 불변=엄격히 더 안전, rename이 0600 보존, 동시성 안전). 부수로 fire-1 backlog write-back이 박은 raw NUL(backlog.md:63) 제거 — byte-hygiene 회귀.
- **리스크:** local-provider의 per-entry isPersistedEvent flatMap은 여전히 *개별* 손상 이벤트를 조용히 드롭(부분 손실, 로그 없음) — 범위 밖 별도 슬라이스로 backlog 기록. .corrupt-* 파일은 GC 안 됨(복구 자료, 설계상). grounding floor 무관(로컬 디스크 무결성, 모델/egress/게이트 무변경).
## [TOOL loop] fire 3 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** chat 경로의 embedder 마이그레이션 누락 수정 — refreshStaleNotesIndexForChat가 CONTENT 변경만 보고 early-return해, chat-only 사용자(desktop은 ask 안 함)의 레거시 v1 인덱스가 영영 v2-moe 쿼리와 mismatch. 모델 불일치도 staleness 트리거로.
- **왜:** v2-moe 쿼리 벡터를 v1 인덱스에 매칭 = cross-model cosine 노이즈가 0.5 authoritative floor 위로 떠 recall 품질 저하(grounding 품질 버그). ask는 재임베드하지만 chat은 안 했음.
- **리뷰지점:** chat-grounding.ts — 순수 헬퍼 notesIndexNeedsModelMigration(resolveIndexModel(existing,req)!=existing) + refreshStaleNotesIndexForChat을 export+DI deps화(staleness 게이트 前 모델 읽기, modelStale||contentStale로 재임베드). TDD 5(헬퍼 단위 1 + DI 행동 4: legacy-fresh→default 재임베드, default/custom-fresh→안함, content-stale→여전히 함) RED→GREEN. cli 2525, check 0, lint 0. Fable-5 검증자 PASS(매-턴 루프 없음·production 배선 live·fail-soft).
- **리스크:** embedder DOWN 중 model-mismatch 재빌드 시 reindexNotes가 prior-entry carry-forward 드롭 → 빈 인덱스 저장 가능(fail-close: zero hits→refusal, 날조 아님; 기존 경로). 별도 슬라이스로 backlog 기록. grounding floor 무관(인덱싱 경로, 게이트 로직 무변경).


## [TOOL loop] fire 4 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.json.merge의 deepMerge 프로토타입 오염 수정 — 모델 args(JSON.parse)의 own "__proto__" 키가 result["__proto__"]= 할당으로 Object.prototype 셋터를 건드려 result 프로토타입 교체 + 상속 필드(isAdmin 등) 주입 + 키 소실. __proto__만 특수처리: getOwnPropertyDescriptor로 기존값 읽고 deepMerge 후 defineProperty로 own 데이터 prop 기록.
- **왜:** 모델-facing 도구 핸들러의 실제 프로토타입 오염 벡터. signal scout가 clean(0 cluster)이라 tier-2 codebase EXPANSION 스카우트(Fable-5)로 발굴. 큰 리팩터(#6 ask error-path)·architectural(calendar 암호화)·반복(not-when) 회피하고 작고 깨끗한 보안 슬라이스 선택.
- **리뷰지점:** loopback-json-server.ts deepMerge(__proto__ 분기) + mcp.test.ts(JSON.parse'd __proto__ overrides → 프로토타입 무손상 + 주입 필드 없음 + 키 데이터 보존) TDD 1 RED→GREEN. mcp 1679, check 0, lint 0. Fable-5 검증자 PASS(__proto__가 유일 셋터 벡터·constructor/prototype는 plain own·재귀 모든 깊이 보호). 부수로 #6/#7(big refactor)·calendar 암호화(architectural dep)를 ⏳ DEFERRED로 backlog 기록(WHY 명시).
- **리스크:** 없음에 가까움 — 정상 merge 의미 불변(키 strict 매칭), __proto__ 키를 충실히 데이터로 보존. grounding floor 무관(JSON 유틸 도구, 게이트 무변경). DEFERRED 2건은 다음 fire가 재선택 안 하도록 사유 기록.


## [TOOL loop] fire 5 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.fs.stat의 symlink 계약 위반 수정 — 설명은 "symlink를 안 따르고 kind=symlink 보고"인데 fsLib.stat(따라감)을 써 절대 symlink로 못 냄. fs seam에 optional lstat 추가 + 기본 impl 배선 + 도구가 (fsLib.lstat ?? fsLib.stat) 사용.
- **왜:** 모델-facing 도구의 문서화된 계약이 충족 불가였음(symlink가 항상 target의 kind로 보고). fire-4 EXPANSION 스카우트의 runner-up. signal 보드 clean이라 codebase 갭.
- **리뷰지점:** loopback-filesystem.ts(lstat seam + 기본 + stat 도구 1줄) + loopback-filesystem.test.ts(lstat→isSymbolicLink → kind=symlink vs stat-follow → file) TDD 1 RED→GREEN. mcp 1680, check 0, lint 0. Fable-5 검증자 PASS(HEAD 샌드박스 컴파일로 RED 재현·realpath escape 가드 무손상·read/list 무변경). lexical path에 lstat이라 escape 가드는 stat 전에 이미 실행됨.
- **리스크:** read/list는 여전히 lexical path에서 symlink를 따름(설계상; realpath 가드가 escape 차단하나 symlink-swap TOCTOU 창 잔존 → 별도 슬라이스 backlog). runner-up atomicWriteFile tmp 누수 OPEN. grounding floor 무관(fs 메타 도구, 게이트 무변경).


## [TOOL loop] fire 6 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** atomicWriteFile(공유 sidecar-store 쓰기 프리미티브)의 tmp 누수 수정 — open→write→rename 중 어디서든 실패하면 <file>.tmp-<pid>-<uuid>가 고아로 남아 모든 sidecar 디렉터리(memory/tasks/reminders/action-log/…)에 litter 누적. open→write→rename→chmod를 try/catch로 감싸 실패 시 fs.rm(tmp,{force}) 후 원본 에러 rethrow.
- **왜:** 리소스 누수(디스크 litter) — fire-4/5 EXPANSION 스카우트의 마지막 runner-up. signal 보드 clean이라 codebase 갭.
- **리뷰지점:** atomic-file-store.ts(try/catch + rm) + atomic-file-store.test.ts(target=디렉터리→rename throw→rejection AND .tmp- 0개). TDD 1 RED→GREEN. mcp 1681, check 0, lint 0. Fable-5 검증자 PASS(HEAD 소스 swap으로 RED 재현·원본 에러 미swallow·UUID라 cross-writer race 없음). 비차단 노트: finally의 close()가 throw하면 writeFile 에러를 가릴 수 있음(기존 JS 의미, 본 수정과 무관).
- **리스크:** 없음에 가까움 — happy path 무변경, rm은 이 호출의 tmp만(UUID), force라 open 실패 시 no-op. grounding floor 무관(파일 IO 프리미티브, 게이트 무변경).
## [TOOL loop] fire 7 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** 새 v1.11.2 DECOMPOSE-ON-DEFER 가드를 deferred 빅아이템 #6(ask error-path run-log)에 적용 — 4개 loop-sized 슬라이스(6a/6b/6c/6d)로 쪼개 backlog 기록 + 슬라이스 6a ship: 공유 buildAskRunLog 빌더(success/failure payload) 추출 + 성공 경로 배선.
- **왜:** 최근 3 fire가 모두 scout 보안버그 同KIND라 다양성 가드상 다른 KIND 필요 + 내 v1.11.0 평가의 "큰 항목 rot" 발견을 새 가드로 직접 처방(defer→decompose 파이프라인). #6 핵심(실패 trace)은 ~2000줄 본문 wrap이라 6b를 전용 fire로 정직히 사이징.
- **리뷰지점:** program-helpers.ts(buildAskRunLog: success/failure 단일 소스) + commands-ask.ts:3734(성공 경로 배선, byte-identical) + program-helpers.test.ts(3 케이스: success payload·failure success:false+error·confidence/error omit) RED→GREEN. backlog #6 분해(6b=2000줄 body extract 전용 fire, 6c=Ctrl-C abort, 6d=chat-repl parity, exact seam). cli 2528·check 0·lint 0. Fable-5 검증자 PASS(성공 written JSONL byte-identical·분해 actionable).
- **리스크:** 6a의 failure 분기는 테스트됐으나 6b가 catch를 배선하기 전까진 미호출(inert 아님 — 성공 경로는 live, backlog가 6b를 명시). RATCHET: testFiles 888 무변동(기존 파일에 +3 케이스), fabrication 0 유지, decompose-enablement 진척. grounding floor 무관(run-log payload 빌더, 게이트 무변경).


## [TOOL loop] fire 8 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** #6 슬라이스 6d — chat-repl 실패 run의 trace 소실 수정. createTuiChatSubmitter가 happy-path에서만 run-log를 썼는데, runner(runLocalChat/apiRequest)가 throw하면 trace 전무. 주입가능 runChat 파라미터(기본=실제 dispatch) + try/catch로 success:false 엔트리 기록 후 원본 에러 re-throw.
- **왜:** 실패 chat run = error-analysis 연료인데 소실됐음(#6의 chat판). 다양성 가드: 최근 보안×3+decompose×1이라 behavioral-observability fix로 KIND 전환. chat 핸들러는 작은 함수라 6b의 2000줄 추출 없이 직접 wrap 가능 → 6b와 독립.
- **리뷰지점:** chat-repl.ts createTuiChatSubmitter(DI runner + 실패 try/catch, source 호이스트) + chat-repl.test.ts(throwing runner → .muse/runs에 success:false trace + 원본 re-throw; success 경로 무회귀) RED→GREEN. cli 2530, check 0, lint 0. Fable-5 검증자 PASS(성공 경로 byte-identical·double-log 없음·default 비inert).
- **리스크:** 거의 없음 — 추가 관측만(실패 trace), 성공 경로 불변, .catch로 로그 실패가 원본 에러 안 가림. RATCHET: testFiles 888 무변동(+2 케이스), fabrication 0 유지. #6 family는 6a(빌더)+6d(chat) Done; 6b(ask body wrap, 전용 fire)+6c(abort) OPEN. grounding floor 무관.


## [TOOL loop] fire 9 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.math.evaluate의 parseNumber가 다중-dot 숫자("1.2.3")를 parseFloat로 1.2로 조용히 절단 → "1.2.3 * 100"이 120 반환. 1줄 수정: parseFloat → strict Number (NaN→기존 throw).
- **왜:** 이 도구의 전체 계약이 "8B가 못 하는 정확한 계산"인데 틀린 숫자가 모델 검증 없이 사용자 답으로 흐름(shared core라 ask/chat arithmetic fast-path까지). EXPANSION 스카웃 발굴. 다양성: 보안×3→decompose→observability 다음 parsing-correctness로 KIND 다양.
- **리뷰지점:** loopback-math-server.ts:163(parseFloat→Number) + mcp.test.ts(다중-dot→error + 5./.5 컨트롤) RED→GREEN. mcp 1687, check 0, lint 0. Fable-5 검증자 PASS(유효 입력 무회귀 node-검증·shared core 도달·1..2도 수정). runner-up(json.query 프로토타입-체인 walk → Object.hasOwn)을 새 ◦로 backlog 기록.
- **리스크:** 없음에 가까움 — Number는 parseFloat보다 엄격하나 parseNumber가 이미 digits/dots만 통과시켜 다중-dot 외 발산 없음(검증됨). RATCHET: testFiles 888 무변동(+1 케이스), fabrication 0 유지. grounding floor 무관(산술 파서 correctness, 게이트 무변경).


## [TOOL loop] fire 10 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** (1) v1.11.2 §4.5-5 JUDGE 실패-드릴(~10 fire cadence): 고의 나쁜 슬라이스(json.query에 plausible-but-WRONG fix `in && value!==undefined` + non-discriminating 테스트) 주입 → Fable-5 게이팅 검증자가 정확히 FAIL(라이브 실행으로 constructor 여전히 통과 적발 + 테스트 비변별 적발 + secondary defect까지 발견) → git restore 롤백 검증. (2) 검증자가 권고한 올바른 fix를 실제 ship: muse.json.query의 `key in cursor`(프로토타입 체인 walk) → `Object.hasOwn`.
- **왜:** judge 신뢰도 측정(내 평가의 "9/9 PASS가 worker-good인지 judge-soft인지 불명" 발견 처리 → worker-good 확인). 그리고 json.query가 `constructor`/`__proto__`/`toString` 경로로 상속 값(함수/Object.prototype)을 tool 결과로 누출하던 실 보안버그(fire-4 __proto__ merge의 sibling) 수정. 드릴은 롤백되니 sweep 문제도 회피.
- **리뷰지점:** loopback-json-server.ts:88(in→Object.hasOwn) + mcp.test.ts(constructor/__proto__/toString/hasOwnProperty→found:false + own-key positive, discriminating) RED→GREEN. mcp 1688, check 0, lint 0. Fable-5 검증자: 드릴 슬라이스 FAIL(정확) + 실제 fix PASS(walk 닫힘·무회귀·null-proto 안전).
- **리스크:** 없음에 가까움 — array 분기 무변경, 정상 own 키·JSON.parse'd own __proto__ 데이터 키 정상 resolve(value-agnostic). RATCHET: testFiles 888 무변동(+1 케이스), fabrication 0 유지, JUDGE PASS-rate 드릴 1/1(나쁜 슬라이스 정확히 FAIL). grounding floor 무관(JSON 유틸 보안, 게이트 무변경).
## [TOOL loop] fire 11 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.calendar.add의 time-only endsAt("4pm"/"오후 4시")가 start의 날이 아니라 오늘에 anchor → not-today 이벤트 + 구어체 종료시간이 INVALID_TIME_RANGE로 거부. 1식 수정: time-only endsAt를 startOfLocalDay(startsAt)에 anchor (sibling update 패턴 mirror).
- **왜:** 캘린더 add는 핵심 actuator인데 "내일 3시~4시" 같은 흔한 입력이 실패. EXPANSION 스카웃이 EN+KO 라이브 확인. 다양성: 최근 보안/parsing/json 다음 date-anchoring correctness(actuator)로 KIND 전환. 검증된 sibling 패턴 재사용.
- **리뷰지점:** loopback-calendar.ts:269(time-only endsAt anchor) + loopback-calendar-add-anchor.test.ts(provider-가드 흉내 registry로 EN+KO end-to-end: end on start's day 16:00, no error) RED→GREEN. mcp 1694, check 0, lint 0. Fable-5 검증자 PASS(부재/date-bearing/ISO endsAt 무회귀·guard 무손상·update old-day 버그 없음). runner-up 2개(update cross-day endsAt OLD-day anchor, "this weekend" on Sat→today) backlog 기록.
- **리스크:** 없음에 가까움 — time-only 분기만 변경, 다른 endsAt 형태 byte-identical. RATCHET: testFiles 888→889(+1 파일), fabrication 0 유지. grounding floor 무관(캘린더 날짜-anchoring, 게이트 무변경).


## [TOOL loop] fire 12 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.calendar.update의 time-only endsAt가 이벤트의 ORIGINAL 날에 anchor → "월요일로 옮기고 5시까지"가 end를 옛 날에 떨어뜨림. fix: endAnchorDay = newStartsAt ?? event.startsAt — start가 이동하면 end도 NEW 날 따라감. fire-11 add fix의 sibling(runner-up).
- **왜:** add(fire 11)·update가 같은 endsAt-anchoring 버그 가족 — add는 고쳤으나 update는 cross-day 이동 시 여전히 OLD 날. 캘린더 reschedule은 핵심 actuator. 검증된 패턴으로 가족 완성.
- **리뷰지점:** loopback-calendar.ts:365(endAnchorDay로 endsAt anchor) + loopback-calendar-add-anchor.test.ts(Jan-10 이벤트를 June-20 ISO+"5pm"으로 이동 → end가 June 20 17:00, Jan 아님) RED→GREEN. mcp 1695, check 0, lint 0. Fable-5 검증자 PASS(only-endsAt/date-bearing/absent 무회귀·start anchorFor 무손상·over-correction 없음).
- **리스크:** 없음에 가까움 — moved-time-only endsAt 분기만 변경, 나머지 byte-identical. RATCHET: testFiles 893 무변동(+1 케이스), fabrication 0 유지. 남은 runner-up: "this weekend" on Sat→today. grounding floor 무관(캘린더 날짜-anchoring, 게이트 무변경).


## [TOOL loop] fire 13 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.url.parse가 query map을 프로토타입 보유 {}로 생성 → 공격자 제어 URL의 __proto__/constructor 쿼리 파라미터가 조용히 소실/오염(프로토타입 오염 + dedup corruption). 1줄 fix: Object.create(null) (null-proto map, 모든 키가 own data).
- **왜:** fire-4 json.merge __proto__의 sibling을 URL 표면에서 발견(라이브 확인). 다양성: fire 11/12 캘린더 다음 non-calendar 보안 표면(URL 파싱)으로 전환. EXPANSION 스카웃.
- **리뷰지점:** loopback-url-server.ts:29(query map Object.create(null)) + mcp.test.ts(__proto__=a→own "a", constructor=c→"c", x="1") RED→GREEN. mcp 1696, check 0, lint 0. Fable-5 검증자 PASS(dedup string/array 무회귀·JSON이 null-proto own 키 직렬화·downstream 구조 소비자 없음·node로 양쪽 의미 실행 확인). runner-up 2개(text.stats whitespace-only lie, url.encode_query [object Object]) backlog 기록.
- **리스크:** 없음에 가까움 — null-proto map은 정상 키/dedup 동일, JSON 직렬화 정상. RATCHET: testFiles 893 무변동(+1 케이스), fabrication 0 유지. grounding floor 무관(URL 파서 보안, 게이트 무변경).


## [TOOL loop] fire 14 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.url.encode_query가 중첩 객체 값을 String(raw)로 "[object Object]"로 조용히 인코딩(silent corruption). isScalar 가드 추가 — 비-scalar 값/배열 아이템은 {error: must be string/number/boolean}. scalar/scalar-array/null-skip 무변경.
- **왜:** fire-13 runner-up. 다른 표면(url.encode_query)·다른 KIND(input-validation/silent-corruption). 처음 후보였던 text.stats whitespace→zero는 기존 테스트가 "treats whitespace as zero"로 의도 문서화 → clean 버그 아님(진안 판단으로 ⏳ defer); encode_query의 "[object Object]"는 incidental characterization이라 fix 적합.
- **리뷰지점:** loopback-url-server.ts(isScalar 가드) + mcp.test.ts(중첩객체+배열내객체→error, scalar 컨트롤) + loopback-url.test.ts(incidental obj 케이스를 error 기대로 갱신) RED→GREEN. mcp 1697, check 0(stale-dist 재실행 후), lint 0. Fable-5 검증자 PASS(기존 테스트 변경 LEGITIMATE 판정·커버리지 강화·scalar 무회귀).
- **리스크:** 없음에 가까움 — scalar/배열/null skip byte-identical, 객체만 거부. RATCHET: testFiles 893 무변동(+1 케이스, 1 갱신), fabrication 0 유지. grounding floor 무관(URL 인코더 입력검증, 게이트 무변경).


## [TOOL loop] fire 15 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** web_download가 plain writeFile(flag "w")로 Downloads의 동명 기존 파일을 조용히 덮어씀(되돌릴 수 없는 데이터 손실). writeNonClobbering 헬퍼 — 브라우저처럼 dedupe(name (1).ext) + wx flag(atomic, no TOCTOU). 실 쓰기에러는 re-throw, 1000 바운드.
- **왜:** AppWorld "collateral damage"(무관 사용자 파일 무경고 파괴). 모듈 헤더는 fail-closed 디스크 약속. EXPANSION 스카웃 라이브 확인. 다양성: 최근 url×2/calendar×2 다음 web_download data-integrity로 표면 전환.
- **리뷰지점:** web-download-tool.ts(writeNonClobbering 헬퍼 + execute 배선) + web-download-tool.test.ts(기존 report.pdf 보존 + 새 바이트 "report (1).pdf") RED→GREEN. mcp 1698, check 0, lint 0. Fable-5 검증자 PASS(5 동시→5 고유·fresh-dir 원래이름·실에러 re-throw·엣지케이스). runner-up 2개(전체 바디 버퍼링 後 size-cap → 메모리 고갈, tasks.update lost-update TOCTOU) backlog 기록.
- **리스크:** 없음에 가까움 — fresh dir은 원래 이름 그대로, dedupe는 충돌 시만. RATCHET: testFiles 893 무변동(+1 케이스), fabrication 0 유지. grounding floor 무관(다운로드 디스크 안전, 게이트 무변경).


## [TOOL loop] fire 16 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.tasks.update가 전체 stale 스냅샷({...tasks[index]})을 write 큐 밖에서 만들어 그대로 써서, 다른 필드를 바꾸는 두 동시 update가 lost-update(last-writer-wins). fix: 필드-레벨 DELTA(sets/clears) 만들어 mutate 콜백 안에서 fresh current[i]에 재적용(complete 패턴 mirror).
- **왜:** fire-15 runner-up. 다른 표면(tasks store)·concurrency KIND. complete는 이미 delta 재적용으로 옳게 하는데 update만 누락. τ-bench "no partial side-effects"/AppWorld collateral-damage 클래스.
- **리뷰지점:** loopback-tasks.ts(patched 전체쓰기 → applyDelta(sets/clears) 재적용) + mcp.test.ts(title+notes 동시 update 둘 다 tasks.json에 persist) RED→GREEN. mcp 1699, check 0(flaky cli chat-grounding 재실행 후·무관), lint 0. Fable-5 검증자 PASS(single-update 1:1 무회귀·applyDelta set-XOR-clear·vanished-task 엣지·/tmp worktree로 RED 재현). 잔여: partial dueAt reschedule이 stale existing-due에 anchor(같은-필드 race만, 수용·pre-existing).
- **리스크:** 없음에 가까움 — single-update 의미 byte-identical, 타 필드 보존. RATCHET: testFiles 893 무변동(+1 케이스), fabrication 0 유지. grounding floor 무관(tasks store 동시성, 게이트 무변경).


## [TOOL loop] fire 17 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** web_download가 전체 응답 바디를 arrayBuffer()로 버퍼링 後 size-cap 검사 → multi-GB/무한 바디가 cap 무시하고 RAM 채움(memory-exhaustion DoS). fix: Content-Length 사전검사 + getReader() 스트리밍 읽기로 누적 크기가 cap 넘는 순간 reader.cancel()+거부.
- **왜:** fire-15 runner-up. 다른 KIND(resource-exhaustion/DoS, fire15 overwrite·fire16 concurrency와 구별). 서버가 CL 거짓/생략 가능하니 스트리밍 abort가 실 방어.
- **리뷰지점:** web-download-tool.ts(CL 사전검사 + getReader 스트림 + 조기 abort + no-body fallback) + web-download-tool.test.ts(계측 20×100B 스트림, cap 250B → ~3청크 後 abort, 미작성) RED→GREEN. mcp 1700, check 0(flaky cli 재실행 후), lint 0. Fable-5 검증자 PASS(under-cap byte-identical·absent/garbage CL 오거부 없음·HEAD 21 pull 재현으로 RED 확인).
- **리스크:** 없음에 가까움 — under-cap 다운로드는 스트림 재조립이 byte-identical, CL 0/NaN은 스트림으로 폴스루. RATCHET: testFiles 893 무변동(+1 케이스), fabrication 0 유지. 부수: 2 fire 연속 flaky cli 테스트(chat-grounding "fails soft") ⏳ backlog 기록. grounding floor 무관(다운로드 자원안전, 게이트 무변경).


## [TOOL loop] fire 18 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening (loop self-hardening)

- **무엇:** 내 게이트를 fire 16·17 연속 망친 flaky cli 테스트(chat-grounding "fails soft when retrieval throws")를 hermetic하게 수정. retrieveChatGrounding/groundChatTurn에 주입가능 searchRecall DI seam(production 기본=실제 recall) 추가; 테스트는 sync-throwing recall 주입 + MUSE_CHAT_AUTO_REINDEX=0 → 무네트워크.
- **왜:** 옛 테스트는 OLLAMA_BASE_URL을 unreachable 포트로 가리키고 embed 재시도 backoff(~5s)에 의존 → vitest 5000ms 기본 타임아웃 경계(5159ms)에서 flake. 루프 자체 하드닝(게이트 신뢰성). 다른 KIND(테스트 hermeticity).
- **리뷰지점:** chat-grounding.ts(searchRecall? opt + opts.searchRecall ?? searchRecall) + chat-grounding.test.ts(주입 throw + reindex off, called===true 단언) — production 무변경. cli 2530, check 0(첫 시도 통과·더 이상 flake 안 함), lint 0. Fable-5 검증자 PASS(production recall 동일·fail-soft 여전히 검증·23ms로 빨라짐·strictly stronger 커버리지).
- **리스크:** 없음 — DI seam은 test-only(production 호출부 미주입), 타입 sound. RATCHET: testFiles 893 무변동(테스트 1개 hermetic화), fabrication 0 유지, **게이트 flake 제거**(2 fire 낭비 종결). grounding floor 무관(테스트 인프라).


## [TOOL loop] fire 19 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** add_contact "Add (or update)"가 재추가 시 항상 새 id로 중복 생성 → 이름이 영영 ambiguous(remove도 불가) → outbound-safety rule 3 영구 위반. fix: optional contacts 리더 추가, 이름 매치 시 기존 id 재사용+필드 병합(id-idempotent save가 REPLACE). 양쪽 production seam 배선(commands-ask는 raw writeContacts→store addContact로도 변경).
- **왜:** fresh 표면(contacts). 데이터 무결성 + 수신자-해결 영구 손상(outbound-safety 핵심). EXPANSION 스카웃 라이브 확인. 다른 KIND(중복/upsert).
- **리뷰지점:** contacts-tool.ts(contacts? 리더 + 이름매치 id재사용+merge) + autoconfigure:710(리더 추가) + commands-ask:2658(raw append→addContact+리더) + contacts-tool.test.ts(재추가 id재사용+merge, case-insensitive, no-reader back-compat) RED→GREEN. mcp 1703, check 0, lint 0. Fable-5 검증자 PASS(back-compat 7 테스트 무회귀·양쪽 seam live·merge 필드드롭 불가·HEAD length 2 재현). 스카웃 "테스트 없음" 정정(있었으나 중복을 의도 문서화 안 함).
- **리스크:** 없음에 가까움 — 리더 없으면 old 동작(optional dep). 잔여(비차단): exact-name-only(alias 재추가는 중복 가능), commands-ask read→save 비원자(save만 큐). RATCHET: testFiles 893 무변동(+3 케이스), fabrication 0 유지. runner-up(crypto base64/hex U+FFFD) 기록. grounding floor 무관(contacts upsert, 게이트 무변경).
## [TOOL loop] fire 7 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** 새 v1.11.2 DECOMPOSE-ON-DEFER 가드를 deferred 빅아이템 #6(ask error-path run-log)에 적용 — 4개 loop-sized 슬라이스(6a/6b/6c/6d)로 쪼개 backlog 기록 + 슬라이스 6a ship: 공유 buildAskRunLog 빌더(success/failure payload) 추출 + 성공 경로 배선.
- **왜:** 최근 3 fire가 모두 scout 보안버그 同KIND라 다양성 가드상 다른 KIND 필요 + 내 v1.11.0 평가의 "큰 항목 rot" 발견을 새 가드로 직접 처방(defer→decompose 파이프라인). #6 핵심(실패 trace)은 ~2000줄 본문 wrap이라 6b를 전용 fire로 정직히 사이징.
- **리뷰지점:** program-helpers.ts(buildAskRunLog: success/failure 단일 소스) + commands-ask.ts:3734(성공 경로 배선, byte-identical) + program-helpers.test.ts(3 케이스: success payload·failure success:false+error·confidence/error omit) RED→GREEN. backlog #6 분해(6b=2000줄 body extract 전용 fire, 6c=Ctrl-C abort, 6d=chat-repl parity, exact seam). cli 2528·check 0·lint 0. Fable-5 검증자 PASS(성공 written JSONL byte-identical·분해 actionable).
- **리스크:** 6a의 failure 분기는 테스트됐으나 6b가 catch를 배선하기 전까진 미호출(inert 아님 — 성공 경로는 live, backlog가 6b를 명시). RATCHET: testFiles 888 무변동(기존 파일에 +3 케이스), fabrication 0 유지, decompose-enablement 진척. grounding floor 무관(run-log payload 빌더, 게이트 무변경).


## [TOOL loop] fire 8 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** #6 슬라이스 6d — chat-repl 실패 run의 trace 소실 수정. createTuiChatSubmitter가 happy-path에서만 run-log를 썼는데, runner(runLocalChat/apiRequest)가 throw하면 trace 전무. 주입가능 runChat 파라미터(기본=실제 dispatch) + try/catch로 success:false 엔트리 기록 후 원본 에러 re-throw.
- **왜:** 실패 chat run = error-analysis 연료인데 소실됐음(#6의 chat판). 다양성 가드: 최근 보안×3+decompose×1이라 behavioral-observability fix로 KIND 전환. chat 핸들러는 작은 함수라 6b의 2000줄 추출 없이 직접 wrap 가능 → 6b와 독립.
- **리뷰지점:** chat-repl.ts createTuiChatSubmitter(DI runner + 실패 try/catch, source 호이스트) + chat-repl.test.ts(throwing runner → .muse/runs에 success:false trace + 원본 re-throw; success 경로 무회귀) RED→GREEN. cli 2530, check 0, lint 0. Fable-5 검증자 PASS(성공 경로 byte-identical·double-log 없음·default 비inert).
- **리스크:** 거의 없음 — 추가 관측만(실패 trace), 성공 경로 불변, .catch로 로그 실패가 원본 에러 안 가림. RATCHET: testFiles 888 무변동(+2 케이스), fabrication 0 유지. #6 family는 6a(빌더)+6d(chat) Done; 6b(ask body wrap, 전용 fire)+6c(abort) OPEN. grounding floor 무관.


## [TOOL loop] fire 9 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.math.evaluate의 parseNumber가 다중-dot 숫자("1.2.3")를 parseFloat로 1.2로 조용히 절단 → "1.2.3 * 100"이 120 반환. 1줄 수정: parseFloat → strict Number (NaN→기존 throw).
- **왜:** 이 도구의 전체 계약이 "8B가 못 하는 정확한 계산"인데 틀린 숫자가 모델 검증 없이 사용자 답으로 흐름(shared core라 ask/chat arithmetic fast-path까지). EXPANSION 스카웃 발굴. 다양성: 보안×3→decompose→observability 다음 parsing-correctness로 KIND 다양.
- **리뷰지점:** loopback-math-server.ts:163(parseFloat→Number) + mcp.test.ts(다중-dot→error + 5./.5 컨트롤) RED→GREEN. mcp 1687, check 0, lint 0. Fable-5 검증자 PASS(유효 입력 무회귀 node-검증·shared core 도달·1..2도 수정). runner-up(json.query 프로토타입-체인 walk → Object.hasOwn)을 새 ◦로 backlog 기록.
- **리스크:** 없음에 가까움 — Number는 parseFloat보다 엄격하나 parseNumber가 이미 digits/dots만 통과시켜 다중-dot 외 발산 없음(검증됨). RATCHET: testFiles 888 무변동(+1 케이스), fabrication 0 유지. grounding floor 무관(산술 파서 correctness, 게이트 무변경).

## [TOOL loop] fire 20 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.crypto base64/hex decode가 valid-format이지만 비-UTF-8 바이트(binary, 0xFF 등)를 toString("utf8")로 U+FFFD 무성 치환 → garbled 텍스트 무신호. decodeBytesAsUtf8 헬퍼로 re-encode 라운드트립 불일치 감지 → error. base64/hex 둘 다 사용.
- **왜:** fire-19 runner-up. 도구 설명은 "decode back to UTF-8"인데 binary 입력이 조용히 corrupt. 기존 테스트(1102)가 이미 "malformed → garbled 거부" 하드닝 철학 명시 → 비-UTF-8 바이트에도 동일 적용(의도 문서화 아님). 다른 표면(crypto)·silent-corruption KIND.
- **리뷰지점:** loopback-crypto.ts(decodeBytesAsUtf8 헬퍼 + base64/hex decode 양쪽) + mcp.test.ts("/w=="=0xFF base64, "ff"=0xFF hex → error; emoji/héllo/empty 라운드트립) RED→GREEN. mcp 1709, check 0, lint 0. Fable-5 검증자 PASS(유효 UTF-8 false-reject 없음·emoji/NUL/BOM/literal-U+FFFD 경험적 검증·포맷검증 별개 보존·HEAD U+FFFD 재현으로 RED).
- **리스크:** 없음 — UTF-8 encode∘decode는 valid 시퀀스에 항등이라 false-reject 불가, 포맷검증 무변경. RATCHET: testFiles 893 무변동(+1 케이스), fabrication 0 유지. grounding floor 무관(crypto decode 입력검증, 게이트 무변경).


## [TOOL loop] fire 21 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening (judge-drill + ReDoS fix)

- **무엇:** (1) v1.11.2 JUDGE 실패-드릴(~10 fire): muse.regex ReDoS에 narrow `includes("+)+")` 가드(불완전) + non-discriminating 테스트 주입 → Fable-5 검증자가 정확히 FAIL((.*)*/([a-z]+)* 등 통과 적발, hasNestedUnboundedQuantifier 권고) → git restore. (2) 검증자 권고대로 실제 fix: muse.regex compile()에 hasNestedUnboundedQuantifier 가드(@muse/tools barrel export) — test/match/replace 모두.
- **왜:** muse.regex가 nested-unbounded-quantifier 패턴((a+)+ 등)을 동기 실행 → 전체 프로세스 무한 행(SIGKILL 필요). regex_extract는 이미 가드, loopback은 미적용(same-class-different-surface). + judge 신뢰도 측정(드릴 2/2). 'this weekend' semantic 모호성은 ⏳ 진안.
- **리뷰지점:** tools/index.ts(barrel export) + loopback-regex.ts compile()(가드, new RegExp 前) + loopback-regex.test.ts(6 shape ×3 도구 거부 + benign, SHORT 텍스트라 무행) RED→GREEN. mcp 1716, check 0, lint 0. Fable-5: 드릴 narrow fix FAIL(정확) + 실제 fix PASS(클래스 닫힘·benign false-positive 없음·discriminating).
- **리스크:** 없음에 가까움 — benign 패턴 false-positive 없음(검증), overlapping-alternation((a|ab)+)은 helper docstring상 범위 밖(기존과 동일). RATCHET: testFiles 893 무변동(+테스트), fabrication 0 유지, JUDGE drill 2/2. grounding floor 무관(regex DoS 가드, 게이트 무변경).


## [TOOL loop] fire 22 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.episode list/search의 `total`이 post-limit slice 카운트라 실제 store 크기를 거짓 보고(50개 중 limit 10 → total:10). reminders 컨벤션(total=pre-slice, shown=post-slice)으로 — sort 먼저, shownList=slice, total=scoped.length/matches.length(pre-slice), shown 추가.
- **왜:** fire-21 runner-up. 모델이 "에피소드가 몇 개인지" 오인. 다른 표면(episodes)·misleading-value KIND. 기존 테스트의 buggy total=1은 incidental characterization(reminders 컨벤션이 repo 표준)이라 갱신 적합.
- **리뷰지점:** loopback-episodes.ts(list+search total=pre-slice, shown 추가) + loopback-episodes-list-total.test.ts(3 eps, limit 2 → total 3·shown 2) + mcp.test.ts(기존 limited.total 1→3, shown 1) RED→GREEN. mcp 1718, check 0(flaky @muse/model fuzz 재실행 후·무관), lint 0. Fable-5 검증자 PASS(total pre-slice·episode 7/7 무회귀·기존-테스트 변경 LEGITIMATE·llm-judge 분기 수용). 잔여: llm-judge 분기 shown 없음(1필드 후속).
- **리스크:** 없음에 가까움 — return shape에 shown 추가 + total 의미 수정만, 정렬/필터/limit 무변경. RATCHET: testFiles 895→896(+1 파일), fabrication 0 유지. 부수: @muse/model web-search-policy property-fuzz가 1회 flaky(⏳ backlog 기록·seed 고정 필요). grounding floor 무관(episodes list 값-정확성, 게이트 무변경).


## [TOOL loop] fire 23 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.search의 DuckDuckGo 리다이렉트 언랩이 이중 디코드 — decodeDuckDuckGoRedirect(loopback-search.ts:369)가 URLSearchParams.get("uddg")(이미 1회 퍼센트-디코드한 값)에 decodeURIComponent를 또 적용. 리터럴 %20(DDG는 %2520로 전송)을 공백으로 손상시키고, 결과 URL의 맨몸 %(예 100%-off)에서 URIError throw. 수정: 잉여 디코드 제거(return target ? target : raw).
- **왜:** EXPANSION 코드 gap-scout(신호 스카웃 clean) — data-integrity + fail-open-to-crash. parseDuckDuckGoHtml는 execute()의 fetch try/catch가 닫힌 뒤(191) 호출되어 URIError가 execute()를 탈출 → 공격자-영향 결과 URL 하나로 muse.search 전체 크래시. 다른 표면(search/DDG)·다른 KIND(double-decode)로 다양성. 부수: web-search-policy "fuzz" ⏳를 결정적 fixed-corpus 테스트(fire-22 실패=환경적)로 조사·Closed.
- **리뷰지점:** loopback-search.ts:369(이중 디코드 제거+WHY 코멘트) + parse-duckduckgo-html.test.ts(리터럴 %20 보존 + 맨몸 % no-throw 2케이스) RED(맨몸 % 케이스 URIError 관측)→GREEN 9/9. mcp 1720, check 0(cli/api green; mcp 격리 184파일 재실행 green — playbook-store 5000ms는 동시-루프 env flake), lint 0. Fable-5 PASS: src만 stash해 RED 독립 재확인, get() 1회 디코드 기계검증, 합법적 이중인코딩 경로 없음(DDG는 encodeURIComponent로 1회 인코딩).
- **리스크:** 없음에 가까움 — 잉여 디코드 1줄 제거만, 기존 redirect 테스트(single-pass uddg, 둘째 디코드 idempotent) 무회귀; 빈-문자열 target truthiness 동일. RATCHET: testFiles 896 무변동(기존 테스트 파일에 2케이스 추가), fabrication 0 유지. grounding floor 무관(search 결과 URL 무결성·게이트 무변경).


## [TOOL loop] fire 24 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.status.notes_index 도구 계약 드리프트 — description은 "relative path + size 반환"을 약속하나 execute는 파일당 `{name}`만 반환, size 침묵 누락. fileSize 헬퍼(기존, stat 실패시 undefined→TOCTOU-robust)로 `{name, size}` 반환(map→Promise.all).
- **왜:** EXPANSION 코드 gap-scout(신호 clean) — 도구가 자기 description보다 적게 반환 = 계약 거짓말. 모델은 이 도구로 "embed/search 결정"을 하라는데 그 판단의 핵심 신호(size=임베딩 비용)가 빠져 무용. 다른 표면(status)·다른 KIND(contract-output-drift)로 다양성(최근: regex DoS/episode total/DDG crash). TOP PICK였던 tasks.search total은 fire-22 episode total과 동일 KIND라 회피→backlog ◦ 기록.
- **리뷰지점:** loopback-status.ts:286-293(`{name,size}` + Promise.all + WHY 코멘트) + mcp.test.ts "muse.status loopback server"에 1케이스(5+6 byte .md 2개 → size===byte length) RED(size undefined)→GREEN. mcp 1721, check 0(전 패키지 green: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: src만 stash해 RED 독립 재확인, héllo=6byte 검증, total/error-path 무변경, 타 테스트가 옛 shape 미고정(도구 출력 무테스트였음).
- **리스크:** 없음에 가까움 — 출력에 size 추가 + 동기 map→async Promise.all만, total=file count·readdir-throw 에러경로 무변경, size:undefined는 JSON.stringify에서 드롭(benign). RATCHET: testFiles 896 무변동(기존 파일에 1케이스), fabrication 0 유지. nit(non-blocking): 기존 `as unknown as JsonValue` 캐스트가 size?를 가림(기존부터)·TOCTOU-undefined 분기 무테스트. grounding floor 무관(도구 출력 완전성, 게이트 무변경).


## [TOOL loop] fire 25 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** resolveRelativeTimePhrase의 bare day-of-month("the 31st") 롤이 JS Date 월-오버플로로 조용히 틀린 날짜 반환 — Jan 31 늦은밤 "the 31st" → new Date(2026,1,31)=Feb 31→March 3(March 31 아님). 단일 +1월 롤(재검증 없음)을 bounded 루프(ahead 1..12, getDate===dom && future 재확인)로 교체, 최종 가드 `getDate===dom ? finiteDate : undefined`.
- **왜:** EXPANSION 코드 gap-scout(신호 clean) — data-integrity/silent-wrong-value KIND(최근 regex-DoS/episode-total/DDG-crash/notes-contract와 다름; count 버그 아님). 틀린 날짜가 reminder/task로 영속 = 고가치. 주석(527-528)이 이미 "next month that has it"를 약속하나 코드는 1회만 롤. TOP PICK의 sibling 2곳(year-roll feb-29 overflow, en+ko)은 branch 형태가 달라 ◦ 기록(별도 fire).
- **리뷰지점:** loopback-relative-time.ts:537-543(단일 롤→bounded 루프 + WHY 코멘트) + relative-time-period.test.ts(the 31st/30th/29th @ Jan → March 동일일 3케이스) RED(getDate 3≠31)→GREEN. relative-time 44/44, mcp 1722, check 0(전 패키지: agent-core 1831·cli 2535·api 850·tools 242·macos 94·browser 57), lint 0. Fable-5 PASS: src만 stash해 RED 독립 재확인, 루프 종료(12 cap, 매번 fresh new Date라 오버플로 비복합)·first-future-occurrence·최종가드 유효케이스 미거부, 기존 the-25th/the-1st/9am/99th 무회귀, 타 branch 무영향.
- **리스크:** 없음에 가까움 — dayOfMonthMatch 분기만 수정, month-qualified/weekday/duration/Korean 무변경. "the 31st"가 Feb 개입시 March로 건너뜀(Feb 28 clamp 아님)은 계약·sibling 철학과 일치(verifier 확인). RATCHET: testFiles 896 무변동(기존 파일 +1케이스), fabrication 0 유지. 잔여: sibling year-roll 2곳(◦ 기록). grounding floor 무관(시간 파싱 정확성, 게이트 무변경).


## [TOOL loop] fire 26 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** fire-25 date-overflow 클래스의 완성 — resolveAbsoluteMonthDate(en, 230-236)와 koAbsDate(ko, 750-758)의 +1년 롤 두 사이트가 재검증 없이 `new Date(year+1, ...)`. "feb 29"/"2월 29일"이 leap year 후 질의 → non-leap 다음해로 롤 → `new Date(2029,1,29)`=Mar 1 2029 silent overflow(사용자가 요청 안 한 날짜가 reminder/task로 영속). 롤 결과 month/day 재검증해 overflow면 undefined(fail-safe).
- **왜:** fire-25에서 기록한 최상단 ready ◦(최고가치). date-overflow 클래스를 완전히 닫음. 다양성 가드: 최근 3 fire(23 crash·24 contract-drift·25 overflow)가 same-KIND 3연속 아님 → 허용. undefined 반환은 파일의 reject-don't-roll 철학(227 재검증·"2월 30일" 거부·parseTaskDueAt 2026-02-29 거부)과 일관. 다음 leap year(2032, 3+년 후) 해결보다 fail-safe가 덜 놀람.
- **리뷰지점:** loopback-relative-time.ts:230-236(en rolled 재검증 month+date) + 750-758(ko koRolled getMonth 재검증, setHours 前) + WHY 코멘트 2 + relative-time-period.test.ts(en/ko feb-29→undefined + mar-5 valid-roll→2027 무회귀가드) RED(둘 다 2029-03-01)→GREEN 47/47. mcp 1725, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: src만 stash해 RED 독립 재확인, 파일 내 유일한 +1년 롤 2곳·B는 day≤31 pre-validated라 getMonth-only 충분, 413 테스트(3파일) green.
- **리스크:** 없음에 가까움 — 롤 사이트 2곳만 재검증 추가, valid 롤(mar 5→2027) 통과 확인, feb-29 BEFORE(올해 leap) 경로 무변경. RATCHET: testFiles 896 무변동(기존 파일 +3케이스), fabrication 0 유지. 잔여: next-leap 해결은 별도 enhancement(◦ 미생성, 진안 선택). grounding floor 무관(시간 파싱 정확성, 게이트 무변경).


## [TOOL loop] fire 27 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.math#evaluate가 계약상 유효한 탭/개행 식을 조용히 거부 — SAFE_MATH_PATTERN(L13)은 모든 \s 허용하나 토크나이저 skip()이 리터럴 " "만 스킵. "2 *\t3"/"1000\n+ 2000"가 whitelist 통과 후 탭/개행에서 cursor 정체→"expected number"/"trailing characters" throw. skip()을 모든 \s 스킵(/\s/u.test)으로 정렬.
- **왜:** EXPANSION 코드 gap-scout(신호 clean). fire 25·26이 둘 다 date-overflow였어서 다양성 가드상 비-date KIND 필수 → input-validation/whitelist↔tokenizer contract-drift(fresh KIND·표면). math fast-path는 muse ask 정확-산술 경로도 공유 → 붙여넣은 다중라인 합계가 조용히 실패. whitelist 자체는 불변이라 받아들이는 문자 집합 무확대(injection 없음).
- **리뷰지점:** loopback-math-server.ts:174-181(skip() " "→/\s/u + WHY 코멘트) + mcp.test.ts(탭/개행 3케이스 → 6/3000/9, 도구 경로) RED("expected number")→GREEN. mcp 1726, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: src만 stash해 RED 독립 재확인, skip()이 유일 whitespace 지점이라 완전, "1 2"/"1\t2" 여전히 error(숫자 연결 안 됨)·whitelist 불변이라 새 문자 도달 불가, 364 math/file 테스트 green.
- **리스크:** 없음에 가까움 — skip() 1곳만 정렬, 기존 산술(14·div0·1.2.3 거부·5.+.5=5.5) 무회귀, 공백-only 입력 동작 동일(evaluateArithmeticExpression 공유). nit(non-blocking): /\s/u가 NBSP(\u00a0)도 스킵→이제 평가(whitelist \s가 이미 허용했던 것, 의도된 정렬). RATCHET: testFiles 896 무변동(기존 파일 +1케이스), fabrication 0 유지. grounding floor 무관(산술 정확성, 게이트 무변경).


## [TOOL loop] fire 28 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** mac_say argv 플래그-인젝션 — `argv = voice ? ["-v",voice,text] : [text]`로 사용자 text를 첫 positional로 넘겨 `--` 옵션 터미네이터 없음. text가 "-0"/"--version"이면 `say`가 플래그로 재해석(라이브: say "-0"→exit 1 invalid option) → dash-시작 문자열 말하기가 조용히 실패. `["-v",voice,"--",text]`/`["--",text]`로 수정(say는 `--` 지원, mdfind/pbcopy는 미지원이라 say-한정 가드).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). 최근 KIND(date×2·input-validation)와 다른 보안 KIND(argument injection)·fresh 표면(macos). fire-27 runner-up이었고 결정적 테스트 가능(주입 runner seam이 argv 캡처). spotlight는 mdfind가 `--` 거부라 reject(◦ 기록), notes.save TOCTOU는 writer seam 부재로 비결정적 reject(◦ 기록).
- **리뷰지점:** macos-tools.ts:1501-1505(argv에 `--` + WHY 코멘트) + macos-tools.test.ts(leading-dash "-0"/"--version" → argv가 text 앞 `--` 포함, 기존 argv assertion은 새 shape로 갱신=incidental) RED(2 fail)→GREEN. macos 95/95, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: 이 머신에서 `say -- "-0"` exit 0 라이브 독립 검증(취약 실재+fix 정상호출 안 깸), runner seam contract-faithful(spawn·no shell), voice는 -v 값으로 소비라 벡터 아님.
- **리스크:** 없음에 가까움 — argv 1곳 + 기존 테스트 2 assertion 갱신(masked regression 아님, 의도는 "text+voice 전달"), 정상 text 무영향. nit(non-blocking): voice:"?"는 say가 voice 목록 출력 후 exit 0(cosmetic, injection 아님). RATCHET: testFiles 896 무변동(기존 파일 +1케이스), fabrication 0 유지. grounding floor 무관(actuator argv 안전성, 게이트 무변경).


## [TOOL loop] fire 29 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.notes.save TOCTOU 클로버 — stat-then-writeFile이라 stat과 `nodeWriteFile(...,"utf8")`(flag w) 사이에 동시 create가 끼면 overwrite:false인데도 조용히 덮어씀. !overwrite시 create-exclusive(`{encoding:"utf8",flag:"wx"}`)로 써서 stale probe+동시 create→EEXIST→"already exists" 에러(클로버 대신). TOCTOU 창 결정적 테스트 위해 probeExists 주입 옵션 추가(기본=옛 stat 체크와 byte-identical).
- **왜:** fire-28 scout가 비결정적이라 reject·◦로 기록한 항목 — 충실한 결정적 테스트(probe만 주입, 실제 fs wx write로 atomic 보증 검증)를 설계해 해결. data-integrity/TOCTOU KIND(최근 date/input-val/argv-injection과 다름)·fresh 표면(loopback-notes). atomic 보증은 wx에 있고 probe는 UX 메시지/created 플래그만 — "거짓말하는" probe도 클로버 못 일으킴(verifier 확인).
- **리뷰지점:** loopback-notes.ts(probeExists 옵션+바인딩, save 사이트 stat→probeExists + wx 플래그 + EEXIST→already-exists 매핑) + notes-save-toctou.test.ts(absent-probe+실제 기존파일→already exists+content 불변; overwrite:true는 교체) RED(wx 되돌리면 "CLOBBER"로 클로버)→GREEN 2/2. mcp 185파일/1728, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: contract-faithful(가짜 writer 아님), EEXIST 매핑이 !overwrite 한정이라 EACCES는 "cannot write note"로 정상 surface, default probe 옛 동작 보존.
- **리스크:** 없음에 가까움 — !overwrite 경로만 wx, overwrite:true는 여전히 w(의도적 교체), 첫 저장/새 subdir 저장 무영향(verifier 확인). nit(non-blocking): overwrite:true+stale probe시 created 과보고 가능(fix 前 race와 동일, !overwrite에선 created 항상 정확). RATCHET: testFiles 896→897(+1 파일), fabrication 0 유지. grounding floor 무관(노트 쓰기 무결성, 게이트 무변경).


## [TOOL loop] fire 30 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.fs read가 멀티바이트 UTF-8을 절단 경계에서 손상 — `buffer.subarray(0,maxBodyBytes).toString("utf8")`이 cap이 멀티바이트 시퀀스 안에 떨어지면 char 중간을 잘라 U+FFFD 생성. 한국어는 3 bytes/char라 ~2/3 확률로 mid-char → 큰 한국어 노트 꼬리가 깨짐. 순수 헬퍼 utf8SafeSliceEnd(buffer,maxBytes)로 직전 char 경계까지 백오프(10xxxxxx 연속바이트 되감기), read에 배선.
- **왜:** EXPANSION 코드 gap-scout(신호 clean). encoding-boundary KIND(최근 input-val/argv/toctou와 다름)·fresh 표면(loopback-filesystem). 진안이 한국어 사용자 — 한국어 노트 절단 꼬리가 replacement-char 쓰레기로 들어가는 직접 영향 = 고가치. 도구 description은 "Reads a UTF-8 text file" 약속. verifier가 runner-up(loopback-fetch readBodyWithCap 동종)도 지적 → 헬퍼 재사용 ◦ 기록.
- **리뷰지점:** loopback-filesystem.ts(utf8SafeSliceEnd export + read 배선) + loopback-filesystem.test.ts(헬퍼 6 단위: fits/Korean-mid/exact-boundary/4byte-emoji/ASCII-unchanged/non-positive) + mcp.test.ts(e2e: fake-fs "가나다라" maxBodyBytes:8 → "가나"·U+FFFD 없음) RED(배선 되돌리면 "가나�")→GREEN. mcp 185파일/1735, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: RED 독립 재확인, 헬퍼 2000+ 케이스 fuzz vs optimal-prefix oracle(cap 초과 없음·fitting char over-trim 없음·최장 유효 prefix), ASCII 테스트 green.
- **리스크:** 없음에 가까움 — truncated 경로만 헬퍼 경유, 비절단 read 무변경, 기존 ASCII 절단 테스트(length 50) green. end가 maxBytes에서만 감소라 over-shoot 구조적 불가, malformed all-continuation은 end>0 가드로 즉시 종료. nit(non-blocking): bytes 필드는 여전히 전체 파일 바이트(slice 아님, 기존 계약). RATCHET: testFiles 897 무변동(기존 파일에 7케이스), fabrication 0 유지. grounding floor 무관(파일 읽기 무결성, 게이트 무변경).


## [TOOL loop] fire 31 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening (+ JUDGE 실패-드릴)

- **무엇:** loopback-fetch readBodyWithCap이 절단 청크를 비-스트리밍 decoder.decode(head)로 디코드 → cap의 불완전 멀티바이트 꼬리를 U+FFFD로 flush(한국어 body가 "가나�"). fix는 utf8SafeSliceEnd(head)가 아니라(스트리밍 디코더의 cross-chunk pending 바이트 무시) decoder.decode(head,{stream:true}) + truncated 분기 미-flush로 불완전 꼬리 drop.
- **왜:** fire-30 sibling ◦(encoding-boundary). + ~10주기 JUDGE 실패-드릴(직전 fire 21): inert 슬라이스(코멘트뿐 코드+declaration-only 테스트 truncated:true/length>0만) 주입 → Fable-5가 정확히 FAIL(result.body="가나�" 추적·테스트 declaration-only 적발·올바른 stream-flag fix 독립 도출) → 롤백 → 진짜 fix. 드릴 3/3(fire 10·21·31). 핵심 교훈: 같은 증상(UTF-8 절단)이라도 스트리밍 디코더 경로는 fs 헬퍼와 fix 형태가 다름.
- **리뷰지점:** loopback-fetch.ts:100-105(decode head에 {stream:true} + WHY 코멘트) + mcp.test.ts(가나다라 cap8→"가나"·U+FFFD 없음; 가나 cap2→"") RED("가나�")→GREEN. mcp 185파일/1737, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 진짜-fix PASS: RED 독립 재확인, stream-flag+no-flush가 cross-chunk 디코더 상태에 옳음(multi-chunk mid-char 분할 실증→"가나"), complete-char 손실 없음.
- **리스크:** 없음에 가까움 — truncated 분기 1줄(stream flag), 비절단/ASCII(maxBodyBytes:50→len 50)/1GB-cap 테스트 green. 정확-cap-end-of-stream malformed는 비절단 경로 flush가 U+FFFD(서버가 보낸 malformed, 절단 artifact 아님 — 정상). nit(non-blocking): 체크인 테스트는 single-chunk라 cross-chunk는 ad hoc 입증(committed 테스트 미고정, 후속 ◦). RATCHET: testFiles 897 무변동(기존 파일 +2케이스), fabrication 0 유지, JUDGE drill 3/3. grounding floor 무관(웹 body 읽기 무결성, 게이트 무변경).


## [TOOL loop] fire 32 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.url.encode_query가 배열의 null/undefined 항목을 리터럴 "null"/"undefined"로 인코딩 — 배열 분기 가드 `item !== null && item !== undefined && !isScalar(item)`가 null/undefined를 통과시켜 `String(item)` → `{tags:["a",null,"b"]}`→`tags=a&tags=null&tags=b`. 스칼라 분기는 명시적으로 null/undefined SKIP. 배열 루프에 `item===null||item===undefined → continue` 추가(객체 체크 前)로 일치.
- **왜:** EXPANSION 코드 gap-scout(신호 clean). fire 30·31이 둘 다 encoding-boundary였어서 다양성 가드상 비-encoding KIND 필수 → contract-output-drift/inconsistent-null(fresh KIND·표면 loopback-url-server). 같은 도구 내부 분기가 null을 다르게 처리 = silent 쿼리 파라미터 손상. url.encode_query nested-object fix(과거)가 남긴 갭(가드가 null/undefined를 reject서 통과시킨 뒤 String화).
- **리뷰지점:** loopback-url-server.ts:79-90(배열 루프 null/undefined continue + WHY 코멘트) + loopback-url.test.ts(["a",null,undefined,"b"]→"tags=a&tags=b"; nested-object-in-array 여전히 reject; falsy-valid [0,false,""]→"v=0&v=false&v=" 인코딩) RED("tags=null...")→GREEN 12/12. mcp 1738, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: src만 stash해 RED 재확인, nested object/array 여전히 reject, 0/false/"" 인코딩(strict null/undefined skip만), tags=null 미고정.
- **리스크:** 없음에 가까움 — 배열 루프 1조건 추가, 스칼라 분기와 의미 일치, scalar array/empty/reserved-char 인코딩 무변경. verifier note 반영해 falsy-scalar 경계 테스트 1줄 추가(미래 loose-falsy 회귀 방지). RATCHET: testFiles 897 무변동(기존 파일 +1케이스), fabrication 0 유지. grounding floor 무관(쿼리 인코딩 정확성, 게이트 무변경).


## [TOOL loop] fire 33 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** performConsentedAction이 caller의 request.headers로 consent-gated 자격증명을 덮어씀(보안 fail-open). 헤더가 `{authorization: Bearer cred, ...request.headers}`로 caller 스프레드가 마지막 → request.headers.authorization이 토큰 override, 대소문자 variant는 new Headers가 "Bearer svc, Bearer attacker"로 병합 손상. callerHeaders에서 `.toLowerCase()==="authorization"` 키 제거 후 스프레드(code-owned 토큰만 leave, content-type/x-custom 등 다른 헤더는 보존).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). outbound-safety.md "Security is code, not a prompt" 직접 위반 — scoped credential이 유일한 Bearer여야 함. 보안 KIND(credential-override)·fresh 표면(consented-action). 최근 KIND(encoding×2·contract-drift)와 다름. 단순 버그픽스보다 계약-위반 보안 수정이 이 루프의 최고 산출(directive).
- **리뷰지점:** consented-action.ts:85-100(callerHeaders authorization-strip + WHY 코멘트) + consented-action.test.ts(lowercase+capitalized override 시도 → new Headers(init.headers).get("authorization")==="Bearer svc-token"; x-custom 통과) RED("Bearer attacker")→GREEN. consent 7/7, mcp 1739(playbook-store flake는 격리 재실행 green), check 0(전 패키지), lint 0. Fable-5 PASS: src만 stash해 RED 재확인, 모든 case variant 차단·공백/Unicode 키는 invalid header name이라 fail-closed(bypass 아님)·consent/veto 게이트 무변경.
- **리스크:** 없음에 가까움 — 헤더 구성만 변경, fail-closed consent 게이트 자체 무영향, request.headers undefined/empty는 기존 동작(`?? {}`), 정상 헤더 pass-through 테스트 입증. RATCHET: testFiles 897 무변동(기존 파일 +1케이스), fabrication 0 유지. **인접 보안 구멍 발견·◦ 기록**: request.url이 consent scope에 미바인딩 → 토큰이 임의 URL로 갈 수 있음(credential-exfil, 별도 fire·scope→host 매핑 필요). grounding floor 무관(아웃바운드 자격증명 무결성, 게이트 무변경).


## [TOOL loop] fire 34 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** performConsentedAction이 caller-controlled request.url에 scoped 토큰을 보내 임의 host로 exfil 가능(fire-33 verifier가 헤더 버그보다 큰 벡터로 지목). ScopedConsent에 OPTIONAL allowedHost 추가 → consent가 목적지를 선언하면 `new URL(request.url).host` 불일치/파싱불가시 fail-closed 거부(no HTTP). findConsent 추가(레코드 반환, hasConsent 위임).
- **왜:** EXPANSION ◦(보안, 최상단). trust-correct 소스 결정: performConsentedAction·recordConsent는 프로덕션 호출부 없음(미배선 P5-b3 primitive)·service→host 레지스트리 없음 → 목적지는 grant 시 consent RECORD에 기록(caller url 신뢰 불가). 미배선이라 enforce-when-present(optional)로 메커니즘+테스트 우선, fail-closed-on-absence 강제는 grant 배선 後 후속 ◦. 중복 테스트 코퍼스(src/+test/ 양쪽 ~10곳) 때문에 required는 과도 → optional 선택.
- **리뷰지점:** personal-consent-store.ts(allowedHost optional + isScopedConsent 수용 + serializeConsent 조건부 emit + findConsent) + consented-action.ts(allowedHost 존재시 host 대조 fail-closed) + index.ts(findConsent export) + consented-action.test.ts(grant allowedHost=api.test; evil.example→거부·0 HTTP; unparseable→거부) RED(거부 무력화→토큰이 evil.example 도달)→GREEN. mcp 1741, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: userinfo bypass `https://api.test@evil.example/`→host=evil.example 올바르게 거부, host(포트 포함)는 hostname보다 strict(fail-closed-safe), hasConsent 위임 의미 보존.
- **리스크:** 낮음 — enforce-when-present라 allowedHost 없는 consent는 기존 동작(미배선이라 프로덕션 영향 0), serializeConsent absent-case byte-identical, 중복 src/ 테스트 무수정 컴파일. **정직 범위**: optional이라 목적지 미선언시 hole 잔존 — 후속 ◦로 mandatory화 기록(grant 배선 의존). RATCHET: testFiles 897 무변동(기존 파일 +2케이스), fabrication 0 유지. grounding floor 무관(아웃바운드 자격증명 목적지 바인딩, 게이트 무변경).


## [TOOL loop] fire 35 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.history.recent이 fractional limit<1에 빈 피드 반환 — clampLimit이 `raw<=0`를 truncate 前에 검사 → `limit:0.5`가 가드 통과 후 `Math.trunc(0.5)=0` → `Math.min(cap,0)=0` → 피드가 빈 채로. "어젯밤 뭐 했지?"에 fractional limit 섞이면 조용히 "아무 일 없음" 응답. truncate를 positivity 체크 前으로 옮겨 sub-1을 0/음수와 함께 fallback(20)으로. clampLimit export(직접 단위테스트).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). fire 33·34가 둘 다 보안/credential였어서 다양성 가드상 다른 KIND 필수 → boundary-condition/silent-failure(fresh KIND·표면 loopback-history). fix는 history 자기 계약과 일관(0/음수가 이미 fallback이니 0.5도 fallback) — proactive sibling의 clamp-to-1은 다른 계약(undefined→store-default)이라 이번 슬라이스 범위 아님.
- **리뷰지점:** loopback-history.ts:34-46(truncate-before-check + export + WHY 코멘트) + loopback-history-limit-clamp.test.ts(5 단위: 0.5/0.999→20·0/-5→20·2.9→2·1.5→1·50→50·500→200·string/NaN/Inf→20) + mcp.test.ts(e2e: recent({limit:0.5}).total===recent({}).total) RED(fix 되돌리면 "expected 0 to be 5")→GREEN. mcp 186파일/1747, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: RED 재현, 정확 1.0→1 경계 검증, valid integer limit 무변경, export 배럴 미진입(email-provider clampLimit과 충돌 없음).
- **리스크:** 없음에 가까움 — raw≥1은 신구 동일(유일 델타는 (0,1)→fallback), 기존 history 테스트(limit:2·kind·sinceIso) 무회귀. nit(non-blocking): 단위테스트가 1.0 명시 미고정(1.5가 동일 분기 커버, verifier가 실행 검증). RATCHET: testFiles 897→898(+1 파일), fabrication 0 유지. grounding floor 무관(활동 피드 limit 정확성, 게이트 무변경).


## [TOOL loop] fire 36 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** browser_read의 find 분기 페이징이 dead-end/루프 트랩 — description은 "total+hasMore/nextOffset, offset으로 다음 배치" 약속하고 no-find 분기(snapshotToJson)는 지키나, find 분기는 `matched.slice(0, MAX)`로 offset 무시 + nextOffset 미방출, `{hasMore:true}`만. >50 매칭시 8B가 hasMore 보고 프로토콜(find+offset) 따라도 같은 첫 50개만 영원히. find 분기를 snapshotToJson과 동일 페이징으로 정렬(offset clamp·slice[start,start+MAX)·offset/hasMore/nextOffset 방출).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). contract-output-drift KIND(최근 security×2·boundary와 다름)·fresh 표면(browser). 도구가 자기 description의 페이징 파라미터를 무시 = 로컬 모델 루프 트랩(tool-calling.md: 작은 모델 루프 금지). 8B가 도달 못 하는 결과.
- **리뷰지점:** browser-tools.ts:206-222(find 분기 페이징 정렬 + WHY 코멘트) + browser-tools.test.ts(60 매칭: find→50+nextOffset:50·offset undefined; find+offset:50→10·offset:50·ref[0]=50 연속) RED(start=0 강제 → offset:50이 첫 50개 재반환)→GREEN. browser 2파일/58, check 0(전 패키지: agent-core 1831·mcp 1747·cli 2535·api 850), lint 0. Fable-5 PASS: RED 재확인, past-end는 empty로 clamp·negative는 0으로 clamp·연속 페이지 dupe/skip 없음·filterElements order-stable, 유일 소비자=CLI 등록(opaque).
- **리스크:** 없음에 가까움 — find 분기만 정렬(no-find와 동일 계약), 기존 find/no-find 페이징 테스트 무회귀, inputSchema에 offset 이미 선언(셀렉션 surface 무변동). nit(non-blocking, pre-existing·범위 밖): find는 count를 `matched`, no-find는 `total`로 명명. RATCHET: testFiles 898 무변동(기존 파일 +1케이스), fabrication 0 유지. grounding floor 무관(브라우저 요소 페이징 도달성, 게이트 무변경).


## [TOOL loop] fire 37 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** dismissPattern이 patterns-fired.json에 미직렬화 read→append→write — sibling recordPatternFired는 withFileMutationQueue로 감쌌으나 dismissPattern은 누락. 동시 in-process dismiss/fire가 같은 스냅샷 읽고 마지막 write가 나머지 clobber → 사용자 veto(learned-avoidance) 유실, same-ms write는 tmp rename ENOENT 크래시. 큐로 감싸기(recordPatternFired 미러) + "daemon만 writer, clobber 수용" 거짓 JSDoc 삭제.
- **왜:** EXPANSION 코드 gap-scout(신호 clean). lost-update KIND(최근 security/boundary/contract-drift와 다름)·fresh 표면(patterns-fired-store). 유실된 dismiss = Muse가 사용자가 명시 거부한 패턴을 계속 제안 = proactivity가 피하려는 trust 실패. sibling이 이미 정확히 이 실패를 큐로 막는데 dismissPattern만 놓침.
- **리뷰지점:** personal-patterns-fired-store.ts(dismissPattern 큐 감싸기 + 정확한 WHY 코멘트 + stale JSDoc 삭제) + patterns-fired-concurrent.test.ts(12 dismiss + 13 fire Promise.all → 25 전부 present·12 dismiss 전부 survive) RED(큐 되돌리면 ENOENT/레코드 유실)→GREEN. mcp 186파일/1748, check 0(messaging pending-approval flake 무관·격리 17/17), lint 0. Fable-5 PASS: read가 critical section 내·nested-queue deadlock 없음·non-flaky(3/3). **verifier 지적**: 큐는 in-process만 직렬화 → CLI-vs-daemon(2 프로세스) race는 file lock 필요(후속 ◦); 주석을 oversell 안 하게 정확화.
- **리스크:** 없음에 가까움 — dismissPattern 1함수 큐 추가(sequential 동작 무변경), isPatternDismissed/cooldown 무영향, pattern-dismiss.test.ts 무회귀. 삭제한 JSDoc은 두 주장 모두 거짓(recordPatternFired는 큐 사용·CLI는 2번째 writer)이라 실정보 무손실. RATCHET: testFiles 898 무변동(기존 파일 +1케이스), fabrication 0 유지. grounding floor 무관(패턴 dismiss 영속성, 게이트 무변경).


## [TOOL loop] fire 38 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** writeFollowupLlmBudget이 공유 atomicWriteFile 미채택 — hand-rolled `tmp-${pid}-${Date.now()}` + catch-cleanup 없는 open/write/sync/rename. same-ms writer 둘이 동일 tmp → 느린 rename ENOENT 크래시, write/rename 실패시 tmp orphan(무조건 실재). 본문을 atomicWriteFile(file, payload)로 교체(byte-identical payload, fsync/0o600 동일).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). resource-leak/race-crash KIND(최근 boundary/contract-drift/lost-update와 다름)·fresh 표면(followup-llm-budget-store). 같은 패키지 atomicWriteFile이 이미 이 버그 클래스 해결("remaining stores adopt it" 독스트링)인데 이 store만 누락. ENOENT race는 현 배선상 거의 도달 불가(increment 큐 직렬화)나 orphan-on-failure는 무조건 실재 + 공개 export 하드닝(defense-in-depth, theater 아님).
- **리뷰지점:** personal-followup-llm-budget-store.ts(atomicWriteFile 채택 + dirname import 제거 + WHY 코멘트) + followup-llm-budget.test.ts(Date.now 동결 → 2 concurrent write 둘 다 resolve + .tmp- orphan 없음) RED(ENOENT rename `budget.json.tmp-<pid>-1700000000000`)→GREEN. mcp 186파일/1749, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: durability 보존(fsync default·0o600·payload byte-identical), 두 결함 닫힘, 유일 프로덕션 caller(autoconfigure)가 큐 내에서 정상 합성, Date.now spy는 randomUUID 쓰는 atomicWriteFile과 무관(non-flaky).
- **리스크:** 없음에 가까움 — write 본문만 교체(증분/exhausted/formatLocalDay 무회귀), 읽기 경로 동일 파싱. runner-up 2건 ◦ 기록(appendReminderHistory 동종·큐 내라 저긴급; cleanupFollowupTempFiles dead-wired·mtime age-gate 설계 필요). RATCHET: testFiles 898 무변동(기존 파일 +1케이스), fabrication 0 유지. grounding floor 무관(예산 store 쓰기 내구성, 게이트 무변경).


## [TOOL loop] fire 39 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** active standing objective의 unparseable nextEvalAt이 영원히 동결 — due 필터 `Date.parse(o.nextEvalAt) <= nowMs`가 비-ISO에 `NaN<=nowMs=false` + `!o.nextEvalAt=false`라 매 tick 제외, 평가도 에스컬레이션도 없이. 미가드(바로 위 maxPerTick은 동일 NaN-poison을 Number.isFinite로 가드). unparseable이면 due-now로 fail-open(backoff가 valid ISO 재기록=self-heal).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). silent-failure KIND(최근 contract-drift/lost-update/resource-leak와 다름)·fresh 표면(objective-evaluation-loop). 모듈 자기 계약("never silently dropped")+같은 파일의 NaN-poison 가드와 모순. isStandingObjective가 nextEvalAt 미검증이라 hand-edit/foreign-write objectives.json으로 도달 가능. appendReminderHistory(동일 KIND as fire38)는 skip.
- **리뷰지점:** objective-evaluation-loop.ts:78-86(필터를 Number.isFinite 가드로 + WHY 코멘트) + objective-evaluation-loop.test.ts(nextEvalAt:"not-a-date" → evaluated 1·retried·persisted nextEvalAt parseable===nowMs+1000) RED(제외 → evaluated 0)→GREEN. mcp 186파일/1750, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: future-valid 여전히 제외(cooldown 유지)·비-ISO sentinel 없음("never"는 status)·1 eval 후 self-heal 확인. (검증자가 RED 중 git checkout으로 미커밋 fix 잠시 파괴→복구; 커밋 전 fix 존재+8/8 green 재확인.)
- **리스크:** 없음에 가까움 — unparseable일 때만 동작 변경(code-written 타임스탬프는 항상 toISOString이라 정상), valid future/past/met/unmeetable/backoff 무회귀. nit(non-blocking, pre-existing): 평가자가 poisoned objective에서 throw하면 catch가 nextEvalAt 미치유→매 tick re-due(모듈의 fail-open-on-error 계약, 의도 방향). runner-up ◦: append-only 스토어가 forward-version 엔트리를 다음 write에 파괴(raw-read path 필요). RATCHET: testFiles 898 무변동(기존 파일 +1케이스), fabrication 0 유지. grounding floor 무관(objective 재평가 활성성, 게이트 무변경).


## [TOOL loop] fire 40 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.calendar.update이 파싱 불가 startsAt/endsAt을 조용히 버리고 success 보고 — `resolvedStartsAt = raw ? parseIsoDate(...) : undefined`가 unresolvable phrase에 undefined → spread가 move 생략 → updateEvent 호출+`{event}` 성공 반환. "move to flurbsday"가 아무것도 안 옮기고 done. provided-but-unparseable일 때 에러(sibling add 미러, updateEvent 前). parseable start + unparseable end는 start만 이동(end-before-start)도 차단.
- **왜:** EXPANSION 코드 gap-scout(신호 clean). missing-validation KIND(최근 lost-update/resource-leak/silent-failure와 다름)·fresh 표면(loopback-calendar update). add는 이미 동일 조건에 에러인데 update만 불일치. append-only forward-version ◦는 hash-chain 블로커+preserve-vs-drop 판단이라 defer(노트 갱신).
- **리뷰지점:** loopback-calendar.ts:349-/369-(startsAt·endsAt provided-but-unparseable 가드 + resolvedEndsAt 분리 + WHY 코멘트) + loopback-calendar-add-anchor.test.ts(capturing registry: startsAt"flurbsday"→error+updateEvent 0회; valid-start+endsAt"flurbsday"→error+0회) RED(가드 제거→updateEvent 호출·성공)→GREEN. mcp 186파일/1752, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: omitted 무영향·valid phrase(tomorrow 2pm/내일 오후 3시/5pm/in 2 hours/ISO) 전부 파싱·newEndsAt fallback 대수적 동일·return이 updateEvent 前이라 partial state 없음.
- **리스크:** 없음에 가까움 — provided-but-unparseable만 에러(omitted/title-only/location-only update 무영향), 기존 anchor/add/availability/schema 무회귀. nit(non-blocking, 의도된): `""`도 이제 에러(add와 일관); non-string epoch는 readString→undefined로 여전히 omitted 취급(pre-existing, runner-up ◦). RATCHET: testFiles 898 무변동(기존 파일 +2케이스), fabrication 0 유지. grounding floor 무관(쓰기-도구 입력 검증, 게이트 무변경).


## [TOOL loop] fire 41 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** appendReminderHistory이 시크릿을 평문 audit log(reminder-history.json)에 스크럽 없이 저장 — sibling proactive-history는 persist chokepoint에서 redactSecretsInText(title/text/error) 적용하나 reminder store는 raw entry 추가. "rotate key sk-proj-…" 리마인더가 전달은 스크럽되나 archive는 verbatim; error는 upstream 응답 본문(텔레그램 토큰 등) 인용 가능. chokepoint에서 text+error 스크럽(sibling 패턴 일치).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). secret-leak/data-integrity KIND(최근 resource-leak/silent-failure/missing-validation와 다름)·fresh 표면(reminder-history-store). Muse "tell it everything, it can't tell anyone" 정체성 직결 — 시크릿이 로컬 audit log에도 평문으로 남으면 안 됨. add endsAt ◦(fire40 동일 KIND)는 skip.
- **리뷰지점:** personal-reminder-history-store.ts(redactSecretsInText import + chokepoint scrubbed entry + WHY 코멘트) + reminder-history-concurrent.test.ts(sk-proj key in text + telegram token in error → read-back [redacted-openai-key]/[redacted-telegram-bot-token]·raw 부재) RED(raw entry→평문 키 저장)→GREEN. mcp 186파일/1753, check 0(전 패키지: agent-core 1831·cli 2535·api 850), lint 0. Fable-5 PASS: text+error=전체 시크릿 필드(destination은 messaging 계약상 비-시크릿)·chokepoint라 모든 caller 상속·토큰 shape 정규식 매칭 검증·무회귀.
- **리스크:** 없음에 가까움 — append 본문에 scrub만 추가(concurrency/capacity 무회귀), redactSecretsInText는 empty/short 안전 early-return, false-positive 스크럽은 proactive store와 동일 수용 trade. RATCHET: testFiles 898 무변동(기존 파일 +1케이스), fabrication 0 유지. **verifier sibling 누수 발견·◦**: daemon이 raw error 문자열을 daemon.out.log에 평문 print(텍스트 아닌 error만). grounding floor 무관(audit log 시크릿 위생, 게이트 무변경).
> ✅ **자율 리뷰관문 (fires 28–30, 진안 묻지 않음):** 사이클6 = **논문-근거 3연속 + inert-trap 사냥**(전부 공개 arXiv, 자체 재구현, Fable scout 발굴 + Fable judge 적대검증): 28 MoA council outlier screen(2503.05856)·29 multi-group conformal abstention calibration(2407.21057)·30 MemoryBank 망각 루프 닫기(2305.10250). Fable judge가 29를 **inert로 v1 FAIL**(EN-only 코퍼스라 hangul 그룹 영영 미생성)→한국어 서브그룹 추가로 v2 PASS(live doctor 증명); 30은 *기존* inert 씨앗(fade 3표면 report-only)을 닫음. KIND 다양(multi-agent·calibration·memory). **사이클7 방향(스스로): 논문-근거 라운드로빈 계속 — 서브에이전트/백그라운드-스레드 테마 차례(아직 사이클5-6 미터치), 또는 sleep-time compute·Mem0 UPDATE 큐 항목.** fires-28-30 배치는 로컬 main에 머지 완료(f9366ca3, push 안 함).

## [TOOL loop] fire 42 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** commitment check-ins lost-update — appendCheckins 미큐 RMW + runDueCheckins가 `all` 스냅샷 읽고 multi-second send 後 stale `all` write. send 중 추가(chat-hook)/취소된 check-in 클로버: 새 check-in 소멸·**취소된 nudge 부활 재발사**(사용자가 silence한 걸 다시 보냄=trust 실패). appendCheckins 큐잉 + writeback를 큐 내 re-read-fresh + patch-by-id(stale all 제거).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). data-integrity/lost-update KIND(fire 37 이후·최근 silent-failure/missing-validation/secret-leak와 다름)·fresh 표면(commitment-checkin). sibling(followups/objectives)은 큐 사용하나 이 스토어는 패턴 이전이라 누락. daemon error-leak ◦(fire41 동일 KIND)는 skip.
- **리뷰지점:** commitment-checkin.ts(withFileMutationQueue import + appendCheckins 큐잉 + runDueCheckins writeback 큐 내 re-read-fresh+patch-by-id + WHY 코멘트) + commitment-checkin.test.ts(mid-send append survives + fired marked; 2 concurrent appendCheckins persist) RED(stale write 클로버 + ENOENT)→GREEN. mcp 186파일/1773, check 0(전 패키지: agent-core 1831·cli 2550·api 850), lint 0. Fable-5 PASS: re-read 큐 내·patch-by-id·취소 부활 by construction 차단·deadlock 없음(send 루프는 큐 밖)·동일 큐 키. scope 정직: in-process race 해결, cross-process CLI-cancel-vs-daemon은 기존 file-lock ◦.
- **리스크:** 없음에 가까움 — appendCheckins/writeback만 큐 경유(send 루프·res.fired 무변경), 기존 deliver/not-due/quiet-hours/cancel/snooze/schedule 무회귀. nit(non-blocking·◦ 기록): 로컬 writeFileAtomic이 여전히 pid+Date.now tmp(CLI cancel/snooze 미큐·cross-process)·cross-process window 잔존. RATCHET: testFiles 898 무변동(기존 파일 +2케이스), fabrication 0 유지. grounding floor 무관(체크인 영속 무결성, 게이트 무변경).


## [TOOL loop] fire 43 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** proactive-notice firedKey가 dedup 키를 `${kind} ${id} ${startIso}` 공백-join — id가 자유형(provider event/task id, 공백 가능)이라 별개 {kind,id,startIso} 튜플이 동일 키 충돌(id="a b"+"X" vs id="a"+"b X" 둘 다 "calendar a b X") → dedup `seen.has→continue`가 정당한 둘째 notice 조용히 억제(모듈 계약 "fires at most once per tuple" 위반). JSON.stringify([kind,id,startIso])로 모호성 제거(단사).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). dedup/key-collision KIND(최근 missing-validation/secret-leak/lost-update와 다름)·fresh 표면(proactive-notice-loop). 충돌시 사용자가 받아야 할 proactive notice 누락 = proactivity 신뢰성 버그. 키는 in-memory(매 run entries sidecar에서 재구성)라 영속 migration 불필요. Fable-5 일시 불가→scout+judge Opus 4.8 폴백.
- **리뷰지점:** proactive-notice-loop.ts:174(firedKey export + JSON 인코딩 + WHY 코멘트) + proactive-fired-key.test.ts(단위: collision 쌍→distinct·same tuple→same; e2e: 충돌 sidecar 엔트리→runDueProactiveNotices가 새 event 발사 summary.fired===1) RED(공백-join→억제 fired=0)→GREEN. mcp 187파일/1776, check 0(전 패키지: agent-core 1831·cli 2550·api 850), lint 0. Opus PASS: JSON 단사(quote/bracket injection 불가)·entries-not-keys 영속이라 backward-compat·reachable(calendar event id provider-reported/untrusted)·sort/trim/persistence 무영향.
- **리스크:** 없음에 가까움 — firedKey 1줄 인코딩 변경(in-memory 키), 영속 포맷·sort·trim 무변경, 기존 retry/quiet-hours 무회귀, export는 barrel 미추가(테스트 직접 import). RATCHET: testFiles 903→904(+1 파일), fabrication 0 유지. grounding floor 무관(proactive dedup 정확성, 게이트 무변경).


## [TOOL loop] fire 44 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** objective verdict 파서가 중첩 객체를 누출해 false 자율 `met` — balancedJsonCandidates(objective-evaluator.ts:79-110)가 균형 span 푸시 후 outer i를 안 넘겨 중첩 `{`를 별도 후보로 재추출. parseObjectiveVerdict가 LAST outcome-후보 취함 → `{"plan":{"outcome":"met"},...}`가 중첩 `{"outcome":"met"}` 누출→met. span 푸시 후 `i = j`로 top-level만 후보(중첩-only는 ambiguous⇒unmet).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). parsing-bug/safety KIND(최근 secret-leak/lost-update/dedup와 다름)·fresh 표면(objective-evaluator). **fabrication=0/자율-안전 edge 직결** — runDueObjectives가 met에 자율 act()+status:done("✅ Objective met"). 모듈이 "never false met" 명시 약속하는 그 결과. Fable-5 일시 불가→scout+judge Opus 폴백.
- **리뷰지점:** objective-evaluator.ts:98(span 푸시 후 i=j + WHY 코멘트) + parse-objective-verdict.test.ts(중첩-only met→unmet; array 중첩→unmet; top-level unmet+중첩 met→unmet) RED(i=j 제거→false met)→GREEN 7/7. mcp 187파일/1778, check 0(전 패키지: agent-core 1831·cli 2550·api 850), lint 0. Opus PASS: 별개 top-level 둘 다 보존·brace-in-string/escaped-quote 무영향·SYSTEM_PROMPT가 top-level {outcome,reason} 요구라 중첩-only는 off-spec⇒unmet 정답(legit verdict 드롭 아님).
- **리스크:** 없음에 가까움 — 1줄(i=j) 추가, 별개 top-level/fenced/<think>/prose 무회귀, inStr/esc 스캐너 무영향(i=j는 진짜 top-level close에서만). conservative 방향(false unmet은 재평가, false met은 거짓 완료)이라 안전. RATCHET: testFiles 904 무변동(기존 파일 +2케이스), fabrication 0 유지(이 fix가 false-positive 완료를 막아 강화). grounding floor 직접 강화(자율 met 위양성 차단).


## [TOOL loop] fire 45 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening (+ JUDGE 실패-드릴)

- **무엇:** runDueFollowups이 due followup을 sort 없이 `slice(0,max)`로 파일 순서 발사 — backlog가 maxPerTick 초과시(다운타임 복구) 파일-first commitment 발사, 가장 밀린 self-followup이 tick마다 deferred(starve). sibling compareFollowupsByScheduledFor(soonest-first) 존재하나 미적용. `.sort(compareFollowupsByScheduledFor)`를 slice 前 추가(soonest-scheduledFor=most-overdue).
- **왜:** EXPANSION 코드 gap-scout(신호 clean). sort-ordering KIND(최근 lost-update/dedup/parsing과 다름)·fresh 표면(followup-firing-loop). + ~10주기 JUDGE 실패-드릴(직전 fire 31, 과만기): inert 슬라이스(코멘트뿐 코드 + delivered===1만 단언) 주입 → Opus가 정확히 FAIL(실증 fired[0]="fu_recent"·테스트 count-only 적발·sort fix 도출) → 롤백 → 진짜 fix. 드릴 4/4(fire 10·21·31·45). Fable-5 일시 불가→scout+양 judge Opus 폴백.
- **리뷰지점:** followup-firing-loop.ts(compareFollowupsByScheduledFor import + sort before slice + WHY 코멘트) + mcp.test.ts(3 distinct-due, oldest LAST, maxPerTick:1 → fired[0].id="fu_oldest" + 나머지 둘 scheduled 유지) RED(sort 제거→"fu_recent")→GREEN. mcp 187파일/1779, check 0(전 패키지: agent-core 1831·cli 2550·api 850), lint 0. Opus 진짜-fix PASS: comparator ascending=oldest-first·slice 前·ties는 createdAt/id tiebreak 안정·fresh filtered array sort라 store 순서 무손상·기존 cap(5 동일→2)/NaN-fallback 무회귀.
- **리스크:** 없음에 가까움 — due 리스트 sort 1줄 추가(fired-write/markFollowupFired/summary 무변경), 정렬은 filter가 만든 fresh array 대상이라 영속 순서 무영향. RATCHET: testFiles 904 무변동(기존 파일 +1케이스), fabrication 0 유지, JUDGE drill 4/4. grounding floor 무관(followup 발사 공정성, 게이트 무변경).


## [TOOL loop] fire 46 (skill v1.11.2, cron 5388335b) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** runDueObjectives이 backoffBaseMs/backoffMaxMs를 NaN-가드 안 함(maxPerTick/maxAttempts는 Number.isFinite 가드인데 backoff 2 knob만 bare `??`). non-finite backoff → delay=Math.min(cap,NaN*…)=NaN → `new Date(nowMs+NaN).toISOString()` RangeError → sibling-catch에 잡혀 nextEvalAt 미갱신 → objective 매 tick spin(backoff 무력화). base+cap 둘 다 Number.isFinite 가드로 미러.
- **왜:** EXPANSION 코드 gap-scout(신호 clean). missing-validation/NaN-poison KIND(최근 dedup/parsing/sort와 다름). 파일 자기 주석이 이 클래스를 명시하고 2 knob은 가드하는데 backoff 2개 누락 = 명백한 비대칭 defect. fire 39(nextEvalAt NaN-freeze)와 동일 파일·NaN-poison 클래스지만 다른 knob — 파일의 가드 대칭 완성. Fable-5 불가→scout+judge Opus 폴백.
- **리뷰지점:** objective-evaluation-loop.ts:73-78(base/cap Number.isFinite 가드 + WHY 코멘트) + objective-evaluation-loop.test.ts(backoffBaseMs:NaN→retried+nextEvalAt=nowMs+60_000; backoffMaxMs:NaN→가드, =nowMs+1000) RED(bare ??→RangeError·retried 빈)→GREEN 10/10. mcp 187파일/1780, check 0(전 패키지: agent-core 1831·cli 2550·api 850), lint 0. Opus PASS: NaN/Inf/undefined 차단·finite(0 포함) 보존·base+cap 대칭·verifier nit(cap 독립 테스트 없음) cap-NaN 케이스로 해소.
- **리스크:** 없음에 가까움 — non-finite일 때만 동작 변경(finite는 byte-identical), 기존 met/unmeetable/unmet/maxAttempts/nextEvalAt-self-heal 무회귀, 프로덕션 caller(daemon/api tick)는 finite 입력이라 무영향. RATCHET: testFiles 904 무변동(기존 파일 +2케이스), fabrication 0 유지. grounding floor 무관(자율 objective backoff 견고성, 게이트 무변경).
> ✅ **자율 리뷰관문 (fires 34–36, 진안 묻지 않음):** 사이클8 = 2 ship + 1 정직한 defer(전부 공개 arXiv, Fable scout+judge): 34 MemoryBank-계열 compaction salient-fact 보존(2511.17208, FLOOR 5라운드 하드닝)·35 RAG-Fusion 복합쿼리 검색(2402.03367, 1라운드 PASS)·36 Prompt-Infection council injection quarantine(2410.07283, **DEFERRED** — 탐지기 calibration tar-pit, 4라운드 over-quarantine FP, 슬라이스 revert + backlog 블로커). 교훈: fire34/36 둘 다 "공유 컴포넌트를 다른 입력분포에 재사용하면 양방향 miscalibrate"(numeric verbatim≠faithful / user-pattern을 model-prose에) — maker≠judge가 floor 회귀를 반복 차단. **사이클9 방향(스스로): 저-floor-risk 형태(ranking/selection/validation) 우선 유지; 후보 = orchestration/검증(prose-safe 새 탐지기 아닌 다른 메커니즘) 또는 planning-quality 또는 신규 메모리/recall 메커니즘 — defer된 council-screen은 전용 calibration 슬라이스 필요시에만.** fires-31-35 배치는 로컬 main에 머지 완료(1b06c408, -r build green, push 안 함); fire-36은 defer(코드 무변동).


## fire 47 · 2026-06-13 · skill v1.14.0 · 90723a4d
meta: value-class=new-capability · pkg=@muse/mcp(+@muse/autoconfigure) · kind=new-tool(EXPANSION) · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 906 무변동(기존 contacts-tool.test.ts +3케이스) · fabrication 0 유지 · eval:tools contacts 신규 4/4 STABLE 3/3
- **무엇:** `upcoming_birthdays` 에이전트 도구 신설 — `resolveUpcomingBirthdays`는 이미 모든 비대화 표면(brief/today/week/recap/daemon)+CLI `muse contacts birthdays`에 배선됐는데 *대화(ask/chat)엔 도구가 없어* 모델이 "누구 생일 다가와?"를 답 못했다(`find_contact`는 name required→특정인만). read-only 도구로 래핑+등록.
- **왜:** ★VALUE-CLASS RATCHET 발동 — 최근 5 fire(42–46) 전부 @muse/mcp 데몬-루프 micro-fix라 다른 value-class 강제. 마침 테마의 방치된 EXPANSION 절반과 일치. 신호판 clean→tier-2 EXPANSION 코드 스카웃(Opus)이 inert/missing-tool 갭 발굴. 새 도구라 eval:tools 골든 공백(contacts 시나리오 부재)도 메움.
- **리뷰지점:** contacts-tool.ts(`createUpcomingBirthdaysTool`+`UpcomingBirthdaysToolDeps`, withinDays clamp 1–365 default 30, now 주입) + index.ts 재export + autoconfigure:712 contacts 배열 등록 + contacts-tool.test.ts(+3 행동테스트: 7일창 변별·soonest-first·empty·clamp; now=2026-12-20 핀) RED(`is not a function`)→GREEN 1784. eval-tool-selection.mjs `buildContactsScenario`(find_contact vs upcoming_birthdays, KO/EN 이름지정 negative). check 0(전 패키지 green), lint 0. Opus PASS 6/6: behavioral·wired(autoconfigure 모델-노출 배열)·read-only·no-collateral(peer 선택 무저하)·arg-correct(0/NaN→30 결정적)·진짜 new-capability.
- **리스크:** 없음에 가까움 — 순수 read-only 추가, 기존 find/add/remove 도구·테스트 byte-unchanged(import+export만 증가), 노출 도구 4개로 늘어도 eval에서 peer(find_contact) 변별 4/4 유지. fabrication 무관(출력 전부 store 파생, model-authored 자유필드 없음→groundedArgs 불요). MUSE_LOCAL_ONLY·outbound·banking 표면 무변경.


## fire 48 · 2026-06-13 · skill v1.14.0 · 3dab1d8e
meta: value-class=new-capability · pkg=@muse/mcp(+@muse/cli move,+@muse/autoconfigure wiring) · kind=new-tool(EXPANSION, notes/recall) · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 909→910(+on-this-day-tool.test.ts) · fabrication 0 유지 · eval:tools on-this-day 신규 4/4 STABLE 3/3
- **무엇:** `on_this_day_notes` 에이전트 도구 신설 — `muse on-this-day`(오늘 날짜에 과거 연도들에 쓴 노트 회상, 강한 autobiographical 단서; Rubin 1986)는 CLI-only라 대화 표면엔 도구가 없었다. read-only 도구로 노출. 순수 회상 로직(collectDatedNotes/extractNoteDate/selectOnThisDay)을 apps/cli→@muse/mcp로 이동(런타임은 자기가 import하는 패키지에서만 도구 projection 가능; apps/cli가 @muse/mcp 의존, 역방향 불가), CLI는 re-export로 기존 호출부 무손상.
- **왜:** ★RATCHET — 최근 8 fire 7/8이 mcp micro-fix라 다른 value-class 강제 + 직전(47)이 contacts였으니 **다른 표면(notes/recall)** 우선. 신호 clean→Opus EXPANSION scout가 CLI-only 갭 발굴(지난 birthday 갭과 동일 클래스). eval:tools on-this-day 시나리오 공백도 메움.
- **리뷰지점:** on-this-day-tool.ts(순수 로직 이동 + `createOnThisDayTool` factory, windowDays 0–7 clamp, now 주입, isoDate 직렬화) + index.ts export + autoconfigure:712 등록(`collectDatedNotes(notesDir)`) + apps/cli/on-this-day.ts(re-export+format* 잔류) + on-this-day-tool.test.ts(+3 행동: prior-year-only·most-recent-first·window·this-year 제외·clamp, now=2026-06-13 핀) RED(`is not a function`)→GREEN 1787. eval `buildOnThisDayScenario`(on_this_day_notes vs notes.search, KO/EN 양방향 negative). check 0(cli 2555·api green), lint 0. Opus PASS 6/6: behavioral·wired·이동안전(byte-identical·중복없음·re-export 전부 해소)·read-only·arg-correct·진짜 new-capability.
- **리스크:** 없음에 가까움 — cross-package 이동이 유일 리스크나 judge가 중복정의 0·기존 importer(brief/command/test) 전부 re-export 해소·CLI 2555 green 확인. fabrication 무관(출력=실제 경로+path의 YYYY-MM-DD 파생, mtime 미사용→가짜 anniversary 불가). MUSE_LOCAL_ONLY·outbound·banking 무변경. 무관 mcp suite flake 1건(1786→재실행 1787, 이 슬라이스 무관 pre-existing).


## fire 49 · 2026-06-13 · skill v1.14.0 · e509f8b5
meta: value-class=new-capability · pkg=@muse/mcp(+@muse/autoconfigure wiring) · kind=new-tool(EXPANSION, feeds/knowledge) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 911→912(+feeds-search-tool.test.ts) · fabrication 0 유지 · eval:tools feeds 신규 4/4 STABLE 3/3
- **무엇:** `feeds_search` 에이전트 도구 신설 — 구독 RSS/Atom 피드 아카이브를 키워드로 검색(title+summary, newest-first). `muse feeds search` CLI는 있고 피드는 모델에 *수동*(recent-entry knowledge 주입)으로만 닿았는데, on-demand 검색 도구가 없었다. 유일한 대안 `knowledge_search`는 **기본 OFF**(MUSE_KNOWLEDGE_SEARCH_ENABLED 게이트)라 기본 자세에서 "내 피드에 X 소식 있어?"를 답할 도구가 0개 — 그 default-posture 갭을 always-on read-only 도구로 메움.
- **왜:** ★RATCHET — 최근 8(41–48) 6/8 mcp micro-fix라 다른 value-class 강제 + 직전 2 fire가 contacts/notes였으니 **3번째 표면(feeds/knowledge)**. 신호 clean→Opus scout: inert 도구 없음(전수 대조) 확인 후 default-off knowledge_search 구멍이 드러낸 진짜 갭 발굴. 이번엔 CLI 미터치(autoconfigure가 readFeedKnowledgeEntries+resolveFeedsFile 이미 import).
- **리뷰지점:** feeds-search-tool.ts(`createFeedsSearchTool` + 로컬 `FeedEntryLike`(autoconfigure와 field-identical, cross-pkg dep 회피), query required·limit 1–50 clamp, 대소문자무시 substring) + index.ts export + autoconfigure:714 등록(`readFeedKnowledgeEntries(resolveFeedsFile(env),200)`) + feeds-search-tool.test.ts(+4 행동: 대소문자무시 title/summary 매치·newest-first 보존·empty 거부·limit clamp) RED→GREEN 1791. eval `buildFeedsScenario`(feeds_search vs web_search vs search_email, knowledge_search 의도적 제외=기본 자세 반영). check 0(cli 2555·api green), lint 0. Opus PASS 6/6: behavioral·wired·구조타이핑 sound(any-cast 아님)·read-only·arg-correct·진짜 new-capability.
- **리스크:** 없음에 가까움 — read-only 로컬(feeds.json), 출력=실제 캐시 엔트리 id/title/summary verbatim(model-authored 필드 없음→fabrication 0). 구조적 타이핑 seam이 유일 관심사였으나 judge가 field-identical·컴파일-검증 확인. MUSE_LOCAL_ONLY·outbound·banking 무변경. 기존 actuator 시나리오 knowledge_search 케이스 무손상(별도 시나리오).


## fire 50 · 2026-06-13 · skill v1.14.0 · 577161ca
meta: value-class=hardening · pkg=@muse/mcp · kind=schema-reach/completeness(find_contact) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 913 무변동(기존 contacts-tool.test.ts +2 it) · fabrication 0 유지 · eval:tools contacts 4→6 케이스(역방향 phone/email 추가, STABLE 3/3)
- **무엇:** `find_contact` 하드닝 — 핸들러가 resolved 출력에서 `about`(Contact가 "what do I know about Bob?"/"allergic to nuts" 답하라고 설계한 free-text recall 재료)과 `connections`("누구와 일하나")를 **드롭**하고 있었다(필드 존재·store가 직렬화하는데 도구만 누락) → 출력에 추가. + 같은 도구의 광고-계약 하드닝: 리졸버는 이미 phone/email/@handle 식별자 매칭(matchesExact)하고 gemma4도 식별자를 name 인자로 넘기는데 테스트 lock 없고 schema는 "name or alias"만 광고 → 역방향 동작 lock + description/keywords 정직 광고.
- **왜:** ★KIND 다양성 — 최근 3 fire(47·48·49) 전부 new-tool이라 다른 KIND 강제 → schema-reach/hardening 전환(RATCHET은 42–49 micro-fix 5/8로 압력 완화). scout가 제안한 "역방향=표현불가"는 **OUTCOME-first RED로 거짓 판명**(현 description으로도 eval 6/6) → no-op 광고변경 안 함, 대신 같은 도구의 진짜 teeth 갭(about/connections 드롭) 채움.
- **리뷰지점:** contacts-tool.ts(resolved 출력에 about+connections 스프레드, as 빈 라벨 생략=store serializer 미러 + description/keywords) + contacts-tool.test.ts(+about/connections 행동테스트 RED→GREEN; +역방향 phone/email/@handle characterization lock — 기존-동작 lock이라 GREEN) + eval-tool-selection.mjs(역방향 골든 2케이스 argIncludes로 arg correctness). mcp 1793, contacts eval 6/6 STABLE 3/3(새 description 무회귀), lint 0. pnpm check의 agent-core 2-fail은 동시 cognition 루프發 stale-dist flake(격리 재실행 1936 green, 내 슬라이스 무관). Opus PASS 6/6: behavioral(RED stash로 격리 확인)·역방향 characterization 정직·outbound-safety 무변경(ambiguous→candidates 무손상)·connections `as:undefined` 미방출.
- **리스크:** 없음에 가까움 — read-only 출력에 사용자 자기 데이터 2필드 추가(fabrication 0, model-authored 아님), ambiguous/unknown fail-closed 경로 무변경, find_contact는 send recipient-resolution 경로 아님(read), 광고 확대로 over-fire 없음(eval birthday/named 케이스 6/6 무회귀). 역방향 부분은 신규 역량 아닌 characterization lock(정직 표기).


## fire 51 · 2026-06-13 · skill v1.14.0 · f54a7fbd
meta: value-class=schema-reach · pkg=@muse/mcp · kind=schema-reach(tasks.list tag filter, productivity 표면) · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 913 무변동(기존 tasks-due-filter.test.ts +4 it) · fabrication 0 유지 · eval:tools personal-crud 6→8 케이스(tag EN/KO 추가, STABLE 3/3)
- **무엇:** `muse.tasks.list`에 `tag` 필터 추가 — tasks는 `tags`가 1급(add 저장·serialize 반환)이고 CLI는 `muse tasks list --tag`로 이미 필터하는데, 에이전트 읽기 도구는 못했다(list=status+dueWithinDays만, search=title+notes만). "work 태그된 할 일 보여줘"가 표현 불가. 대소문자무시 정확매치를 **status·dueWithinDays 양쪽 브랜치**에 대칭 적용(maxListEntries slice 前), tag echo.
- **왜:** 패키지/표면 다양성 — fire 42–50 전부 @muse/mcp 개인데이터(contacts/notes/feeds)라 **생산성(tasks) 표면**으로 전환. RATCHET 압력 없음(43–50 micro-fix 4/8). EXHAUSTION: scout가 매번 진짜 갭 찾았으니 1회 더 정당, LANE B(tasks)로 타이트 조준 → CLI-only tag 비대칭 발굴(filterTasksByTag 이미 존재·테스트됨).
- **리뷰지점:** loopback-tasks.ts(list execute에 matchesTag predicate를 dueWithinDays/status 양쪽 .filter, tag schema property, description+keywords tag/태그) + tasks-due-filter.test.ts(+4: 정확매치+echo+value-flow·exact-not-substring·empty 무시·dueWithinDays+tag 결합) RED 3→GREEN 1797. eval personal-crud +2 tag케이스(argIncludes /work/i, ArgumentCorrectness). check 0(cli 2555·api green), lint 0. Opus PASS 6/6: behavioral(RED real)·양쪽브랜치+slice前·no-tag byte-identical·undefined tags 안전·3-domain 변별 무회귀.
- **리스크:** 없음에 가까움 — no-tag 경로 identity pass-through(byte-identical, tag key 미방출), total=post-filter count, read-only, fabrication 0(tag는 사용자 의도 복사 filter term, groundedArgs는 add의 write-persistence용이라 무관). over-fire 없음(eval 8/8 3-domain 무회귀). 양쪽 브랜치 대칭으로 비대칭 갭 방지(fire 50 교훈 적용).


## fire 52 · 2026-06-13 · skill v1.14.0 · ef78baa8
meta: value-class=new-capability · pkg=@muse/autoconfigure(+@muse/cli move,+@muse/agent-core import) · kind=new-tool(EXPANSION, relationship/companion 표면) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 913→914(+relationship-tool.test.ts) · fabrication 0 유지 · eval:tools overdue-contacts 신규 3/3 STABLE 3/3
- **무엇:** `overdue_contacts` 에이전트 도구 신설 — Dunbar tie-decay(@muse/agent-core overdueContacts, 캘린더 타임스탬프만·메시지 내용無)로 "연락 뜸해진 사람" 표면화. `muse contacts overdue` CLI만 있고 대화 도구 없었다("누구한테 연락 뜸했지?" 불가). read-only·draft-first(절대 안 보냄). 새 패키지 의존 엣지 회피 위해 도구를 **@muse/autoconfigure**(이미 agent-core+tools+mcp 의존)에 두고, 순수 `interactionsFromEvents`를 거기로 이동(CLI 재export). registry 배선: queryContacts + calendarRegistry.listEvents(Date→ISO) → interactions.
- **왜:** 패키지/표면 다양성(fire 42–51 전부 @muse/mcp) + KIND를 schema-reach(50·51)에서 new-tool로. EXHAUSTION 적용: math_eval 견고성 후보를 직접 검증 → **not-a-bug**(양 구현 malformed throw·comma 의도적 strip) 확인 후 value-class 올림. overdue/week_agenda는 cross-pkg event-reader 이동 필요로 처음엔 defer 검토했으나, autoconfigure-home + DI로 overdue는 loop-sized 판명(week_agenda는 backlog 분해 기록).
- **리뷰지점:** relationship-tool.ts(interactionsFromEvents 이동 + `createOverdueContactsTool`, limit 1–50, now 주입) + index.ts(import+재export+registry 등록, calendarRegistry Date→ISO map·undefined 가드) + commands-contacts.ts(로컬 def 제거·autoconfigure import·재export, 미사용 ContactInteractions import 제거) + relationship-tool.test.ts(+4: 실 타임스탬프로 overdue 흐름·count0·limit·interactionsFromEvents 매치) RED→GREEN 513. eval `buildOverdueScenario`(overdue_contacts vs find_contact); EN "who haven't I talked to"가 fire50의 "who is" 광고와 충돌→find_contact 오선택 0/3 → **테스트 약화 말고 description 샤프닝**(정확 질문 선두+named-lookup 아님 대비)→3/3. check 0(cli 2555·api green), lint 0. Opus PASS 6/6: behavioral(실 overdueContacts 수학)·wired·이동안전(중복0·commands-recap caller까지 재export 해소·미사용 import 확인)·read-only/draft-first/timestamps-only·arg clamp·autoconfigure-home 사이클 없음.
- **리스크:** 없음에 가까움 — read-only·draft-first(send 표면 0)·타임스탬프만(내용 미접근, fabrication 0), MUSE_LOCAL_ONLY 무변경. cross-pkg 이동이 유일 리스크나 judge가 byte-identical·전 caller(test/recap/command) 재export 해소·미사용 import 제거 확인. autoconfigure를 도구 home으로 둔 건 조립층 합성(contacts+calendar+agent-core)이라 합당, 새 의존 엣지 0.


## fire 53 · 2026-06-13 · skill v1.14.0 · b7284276 (+ JUDGE 실패-드릴)
meta: value-class=hardening · pkg=@muse/mcp · kind=schema-reach/completeness(tasks.search tags) · verdict=PASS · firesSinceDrill=0 (드릴 완료 리셋)
ratchet: testFiles 914→915(+tasks-search-tags.test.ts) · fabrication 0 유지 · eval:tools tasks-tag(list vs search) 신규 3/3 STABLE 3/3
- **무엇:** `muse.tasks.search`가 `tags`도 매치 — fire 51은 list에 tag FILTER를 줬지만 search는 title+notes만이라 "work" 태그(제목/노트엔 없는) 작업을 "work" 검색으로 못 찾았다. 필터에 tags 절(대소문자무시 substring) 추가 → tag 스토리 완성(list=정확라벨 필터, search=tag 텍스트 find). + 8연속 PASS 도달 JUDGE 실패-드릴.
- **왜:** firesSinceDrill 7→8연속 PASS 트리거(미루기 불가). 드릴 vehicle은 backlog 러너업(작고 깨끗). 드릴: 고의 inert 버전 먼저 주입(description은 "tags 검색" 광고, 필터 그대로 title+notes만 = 허위광고; 테스트는 선언-only로 description.contains("tags")만) → **독립 ④b verifier가 FAIL**(경험적: 서버 빌드+태그-only 작업 seed → search→total:0 + 선언-only 적발) → git restore 롤백 → 진짜 fix TDD. 드릴이 maker≠judge 보상통제(verifier가 나쁜-슬라이스 잡음) 입증. 드릴 5/5(fire 10·21·31·45·53).
- **리뷰지점:** loopback-tasks.ts(search 필터 tags 절 + description/module-doc/query-arg-hint 정직 갱신 + tag 키워드) + tasks-search-tags.test.ts(+2 행동: 태그-only "work" 발견·title-match 유지·home 제외·대소문자무시) RED 2→GREEN. eval `buildTasksTagScenario`(list+search 동시 노출, "tagged work"→list 정확필터·"search for X"→search 변별, tag 키워드 추가 後 선택 회귀 가드) 3/3. mcp 1799(격리), lint 0. pnpm check의 playbook-store weighted-eviction 5초 타임아웃은 동시-load flake(33/33 격리 green). Opus 진짜-fix PASS 6/6: 필터 절 live(RED/GREEN flip 독립 확인)·행동테스트·undefined tags 안전·status/cap/sort 무변경·선택 무회귀·드릴 결함 진짜 해소.
- **리스크:** 없음에 가까움 — 필터에 1절 추가(no-tag 작업 `?? false` 안전), 기존 title/notes 매치·status·50cap·newest-first 무변경, read-only·fabrication 0(결정적 substring). 선택 회귀 위험(tag 키워드 추가)은 list-vs-search eval 3/3로 가드. 드릴은 코드 잔존 0(전량 롤백 後 진짜 fix만 커밋).
