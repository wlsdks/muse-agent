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


## fire 54 · 2026-06-13 · skill v1.14.0 · 2bb7731c
meta: value-class=new-capability · pkg=@muse/autoconfigure(+@muse/cli move) · kind=new-tool(EXPANSION, calendar/productivity 표면) · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 915→916(+week-agenda-tool.test.ts) · fabrication 0 유지 · eval:tools week-agenda(merged vs list) 신규 4/4 STABLE 3/3
- **무엇:** `week_agenda` 에이전트 도구 신설 — events+tasks+birthdays를 다음 N일 day별 병합("what's my week look like?"). `muse week`는 CLI-only라 대화에선 calendar.list+tasks.list+birthdays를 8B가 직접 체이닝·병합해야 했다(불안정). 단일 호출 read-only 도구로 노출. 순수 `groupWeekAgenda`(+WeekDay/WeekAgendaInput+헬퍼, clean()=터미널주입 strip 포함)를 apps/cli→@muse/autoconfigure 이동(CLI 재export·DAY_MS 잔류), weather 제외(자체 도구).
- **왜:** backlog 최상단 ◦(fire 48/52 scouted, decomposed). 8B에 다중-도구 체이닝은 신뢰성 낮음→단일 병합 도구가 tool-calling.md 부합(진짜 가치). KIND=new-tool(최근 schema-reach 흐름과 다름), 표면=calendar/productivity. fire-52 패턴(autoconfigure-home+DI, 새 의존 엣지 0) 재사용.
- **리뷰지점:** week-agenda-tool.ts(groupWeekAgenda+헬퍼 이동 + `createWeekAgendaTool`, days 1–14 clamp, now 주입, readonly lines→`[...]` mutable) + index.ts(import+재export+registry 등록: calendarRegistry Date→ISO·readTasks open+dueAt·resolveUpcomingBirthdays withinDays14) + commands-week.ts(로컬 def/헬퍼/타입 제거·재export·DAY_MS 유지·미사용 stripUntrustedTerminalChars import 제거) + week-agenda-tool.test.ts(+3 행동: Today/Tomorrow/🎂/☑ 버킷팅·days창 제외·empty) RED→GREEN 516. eval `buildWeekAgendaScenario`(week_agenda vs calendar.list vs tasks.list 겹침 변별); EN "what's my week"가 calendar.list로 0/3 오선택 → **description 샤프닝**(질문 선두+events만은 calendar list 대비)→4/4. cli 2555(이동 무손상), lint 0. Opus PASS 6/6: behavioral(실 groupWeekAgenda 버킷팅)·wired·이동안전(중복0·clean 이동으로 터미널보호 유지·재export 해소)·read-only/fabrication0·days clamp·readonly→mutable 정확.
- **리스크:** 없음에 가까움 — read-only·fabrication 0(출력=실 store 파생, clean()로 터미널주입 strip 유지), MUSE_LOCAL_ONLY 무변경. 겹침 도구(calendar.list/tasks.list) 선택 회귀 위험은 eval 4/4로 가드. cross-pkg 이동이 유일 리스크나 judge가 byte-equivalent·중복0·재export 전 caller 해소·clean 보호 이동 확인. pnpm check의 agent-core byte-strip 5초 타임아웃은 동시-load flake(격리 green, 내 미터치).


## fire 55 · 2026-06-13 · skill v1.14.0 · 25913406
meta: value-class=hardening · pkg=@muse/mcp · kind=security-fix(web_action SSRF-after-redirect) · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 921 무변동(기존 web-action.test.ts +1 it) · fabrication 0 유지 · eval 무변경(schema/name 동일)
- **무엇:** `web_action`(risk:execute, 모델-선택) SSRF-after-redirect 구멍 차단 — SSRF 가드(assertPublicHttpUrl)는 원본 URL만 1회 검사하는데 fetchImpl에 `redirect` 옵션 없어 default follow → 3xx로 private/loopback(127.0.0.1·169.254.169.254 메타데이터)까지 따라가고 307/308은 body도 재전송. `redirect:"manual"` + 3xx fail-closed(performed:false·Location 로그)로 수정.
- **왜:** 비-개인데이터 고가치 hardening(보안). scout가 비대칭으로 버그 증명: READ 경로(fetchReadableUrl)는 redirect 後 최종 host 재검증하는데 더 위험한 WRITE 경로가 빠뜨림. RATCHET 압력 없음·KIND=security-fix(개인데이터-wrap 흐름 탈출). math_eval처럼 non-bug일까 scout가 핸들러+테스트 실독 검증 → 진짜 결함.
- **리뷰지점:** web-action.ts(fetch init `redirect:"manual"` + response.ok 後 3xx 분기 fail-closed+log, 307/308 포함 >=300&&<400) + web-action.test.ts(+1 행동: fake fetch가 real 모사—follow→200 unless manual; RED는 performed:true=SSRF성공 실증→GREEN performed:false+`init.redirect==="manual"`+로그). mcp 1811(2xx/429/5xx/deny/timeout 계약 무회귀), check 0, lint 0. Opus PASS 6/6: fix real(redirect:manual 메커니즘)·behavioral RED→GREEN·no-collateral(브랜치 순서 .ok 後)·floor 강화·opaqueredirect 엣지도 fail-closed.
- **리스크:** 없음 — floor 강화(outbound-safety SSRF), risk:execute 유지·approval 먼저 그대로, 정상 2xx/429/5xx 경로 무변경(3xx만 새 분기), 3xx는 미적용 redirect라 false-failed 아님. 동시 루프가 워크트리 churn(내 test를 먼저 커밋, fix는 별도 커밋 25913406으로 통합—HEAD test+fix green 확인). MUSE_LOCAL_ONLY·fabrication·banking 무관.


## fire 56 · 2026-06-13 · skill v1.14.0 · (no slice — floor-blocker diagnosis)
meta: value-class=diagnosis · pkg=none(@muse/recall grounding domain) · kind=regression-triage · verdict=ESCALATED · firesSinceDrill=2
ratchet: testFiles 923 무변동 · fabrication FLOOR BREACHED (한국어 0/4 — 내 슬라이스 아님) · eval 무변경
- **무엇:** TOOL 슬라이스 없음. ①의 회귀가 fabrication-floor breach(한국어 faithfulness 0/4, 모든 push 차단)라 그게 이번 fire — 진단+에스컬레이션. precheck:grounding 재실행 0/4 일관(real), latin 16/17 정상.
- **왜:** fire 55가 ca7b1863(recall 리팩터)을 용의자로 지목했으나, 그 commands-ask.ts diff 정독 결과 **순수 byte-identical relocate**(buildAskConnections=`--connect` 푸터, faithfulness 경로 아님) → **무죄**. origin..HEAD에 다른 grounding 변경 없음. 한국어 케이스는 precheck-grounding.mjs에 없고 공유 grounding-eval 모듈에서 생성 → grounding 도메인 깊숙이, TOOL 테마 밖.
- **리뷰지점:** 진단만 — 코드 변경 0(backlog 블로커 기록 + 이 저널). 패턴: 한국어 answerable이 un-retrieved 소스 인용(retrieval 실패) + refuse가 confident(추상 실패) → 양방향 Korean 캘리브레이션 회귀. grounding 루프/진안이 공유 grounding-eval 모듈 + Korean retrieval/embedder 확인 필요.
- **리스크:** MUSE_SKIP_PREPUSH 절대 금지(IMMUTABLE-CORE) 준수 — floor 우회 안 함. tool-hardening 커밋(fire 55 SSRF 등)은 로컬 main에 안전하게 쌓이며 floor 풀리면 origin 도달. 이 fire는 코드 무변경이라 회귀 유발 0.

> ✅ **fire 56 RESOLVED (진안 directive: this loop fixes the floor):** the Korean faithfulness 0/4 was a BATTERY bug, NOT a grounding regression. `verify-faithfulness-rate.mjs` hardcoded the LEGACY embedder `nomic-embed-text` (EN-centric v1, ~50% KO hit@1) instead of the PRODUCTION default `DEFAULT_EMBED_MODEL = nomic-embed-text-v2-moe` (100% KO, the 2026-06-10 measured upgrade). The battery measured a Korean "coverage gap" the product never ships. Decisive proof: re-ran the battery with v2-moe → hangul faithfulness 0/4→**4/4**, false-refusal 0/12, overall PASS. Fix = use DEFAULT_EMBED_MODEL (one import + one line + the stale comment). `precheck:grounding` now exits 0 → ALL PUSHES UNBLOCKED. fire-55's ca7b1863 suspect correctly disproved (clean footer relocate). value-class=hardening (fix the floor's own test to match production), pkg=apps/cli battery.


## fire 57 · 2026-06-13 · skill v1.14.0 · (sweep attempted → REVERTED, finding recorded)
meta: value-class=revert+finding · pkg=apps/cli grounding batteries · kind=unsafe-sweep-reverted · verdict=REVERTED · firesSinceDrill=3
ratchet: testFiles 무변동(가드 제거) · fabrication 0 유지 · eval 무변경
- **무엇:** fire-56 후속으로 "13개 grounding/eval 배터리가 legacy `nomic-embed-text` 하드코딩 → 전부 프로덕션 `DEFAULT_EMBED_MODEL`(v2-moe)로 정렬 + 가드 테스트" 슬라이스를 시도했으나 — **v2-moe로 바꾸니 cited-recall 2/6 FAIL**(in-corpus "home insurance renew?" cosine 0.546 → confident→ambiguous)라 **안전하지 않아 ROLLBACK**(7 스크립트 legacy 복원 + 가드 제거).
- **왜:** ★발견 — fire 56(faithfulness-rate)는 RGV rubric 경로라 v2-moe 안전했지만, **cosine-임계값 배터리(cited-recall 등)는 `classifyRetrievalConfidence` 임계값이 옛 nomic-embed-text의 cosine 분포에 캘리브레이션**돼 있다. v2-moe는 절대 cosine이 낮음(상대 ranking은 우수, KO hit@1 100%)이라 borderline in-corpus가 confident→ambiguous로 떨어진다. 즉 "임베더만 바꾸면 됨"이 아니라 **임계값 재캘리브레이션이 필요**. 동시 루프가 내 미커밋 sweep을 HEAD에 쓸어담아 깨진 배터리가 main에 올랐고 → 이 revert로 un-break.
- **리뷰지점:** revert = 7 grounding 배터리(grounding-delta(-squad)·cited-recall·rubric-gate·chat-grounding-rate·proactive-recall-gate·council-self-abstention) DEFAULT_EMBED_MODEL→legacy 복원 + grounding-embedder-guard.test.mjs 제거. 7개 node --check OK. faithfulness-rate(fire 56)는 v2-moe 유지(안전 검증됨).
- **리스크/발견(grounding 도메인):** ★PRODUCTION 함의 — 프로덕션이 v2-moe + 동일 `classifyRetrievalConfidence` 임계값을 쓰면, borderline in-corpus 질문("home insurance renew?")을 over-refuse할 수 있다(소스는 rank1 retrieve되나 cosine이 confident 임계 아래). cited-recall 케이스가 그걸 시사. grounding 루프/진안이 v2-moe용 confidence 임계값 재캘리브레이션 검토 필요(이번 fire는 tool-hardening 테마라 deep-fix 안 함, 정직 기록).


## fire 58 · 2026-06-13 · skill v1.14.0 · a9b11117
meta: value-class=hardening · pkg=@muse/mcp · kind=correctness/security-fix(web_action method validation) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 무변동(기존 web-action-tool.test.ts +3 it) · fabrication 0 유지 · eval 무변경(selection 동일)
- **무엇:** `web_action`(risk:execute, 모델-선택)이 모델이 준 `method`를 검증 없이 uppercase→fetch에 전달. (1) "book/post" 의도에 GET 방출→아무것도 안 바뀌는데 2xx로 `performed:true`(**silent false-success**), (2) garbage verb→opaque throw/405. 모듈 allow-set {POST,PUT,PATCH,DELETE}를 스키마 enum + 핸들러가 공유, approval/HTTP 前 fail-closed(reason:invalid-method).
- **왜:** 2 그라운딩 우회 후 TOOL 복귀. Opus scout가 home_action(고정-config URL, redirect-SSRF 무의미) 회피하고 진짜 갭 발굴: summary·url(SSRF)은 검증하는데 method만 누락 — 모델-named arg의 wrong-result(silent false-success는 사용자가 모름). 단일파일·결정적 테스트·고가치. value-class=hardening(보안/correctness), KIND=correctness-fix(최근 revert/diagnosis와 다름).
- **리뷰지점:** web-action-tool.ts(WEB_ACTION_METHODS const + 스키마 enum:WEB_ACTION_METHODS + 핸들러 검증 SSRF後·performWebActionWithApproval前 fail-closed) + web-action-tool.test.ts(+3: GET/frobnicate→performed:false+reason+calls0, put→PUT 발사) RED(garbage→performed:true 실증)→GREEN 1814. check 0, lint 0. Opus PASS 6/6: behavioral RED→GREEN 독립 재현·fail-closed 순서(SSRF後 gate前)·default POST 무회귀·enum↔핸들러 동일 const drift불가·risk:execute/approval/SSRF 무변경.
- **리스크:** 없음 — fail-closed 추가만(정상 state-change는 allowed verb라 false-reject 없음), default POST·valid verb(대소문자무시)·deny/timeout/SSRF/clarify 계약 무회귀. outbound-safety 강화(bad verb를 gate 前 차단), MUSE_LOCAL_ONLY·fabrication·banking 무관. eval 불필요(name/keywords 동일, enum만 추가).


## fire 59 · 2026-06-13 · skill v1.14.0 · 91eda173
meta: value-class=new-capability · pkg=@muse/mcp(+@muse/autoconfigure wiring) · kind=new-tool(EXPANSION, objectives/autonomy 표면) · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 928→929(+objectives-tool.test.ts) · fabrication 0 유지 · eval:tools objectives 신규 3/3 STABLE 3/3
- **무엇:** `list_objectives` 에이전트 도구 신설 — Muse가 자율로 추적하는 standing objectives("watch X / until Z / tell me when W")를 대화에서 나열. CLI(`muse objectives`)+passive 주입만 있고 에이전트 도구 없었다. read-only, live(active/escalated)만, spec/kind/status/createdAt만 투영(userId/내부 backoff 필드 비노출).
- **왜:** email 표면 점검 clean·math_eval(52) clean → correctness-버그 vein 얇아짐, EXHAUSTION대로 value-class 올림(EXPANSION). 새 표면(objectives/자율)·read-only(outbound-adjacent지만 list만이라 floor 무위험). readObjectives @muse/mcp라 contacts 패턴 clean wrap.
- **리뷰지점:** objectives-tool.ts(`createObjectivesListTool`, status active||escalated 필터, 안전 필드 투영) + index.ts export + autoconfigure 등록(readObjectives(resolveObjectivesFile(env))) + objectives-tool.test.ts(+2: live만·done/cancelled 제외·empty) RED→GREEN 1821. eval `buildObjectivesScenario`(list_objectives vs tasks.list, EN/KO). EN 케이스가 처음 "working on right now"로 small-talk 모호→미선택 0/3 → 명확 "objectives tracking" intent로 조정(over-invocation은 별도 트랩) → 3/3. check 0, lint 0. Opus PASS 6/6: behavioral·wired·read-only 불변식·필드누출 없음·live-filter 시스템 컨벤션 일치.
- **리스크:** 없음 — read-only(생성/행위 경로 없음, gated objectives path 별개), userId/attempts/nextEvalAt 등 내부필드 비노출, live-filter가 situational-briefing/grounding-injection과 동일 정의. MUSE_LOCAL_ONLY·fabrication·banking 무관. tasks.list 선택 회귀 없음(eval 3/3).


## fire 60 · 2026-06-13 · skill v1.14.0 · 9a0d022e
meta: value-class=hardening · pkg=@muse/mcp · kind=security-fix(home_action entity-less blast radius) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 무변동(기존 smart-home-tool.test.ts +3 it) · fabrication 0 유지 · eval 무변경(schema 동일)
- **무엇:** `home_action`(risk:execute, 모델-선택)이 `entity` optional이고 target 없이도 발사 → HA의 call_service에 target 없으면 **도메인 전체** 적용(entity 없는 `light.turn_off`=온집 전등 끔, `lock.unlock`=모든 잠금 해제), approval summary에도 target 안 보여 사용자 무경고. entity arg 또는 data의 target키(entity_id/area_id/device_id/target) 없으면 approval/HTTP 前 fail-closed.
- **왜:** read-tool wrap vein 얇아져 Opus scout가 **액추에이터-하드닝 sub-vein**(state-changing 도구의 optional arg가 만드는 fail-open blast radius) 발굴. cold file(6/1 이후 무변경)·@muse/mcp(agent-core churn 회피)·단일파일·결정적 테스트. fail-open→fail-closed 보안 고가치, KIND=security-fix.
- **리뷰지점:** smart-home-tool.ts(data/entity 파싱 後·performHomeActionWithApproval 前 target-presence 가드) + smart-home-tool.test.ts(+3: entity-less→performed:false+calls0, scene+entity 발사, data area_id 발사) RED(entity-less→performed:true 실증)→GREEN 1825. check의 @muse/messaging 실패는 동시-load flake(격리 368 green). lint 0. Opus PASS 6/6: behavioral RED→GREEN 독립 재현·fail-closed 순서·positive control 실증·over-strict 아님·risk:execute/approval 무변경.
- **리스크:** 없음 — fail-closed 추가만(정상 entity/scene/script/data-target 발사 유지, 실 디바이스 제어는 항상 target 보유라 false-reject 없음), CONFIRM/DENY/format/5xx 무회귀. follow-up(minor): 빈 data-target(data:{entity_id:""})은 !==undefined 통과 — 비현실적 우회(bare-service under-spec이 현실 경로). MUSE_LOCAL_ONLY·fabrication·banking 무관.


## fire 61 · 2026-06-13 · skill v1.14.0 · (vein thinning — honest close, no slice)
meta: value-class=exhaustion-report · pkg=none · kind=vein-thinning-honest-close · verdict=NO-SLICE · firesSinceDrill=8
ratchet: testFiles 무변동 · fabrication 0 유지 · eval 무변경
- **무엇:** TOOL 슬라이스 없음. 적대 Opus scout가 cold MCP/도구 표면을 철저히 sweep → 전부 correct/covered, 남은 건 description-only(avoid-list)거나 hot agent-core. EXHAUSTION 규칙(억지 약슬라이스 금지)대로 정직한 vein-thinning 종료 + 블로커 기록.
- **왜:** ~14 substantive fire 후 깨끗한 고가치 단일파일 vein 고갈. scout 검증: ToolOutputSanitizer(50k cap·injection-defang) 커버, messaging send-gate 견고, official-MCP preset fail-close, loopback 서버들 검증됨. 구조적 타깃(DefaultToolFilter·capToolOutput)은 @muse/agent-core(hot, 동시 루프 충돌).
- **리뷰지점:** 코드 변경 0(backlog 블로커 + 이 저널). ★실 발견: `riskFromMcpAnnotations`(transport.ts:254)가 annotation 없는 외부 MCP 도구를 "read" 기본값 → approval 우회 = MCP 스펙 위반 fail-open. 단 fix(gated 기본값)는 un-annotated read 도구 over-gating 트레이드오프라 **진안-결정 보안-포스처**(autonomous behavior change 부적절). opt-in 외부 MCP(allowlist) 스코프, official preset은 known 서버 re-stamp.
- **리스크:** 없음 — 코드 무변경(회귀 0). 정직 종료가 EXHAUSTION 규칙의 의도(스카웃 더 하드하게가 아니라 value-class 올리거나 정직 보고). 루프는 다음 fire 계속 — 진안이 테마 pivot 또는 MCP-risk 포스처 결정 가능.


## fire 62 · 2026-06-13 · skill v1.14.0 · 795097c0
meta: value-class=schema-reach · pkg=@muse/mcp · kind=schema-reach(calendar.list query filter, calendar 표면) · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 931→932(+loopback-calendar-list-filter.test.ts) · fabrication 0 유지 · eval:tools personal-crud +1 calendar query 케이스(9/9 STABLE)
- **무엇:** `muse.calendar.list`에 optional `query` 텍스트 필터 추가 — from/to/provider만 있고 텍스트 필터 없어 "find my meeting with Bob this week"가 표현 불가(reminders.list는 search 있음). title+location+notes 대소문자무시 substring, registry.listEvents 後 적용, query echo. no-query는 byte-identical.
- **왜:** fire 61 vein-thinning 후 scout 러너업(calendar.list 텍스트 필터)이 calendar loop churn으로 deprioritize됐으나 — 파일이 clean(머지 없음)이라 fast-commit으로 진행. tasks.list tag(fire 51)와 동일 패턴, 실 가치 schema-reach. KIND=schema-reach(최근 security-fix/new-tool과 다름).
- **리뷰지점:** loopback-calendar.ts(list execute에 query 필터 + 스키마 query property + description, list 블록만 — add/update/delete 무손상) + loopback-calendar-list-filter.test.ts(+3: title/notes 매치·location 매치·non-match0·no-query 전부) RED→GREEN 1828. eval personal-crud +1(calendar query argIncludes /bob/i). check의 @muse/shared byte-hygiene 실패는 **동시 루프 파일 2개**(differentiation.md·eval-policy-symmetry.mjs)의 raw 바이트 — 내 슬라이스 무관(byte-clean). lint 0. Opus PASS 6/6: behavioral·필터 정확(undefined 가드)·no-query byte-identical·add/update/delete 무충돌·selection 무회귀.
- **리스크:** 없음 — list 핸들러/스키마만(self-contained, calendar loop과 무충돌), no-query 경로 무변경, read-only, query는 사용자 검색어(tasks tag/reminders search와 동류, fabrication 무관). 별건: 공유 byte-hygiene 게이트가 동시-루프 파일 2개로 빨감(다음 단계 처리).


## fire 63 · 2026-06-13 · skill v1.14.0 · 428702bb
meta: value-class=new-capability · pkg=@muse/mcp(+@muse/autoconfigure wiring) · kind=new-tool(EXPANSION, transparency/action-log 표면) · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 933→934(+recent-actions-tool.test.ts) · fabrication 0 유지 · eval:tools actions 신규 3/3 STABLE 3/3
- **무엇:** `recent_actions` 에이전트 도구 신설 — Muse의 자율 행위 로그(sends·web·home·refusals)를 대화에서 나열("내 대신 뭘 했어?"). `muse actions` CLI만 있었다. most-recent-first, what/why/result/when/detail만 투영(내부 userId/id/prevHash 비노출). read-only(list만, undo 아님). "shows its work" 정체성 직결 transparency.
- **왜:** list-filter vein 소진(tasks·calendar·reminders 전부 필터 보유) + reminders 완비 확인 → 다른 각도(transparency 역량). action log는 readActionLog @muse/mcp라 contacts/objectives 패턴 clean wrap. KIND=new-tool(최근 schema-reach와 다름), 새 표면(action-history).
- **리뷰지점:** recent-actions-tool.ts(`createRecentActionsTool`, reverse+limit clamp 1–100, 안전필드만) + index.ts export + autoconfigure 등록(readActionLog(resolveActionLogFile(env))) + recent-actions-tool.test.ts(+3: most-recent-first·refusal 노출·limit·empty·민감필드 비노출) RED→GREEN 1831. eval `buildActionsScenario`(recent_actions vs list_objectives, EN/KO). lint 0. pnpm check red는 동시-루프 byte-hygiene 저널 폴루션(moving target, fire 62 기록)+voice flake — 내 슬라이스 무관(mcp 1831·eval 3/3·judge 독립). Opus PASS 6/6: behavioral·wired·민감필드 누출 없음·read-only(undo 아님)·most-recent-first·limit clamp.
- **리스크:** 없음 — read-only(생성/undo 경로 없음), userId/id/prevHash/objectiveId 비노출(transparency지만 내부 무결성필드 보호), fabrication 0(출력=실 로그 필드). readActionLog가 encryption-at-rest 투명 처리(wrong key fail-close). MUSE_LOCAL_ONLY·banking 무관. list_objectives 선택 회귀 없음(eval 3/3).


## fire 64 · 2026-06-13 · skill v1.14.0 · 2805a917
meta: value-class=hardening(schema-reach) · pkg=@muse/mcp · kind=arg-filter(EXPANSION, transparency surface) · verdict=PASS · firesSinceDrill=0(JUDGE-DRILL 완료, 리셋)
ratchet: testFiles 935 유지(+2 케이스 to recent-actions-tool.test.ts) · fabrication 0 유지 · eval:tools actions 3/3 STABLE
- **JUDGE-DRILL(하드카운터 firesSinceDrill≥10 발동):** 고의 나쁜 슬라이스 주입 — `pinned_notes` 도구를 (a)autoconfigure 레지스트리 미배선(inert) (b)execute가 `_deps` 무시하고 `{count:0,notes:[]}` 하드코딩 stub (c)테스트는 definition.name/risk만 보는 선언-only. 빌드 green·테스트 green(1832)으로 "다 된 것처럼" 보였으나 ④b Opus judge가 **4/4 FAIL**(선언-only·inert·fabricated stub·eval 부재) 정확 판정 → git restore 롤백, 트리 클린 확인. maker≠judge 보상통제 + 롤백 경로 재검증 OK.
- **진짜 슬라이스 — 무엇:** `recent_actions`에 optional `result` enum(performed/refused/failed) 필터 추가. 핵심: **filter-BEFORE-limit** — 역순 전체 로그를 result로 거른 뒤 limit slice. refusal/failure가 most-recent-N 밖으로 밀려나도 surface.
- **왜:** fire 63 recent_actions는 most-recent-first + limit cap. "did you refuse anything?"를 default limit로 물으면 최근 performed만 나오고 오래된 refusal을 놓쳐 잘못된 "아니오"(safety-relevant transparency 결함). 마지막 fire new-tool과 KIND 다양성(arg-filter/hardening). TOOL vein thin → 신선 표면(fire63) 하드닝이 가치.
- **리뷰지점:** recent-actions-tool.ts(`result` enum schema + `(filter ? ordered.filter(a=>a.result===rf) : ordered).slice(0,limit)` — filter 후 slice) + 테스트 2개(오래된 refusal이 limit:2 밖인데 result:"refused"로 surface count1 / unknown→0) RED→GREEN 1833. limit-then-filter로 변이 시 RED(judge 실증). 선택 회귀 0(eval 3/3). lint clean. pnpm check: shared byte-hygiene가 동시-루프 저널(test-hygiene.md) raw바이트로 transient red였으나 신선 재실행 34 passed(churn 스냅샷, 내 슬라이스 무관).
- **리스크:** 없음 — read-only 유지, 투영 불변(userId/id/prevHash 비노출), default(result 생략) 경로 byte-identical, strict equality(silent fall-through 없음), enum이 ActionResult 타입 일치. backlog에 phone arg-grounding 후보 기록(email/handle은 ANY-token으로 이름-토큰 false-ground → phone만 유효, agent-core 조용해지면).


## fire 65 · 2026-06-13 · skill v1.14.0 · f685161b
meta: value-class=hardening · pkg=@muse/mcp(+apps/cli test) · kind=arg-grounding(anti-fabrication floor, contacts 표면) · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 939→940(+actuator-tools phone describe in apps/cli) · fabrication 0 강화(highest-harm 필드 보호) · eval:tools 무영향(add_contact 케이스 없음)
- **무엇:** `add_contact`의 `groundedArgs`에 `"phone"` 추가(["relationship"]→["relationship","phone"]). 모델이 fabricate한 전화번호(사용자 미발화)가 contact store 쓰기 전 결정적으로 drop. digit-token이 고유해 fabricated는 drop, stated(+country/spaces 재포맷 포함)는 생존. 드롭된 폰이 유일 연락수단이면 execute가 visible refusal("provide at least one…") — wrong number 무음 persist보다 안전.
- **왜:** grounding FLOOR(제품 엣지) 강화. fabricated 전화번호 persist = 미래 "엄마한테 문자"가 모르는 사람에게 = 최고-해악 contact fabrication. email/handle은 ANY-token에서 local-part=이름 토큰으로 false-ground(false protection), birthday는 MM-DD 재포맷 brittle → phone만 ground(backlog FINDING 기록). RATCHET 패키지 단조(@muse/mcp 편중) 탈출: mcp 메타 + apps/cli 테스트 2패키지.
- **리뷰지점:** contacts-tool.ts:106 한 줄 + apps/cli/actuator-tools.test.ts 신규 describe(도구의 **선언된** groundedArgs를 실 런타임 `groundToolArguments`(agent-runtime.ts:857-859와 동일 함수)에 먹여 fabricated DROP/stated KEEP 검증). live definition에 결합 → 메타 1줄 전 RED, 후 GREEN(2592→2593). 풀-런타임 노출은 write 도구가 isWorkspaceMutationPrompt 게이트(워크스페이스 변경용, contacts와 불일치)에 막혀 정책 주입 없이 불가 → grounding과 무관한 exposure 게이트 대신 grounding 함수 직접 검증(더 깨끗). pnpm check 전체 green, lint clean. Opus judge PASS 5/5(RED-before 결정적 재현).
- **리스크:** 거의 없음 — 순수 additive(relationship grounding 유지, 타 arg default 경로 불변). 유일 한계: 사용자가 구분자로 쓴 번호를 모델이 무구분자로 concatenate하면 false-drop(좁음, 스키마가 구분자 보존 유도) — 기록됨. read 경로/타 도구 무영향, MUSE_LOCAL_ONLY/banking 무관.


## fire 66 · 2026-06-13 · skill v1.14.0 · ce342ee5
meta: value-class=hardening · pkg=@muse/browser(+apps/cli wiring) · kind=security-fix(outbound-safety fail-close, browser 표면) · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 942→942(+4 케이스 browser-tools.test) · fabrication 0 유지 · 패키지 다양성 ✓(@muse/mcp 8연속 탈출 → @muse/browser)
- **무엇:** `browser_key`의 **Enter만** draft-first 게이트(browser_click/type와 동일 BrowserApprovalGate). navigation 키(Escape/Tab/Arrow)는 free 유지, 게이트 미배선 시 Enter fail-close(무게이트로 안 눌림). throwing 게이트는 catch→deny.
- **왜:** browser_click/type은 게이트되나 `browser_key`(risk:read, 무게이트)의 Enter("confirm the focused control")가 포커스된 폼/버튼을 **제출/post** → outbound-safety 계약("state-changing acts carry the gate")의 fail-OPEN. browser_type submit=true는 이미 게이트된 submit 경로 → 갭은 **무게이트 Enter 프리미티brt** 한정. RATCHET 패키지 단조(@muse/mcp 8연속) 탈출.
- **리뷰지점:** browser-tools.ts(BrowserActionDraft.action+"key"; BrowserKeyToolDeps optional approvalGate; execute에서 key==="Enter"만 게이트→미승인 시 pressKey 전 return {pressed:false}) + actuator-tools.ts buildBrowserTools(createBrowserKeyTool에 click/type와 동일 `gate` 배선, 이전 무게이트) + 테스트 4개(deny→pressKey 미호출/no-gate fail-close/approve→key draft 확인/Tab free) RED→GREEN. 게이트 블록 삭제 변이 시 정확히 3 RED(judge 실증). risk는 "read" 유지(navigation 자유 노출, Enter는 내부 게이트로 보호 — 라벨이 아닌 게이트가 보호). pnpm check 전체 green, lint clean.
- **리스크:** 순수 additive(게이트 추가만, 약화 0). Escape/Tab/Arrow 무영향(over-gate 안 함), 기존 browser_key 테스트(Escape press·unknown-key reject) green. read 경로 무관, banking 무관. browser_type 게이트 경로 불변.


## fire 67 · 2026-06-13 · skill v1.14.0 · 5fc68670
meta: value-class=wiring(capability+outbound-safety Rule 3) · pkg=@muse/macos(+apps/cli wiring) · kind=recipient-resolution(messaging 표면) · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 942→942(+4 케이스 macos-tools.test) · fabrication 0 강화(수신자 해소-not-guessed) · 패키지 다양성 ✓(@muse/macos 신규 표면, mcp 탈출 3연속)
- **무엇:** `mac_message_send`가 수신자 NAME을 contacts 그래프에서 해소(`resolveRecipient` 콜백 주입). "Jane한테 문자"가 contacts의 Jane 번호로 완성. ambiguous/unknown은 send 전 fail-close(추측 번호 없음), 명시 `to`는 우선(back-compat). 해소된 번호는 동일 draft-first 게이트 통과(사용자 확인 유지).
- **왜:** mac_message_send만 유일하게 named-recipient를 contacts에서 안 풀어(email은 전부 resolveContact) "text Jane"이 needs-recipient로 dead-end — 누락 역량 + outbound-safety Rule 3 갭(가장 blast-radius 큰 네이티브 actuator가 "resolved, never guessed" 부재). email 패리티로 끌어올림. RATCHET: @muse/macos 신규 표면(mcp 3연속 탈출), KIND=recipient-resolution(최근 security-fix/arg-grounding과 다름).
- **리뷰지점:** macos-tools.ts(MacRecipientResolution 타입 + resolveRecipient dep; recipientName arg; execute가 to 빈+name+resolver일 때만 해소, ambiguous→reason 반환 send 전, !resolved→needs-recipient send 전, resolved만 to 세팅 후 기존 게이트) + actuator-tools.ts(resolveContact import + buildActuatorTools macActuators 분기에 resolveRecipient 배선: resolveContact(queryContacts(resolveContactsFile(env)))→phone??email) + 테스트 4(resolved→runner가 해소번호/ambiguous→runner 미호출·미로그/unknown→resolver 호출됨·send 0/raw to passthrough) RED→GREEN 104. required ["to","body"]→["body"], recipientName groundedArgs 추가. macos는 여전히 @muse/mcp 미의존(주입). pnpm check 전체 green, lint clean. Opus judge PASS 5/5(가드/배선 변이 실증).
- **리스크:** 거의 없음 — 해소 번호는 오직 resolver(contacts) 출력, 도구가 합성 안 함; ambiguous/unknown은 send 0(부분 부작용 없음); 명시 to 경로 불변(회귀 0); 동일 승인 게이트 유지(우회 없음). recipientName grounding으로 위조 이름 상위 드롭. macos-mcp 의존 경계 유지.


## fire 68 · 2026-06-13 · skill v1.14.0 · 59319061
meta: value-class=hardening · pkg=@muse/macos(+apps/cli wiring) · kind=ambiguous-clarify-quality(messaging 표면, fire67 완성) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 944→944(+1 케이스 macos-tools.test) · fabrication 0 유지 · 패키지 macos 연속(fire67-68, 단 KIND 다름: resolution→clarify-quality)
- **무엇:** `mac_message_send`의 ambiguous 수신자 해소가 후보 contact **이름**을 반환(email `candidates` 패리티). 모델이 "Jane Park or Jane Doe?"로 정밀 재질문(막연한 "which one?" 대신). 여전히 fail-close(sent:false, 자동선택 없음). 이름만 경계 넘음(폰/이메일 0), 로컬 모델만.
- **왜:** fire 67이 수신자 해소를 추가했으나 ambiguous는 count만 반환 → 비가역 outbound send에서 모델이 추측 유도. email은 이미 candidates 반환 → mac이 laggard. 정밀 disambiguation = wrong-recipient 리스크 감소(outbound-safety 품질). EXHAUSTION 상황(모든 표면 covered, 신호 clean)에서 fire67 story의 정직한 완성.
- **리뷰지점:** macos-tools.ts(MacRecipientResolution.candidates 추가; ambiguous 분기가 이름 반환+detail에 명명, resolved/unknown 경로 불변) + actuator-tools.ts(resolveRecipient ambiguous가 resolution.matches.map(c=>c.name) 매핑, 이전 count만) + 테스트 1(ambiguous→candidates 배열+detail 명명, sent:false) RED→GREEN 105. pnpm check 전체 green, lint clean. Opus judge PASS 5/5(엄격 value-axis: value 흐름·fail-close 유지·이름만 누출, not too-incremental).
- **리스크:** 거의 없음 — ambiguous는 여전히 send 0(자동선택 없음, 부분 부작용 없음), resolved/unknown 불변, 이름만 노출(폰/이메일 미노출, 로컬 egress). 솔직: 작은 슬라이스(fire67 표면 폴리시)지만 email 패리티+비가역 send 정밀화로 가치 실재(judge 확인). vein thin 지속 → 다음 fire value-class 상향 고려.


## fire 69 · 2026-06-13 · skill v1.14.0 · cc0c81f8
meta: value-class=hardening · pkg=scripts(eval infra) · kind=arg-correctness-regression-coverage(시간 필드, eval:tools) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 944→944(eval-harness.test +1 case, scripts는 testFiles 카운트 밖) · fabrication 0 유지 · 패키지 다양성 ✓(scripts 신규 영역, mcp/macos 탈출) · eval:tools personal-crud 9/9·notes 11/12·내 5케이스 STABLE 3/3
- **무엇:** 필드-타깃 스코어러 `argFieldMatches(field, regex)` 신설 + `argFieldIncludes` 케이스 옵션 + calendar/reminder add 5케이스가 dueAt/startsAt이 사용자 **phrase 토큰**(내일/오전/오후/tomorrow) 보유함을 단언. precomputed ISO엔 phrase 토큰 없음 → 회귀 잡힘.
- **왜:** 골든 케이스가 시간 구절을 담지만 `requireArgs` 존재만 검증, VALUE 미검증 → `*Iso` 필드명이 8B에 잘못된 weekday+TZ 사전계산시킨 SHIPPED 버그(project_tool_time_field_naming 0/8→8/8)의 회귀를 eval이 **못 잡았음**. 기존 argMatches는 blob-scoped(text 필드의 토큰으로 false-pass). EXHAUSTION(모든 표면 covered) → value-class 상향, 테마 #2(argument correctness). Opus 스카웃이 방향1(논문)·2(새역량) 무수확 정직 보고 후 이 갭 발굴.
- **리뷰지점:** eval-harness.mjs(argFieldMatches: arguments[field]만 테스트, absent/non-string fail-close) + eval-harness.test.mjs(회귀 대비: ISO-in-dueAt+phrase-in-text → blob argMatches WRONGLY pass, argFieldMatches 정확 FAIL; 15 pass) + eval-tool-selection.mjs(caseScorer 와이어 + 5케이스 argFieldIncludes phrase regex). 라이브 STABLE 3/3. pnpm check green(scripts는 패키지 빌드 무관), lint clean. Opus judge PASS 5/5(field-scoped 실증, 선행 followup 내 무관 확정).
- **리스크:** 없음 — 순수 additive(argFieldIncludes opt-in, 기존 케이스 불변), scripts 전용(패키지 src 0). regex는 phrase 토큰(digit 아님)이라 ISO false-pass 없음. 선행 발견(followup.cancel/snooze 오선택 60%)은 내 무관, backlog 기록(다음 후보). honest: scripts/eval 슬라이스지만 SHIPPED 회귀 재무장 = 실가치(judge 확인).


## fire 70 · 2026-06-13 · skill v1.14.0 · 26b5d4ff
meta: value-class=hardening · pkg=@muse/mcp(+scripts eval) · kind=tool-selection-fix(followup cancel/snooze 한방 선택) · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 944→945(personal-followups-store.test +resolveFollowupRef describe, mcp.test +word-ref case) · fabrication 0 유지 · eval:tools followup 60%→**100%** STABLE 3/3
- **무엇:** followup.cancel/snooze가 `id`(EXACT) 대신 **word/id ref**를 받아 한 방 동작. `resolveFollowupRef`(summary 단어 OR id 매칭, scheduled 우선, ambiguous→candidates, unknown→not-found) 신설 + cancel/snooze execute 배선(unique만 동작, 해소된 id 전달, ambiguous는 후보 반환 무동작) + id 설명에 예시("distinct word from summary") + "list 먼저 불필요" 라인.
- **왜:** eval:tools가 followup.cancel/snooze를 followup.list로 오선택(60%, fire-69 발견). 근본원인: bare `id`라 모델이 id 없어 list 먼저. reminders.snooze는 word 받아 한 방 → 패리티. 테마 #1(올바른 tool 한 방).
- **리뷰지점:** personal-followups-store.ts(resolveFollowupRef, resolveReminderRef 미러) + loopback-followups.ts(cancel/snooze execute 해소+설명) + personal-followups-store.test.ts(resolver 단위 RED스텁→GREEN) + mcp.test.ts(word-ref cancel e2e: ambiguous "budget"→후보·미동작/distinct "memo"→정확 cancel; not-found 메시지 갱신) + eval-tool-selection.mjs(snooze 2프롬프트 anaphoric→referent 공정화). 라이브 followup 60%→100% STABLE 3/3. lint clean. pnpm check api 실패는 stale-dist flake(isolated 850 green). Opus judge PASS 5/5(fail-closed mutation 검증, 프롬프트 편집은 fairness fix 판정 not gaming).
- **리스크:** 거의 없음 — ambiguous/unknown은 무동작(잘못된 commitment cancel 방지), 해소된 id만 mutating 호출에 전달(raw word 아님), lifecycle 가드(scheduled만) 불변, 기존 already-fired 가드 유지. 프롬프트 fairness fix는 disambiguation 도전 불변(reminders.snooze vs followup.snooze 유지). 회귀 0.


## fire 71 · 2026-06-13 · skill v1.14.0 · f3d60603
meta: value-class=hardening · pkg=scripts(eval infra) · kind=irrelevance-coverage(IrrelAcc, destructive over-firing 가드) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 948 유지(eval 케이스 +2, scripts는 testFiles 밖) · fabrication 0 유지 · eval:tools followup 가드 2개 STABLE 3/3(2회) · 전체 eval 203/206(99%)·macos 42/42 STABLE 3/3 확인(선택 vein mature)
- **무엇:** followup 시나리오에 IrrelAcc 네거티브 2개 — followup STATUS 질문("Did you ever follow up about the report?"/"그 보고서 팔로업 어떻게 됐어?")이 read 도구 followup.list로 가야지 destructive followup.cancel 오발 금지. PASS 3/3(2회). green-on-arrival 회귀-보호(모델은 이미 안 over-fire).
- **왜:** fires 67-70이 mutating 도구 전체(reminders/tasks/calendar/followups)에 word-ref one-shot 부여 → destructive(cancel/delete)가 더 selectable → casual 언급이 파괴 동작 오발 위험(안전). agent-testing.md IrrelAcc 1급. EXHAUSTION 스카웃(full eval 99%·macos 100%·모든 ref-resolver 완성=선택 vein mature)에서 word-ref 확산의 안전 결과를 가드.
- **리뷰지점:** eval-tool-selection.mjs buildFollowupScenario에 네거티브 2개(순수 additive, 기존 케이스 불변). 시나리오가 cancel 노출→over-firing 탐지 가능, selected 스코어러가 cancel 선발 시 FAIL. lint clean, harness 15 pass. scripts-only(패키지 빌드 무관). Opus judge PASS 5/5(KO cancel 회귀가 zero-shot이라 슬라이스와 구조적 독립 검증; 가드 teeth 확인).
- **리스크:** 없음 — 순수 additive coverage, 약화 0. KO cancel "그 체크인 팔로업 취소해줘" 0/3(fire70 3/3)은 borderline+동시루프 부하 민감, 슬라이스 무관(zero-shot), backlog FINDING 기록(부하 조용해지면 재확인). 선택 vein mature 확인 → 다음 fire value-class 상향/decompose 또는 2연속-clean honest-close 고려.


## fire 72 · 2026-06-13 · skill v1.14.0 · da41ef0c
meta: value-class=hardening · pkg=@muse/mcp(test) · kind=regression-guard(literal-match injection, JUDGE-DRILL fire) · verdict=PASS · firesSinceDrill=0(JUDGE-DRILL 완료, 리셋)
ratchet: testFiles 952 유지(personal-followups-store.test +4 케이스) · fabrication 0 유지 · mcp 1850→1854 · eval 무영향
- **JUDGE-DRILL(연속 allPASS≥8 발동):** 고의 vacuous 슬라이스 주입 — resolveFollowupRef "defensive hardening" 표방하나 둘 다 tautology(`status ∈ {union}` / `typeof === "string"`, 깨진 impl도 통과). ④b Opus verifier가 **5/5 FAIL**(mutation으로 broken impl 통과 실증, 누락된 `toBe("not-found")` 지적) → git checkout 롤백 → teeth 있는 진짜 슬라이스로 대체. maker≠judge + 선언-only 탐지 + 롤백 경로 재검증.
- **진짜 슬라이스 — 무엇:** resolveFollowupRef가 ref를 **literal substring(.includes)으로 매칭, regex 아님**을 pin하는 4 테스트(".*"/"." → not-found not match-all / literal "(Q3)" → 해당 followup만 / unmatched long → not-found). test-only(현 impl 이미 correct).
- **왜:** 이 resolver는 **destructive cancel/snooze를 게이트** → 만약 regex 매칭으로 회귀하면 ".*" 같은 ref가 모든 followup match→엉뚱한 commitment cancel(injection). 안전-관련 회귀 가드. mutation 검증: `.includes`→`new RegExp(needle).test` 시 정확히 2 injection-guard 테스트 RED.
- **리뷰지점:** personal-followups-store.test.ts +4(determinate 단언, tautology 아님), src 무변경(복원 byte-clean). mcp 1854, lint clean. pnpm check messaging "caps to 200" flake(isolated 368 green, 부하 아티팩트, 무관). Opus judge PASS 5/5(mutation 독립 재실행 teeth+드릴 closure 확인).
- **리스크:** 없음 — test-only additive(약화 0, src 불변), 회귀 보호만. 드릴 src 복원 검증(includes literal 확인).


## fire 73 · 2026-06-13 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=vein-mature-honest-close(2nd consecutive clean scout) · verdict=NO-SLICE · firesSinceDrill=1
ratchet: testFiles 954 유지 · fabrication 0 유지 · eval:tools 99%(macos 42/42)·선택/correctness/outbound vein worked — 지표 무변동, 정직 종료
- **무엇:** 슬라이스 없음(honest-close). 스카웃: mac clipboard READ는 `mac_app_read(app='clipboard')`가 이미 커버(전용 도구=중복, tool-calling.md 위반 회피), mac_app_read는 14 read-state 포괄; 신호 보드 clean(0 failure cluster); riskFromMcpAnnotations 정밀 재검토.
- **왜:** fires 55-72로 TOOL 선택/correctness/outbound-safety vein 성숙(eval 99%, 모든 mutating 도구 word-ref+ambiguous-clarify, recipient 해소 email 패리티, browser_key gate, time-arg/literal-match guard). 이번이 2번째 연속 clean 스카웃(fire 71 표면 covered) → EXHAUSTION 규칙: 3번째 스카웃 금지, value-class 상향/honest-close. 상향 후보(새-도구·논문-capability·undo) 전부 차단/dry: 새-도구 vein은 fire 69 스카웃 "no gap"+clipboard 커버, 논문은 Ollama format+tools 비조합, undo는 veto가 objective-scoped라 conversational-undo와 mechanism mismatch.
- **리뷰지점:** 코드 변경 0. backlog에 ★진안 vein-status 블로커 기록 — 남은 고가치 레버 3개(email/handle grounding=agent-core-hot, riskFromMcpAnnotations=security-posture 진안-decision, undo/veto=design 진안-decision)가 전부 진안 unblock 필요. 다음 fire는 진안 unblock 시 그 항목, 아니면 lower-value 파리티/coverage 또는 재-honest-close.
- **리스크:** 없음 — 코드 무변경, 회귀 0. "할 게 없다" 아님: 철저 스카웃 후 고가치 vein이 진안-blocked임을 정직 보고(EXHAUSTION 규칙 준수). 루프는 다음 fire 계속.


## fire 74 · 2026-06-13 · skill v1.14.0 · 796b1381
meta: value-class=hardening · pkg=@muse/mcp(test) · kind=regression-guard(literal-match injection, safety parity 완성) · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 954 유지(3 resolver test +각 1 케이스) · fabrication 0 유지 · mcp 1854→1857 · eval 무영향
- **무엇:** fire 72가 resolveFollowupRef에 한 literal-match injection 가드를 나머지 3개 destructive-게이트 resolver(resolveReminderRef/TaskRef/EventByRef)에 추가 — ".*"/"." ref → not-found(match-all 아님). 4개 word-ref resolver 안전 parity 완성.
- **왜:** 4개 resolver 전부 destructive 게이트(followup.cancel/snooze·reminders.snooze/clear·tasks.delete·calendar.delete). 전부 `.includes`(literal)이나 fire 72는 followup만 가드 → 나머지 3개는 미래 regex-refactor 시 ".*" ref가 match-all→엉뚱한 항목 cancel/delete(injection) 미보호. fire 73 honest-close(테마 mature) 후 진안 미응답 → genuine safety-parity coverage(lower-value지만 실재).
- **리뷰지점:** reminders-recurrence/personal-tasks-serialize/calendar-availability.test.ts 각 +1 가드(determinate not-found 단언, tautology 아님). src 무변경. mutation 검증: 3 resolver `.includes`→regex 시 3 가드 모두 RED, 복원 green. mcp 1857, lint clean, pnpm check green. Opus judge PASS 5/5(mutation 독립 재실행, 각 resolver의 destructive 게이트 확인).
- **리스크:** 없음 — test-only additive(src 불변, 약화 0), 회귀 보호만. 4 resolver 안전 property(literal match) 완비.


## fire 75 · 2026-06-13 · skill v1.14.0 · c74f7737
meta: value-class=hardening · pkg=scripts(eval infra) · kind=irrelevance-coverage(IrrelAcc parity, destructive over-firing tasks/reminders) · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 957 유지(eval +2 케이스) · fabrication 0 유지 · followup 시나리오 가드 2개 STABLE 3/3 · KO cancel 0/3 지속(독립)
- **무엇:** followup 시나리오에 IrrelAcc 네거티브 2개 — status 질문("What tasks…about the report?"/"Which reminders mention the dentist?")이 read 도구(tasks.list/reminders.list)로 가야지 destructive tasks.delete/reminders.clear 오발 금지. PASS 3/3. fire 71의 followup 가드를 형제 destructive 도구로 parity 확장.
- **왜:** fires 67-72가 word-ref로 destructive(delete/clear)를 selectable하게 만듦 → casual 언급이 비가역 삭제 오발 위험(안전). fire 71은 followup.cancel만 가드. mature 테마에서 진안-blocked 고가치 대신 productive safety-parity coverage. KIND=irrelevance(최근 regression-guard와 다름).
- **리뷰지점:** eval-tool-selection.mjs buildFollowupScenario +네거티브 2개(순수 additive). 시나리오가 tasks.delete+reminders.clear 노출→탐지 가능. harness 15 pass(scripts는 eslint ignore). Opus judge PASS 5/5(zero-shot 독립 기계 확인, teeth, parity 정당).
- **리스크:** 없음 — 순수 additive coverage. ★KO followup.cancel "그 체크인 팔로업 취소해줘" 3회 연속 0/3(fire70 3/3은 가벼운 부하) = **지속적 8B KO-cancel 약점 확정**(borderline 아님), 슬라이스 무관(zero-shot 독립), backlog finding 강화 — verb-final KO 취소+referent를 모델이 list로 오선택. 전용 fix 시도 또는 진안 escalate 후보.


## fire 76 · 2026-06-13 · skill v1.14.0 · 0e59f047
meta: value-class=hardening · pkg=@muse/mcp · kind=tool-selection-fix(KO followup.cancel 0/3→3/3) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 957 유지 · fabrication 0 유지 · eval:tools followup KO cancel 0/3→**3/3 STABLE(6/6)**, 시나리오 13/14→**14/14(100%)**
- **무엇:** 3 fire 추적된 지속적 KO followup.cancel 선택 약점 수정 — "그 체크인 팔로업 취소해줘"가 followup.list로 오선택되던 것을 followup.cancel로. 설명 disambiguation(list "NOT when"에 cancel/delay intent 명시 배제 + cancel이 "취소해줘 means THIS tool not list"로 시작). 행동 변경 0.
- **왜:** 진단 — 같은 "그 체크인 팔로업" referent로 snooze("미뤄줘")는 3/3, cancel("취소해줘")만 0/3→list. "취소" verb→cancel 매핑 약함 + list가 fallback. 테마 #1(올바른 tool 한 방), destructive KO intent. fire 75가 다음 타겟으로 명시한 진짜 선택 버그.
- **리뷰지점:** loopback-followups.ts list+cancel description만(execute/schema/risk/groundedArgs 불변). eval:tools 케이스 0/3→3/3 STABLE 2회 REPEAT=3(6/6), 시나리오 14/14 양쪽 — over-steering 회귀 없음(목록/status-질문/snooze/IrrelAcc 전부 유지). mcp 1857, lint clean. pnpm check @muse/cli flake(isolated 2616 green, 동시-루프 actuator 변경+부하). Opus judge PASS 5/5(독립 14/14 재현, no over-steer).
- **리스크:** 없음 — description-only(fail-closed 게이트 불변), 회귀 0(전 케이스 14/14). 기존 골든 케이스가 향후 회귀 가드. KO-cancel finding 해소.


## fire 77 · 2026-06-13 · skill v1.14.0 · e628814d
meta: value-class=hardening · pkg=scripts(eval infra) · kind=destructive-selection-probe+coverage(fire-76 버그 클래스 배제) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 958 유지(eval +6 케이스) · fabrication 0 유지 · followup 시나리오 14→**20/20(100%)**, 6 destructive-intent probe STABLE 3/3(2회 6/6)
- **무엇:** destructive INTENT positive 골든 6개(tasks.delete/reminders.clear/calendar.delete, EN+KO) — "삭제해줘/지워줘/취소해줘"+referent가 destructive 도구 한방 선택. followup 시나리오에 calendar 서버 추가(delete/list 노출, calendar.add는 필터로 제외해 reminders.add 비간섭).
- **왜:** fire 76 KO "취소" followup.cancel 버그가 verb-특정이었음 → 형제 destructive 도구(특히 calendar.delete가 **같은 "취소" verb**)에도 같은 mis-route가 있나 PROBE. probe→found-bug→fix(fire 76) 패턴 계승. 가장 유력 잠복 = calendar.delete "취소".
- **리뷰지점:** eval-tool-selection.mjs buildFollowupScenario(calendar 서버 + 필터 tweak[calendar.add 제외] + 6 positive 케이스). PROBE 결과: 6개 전부 PASS 3/3 2회(6/6) → **버그는 followup.cancel 특정 확정, systemic 아님**(tasks/reminders/calendar 전부 KO destructive 한방 정상). 시나리오 20/20 양쪽 — calendar 추가가 기존 14 케이스 무회귀(fire-76 KO cancel fix·IrrelAcc 가드 포함). fire 75 IrrelAcc 네거티브(질문→delete 금지)를 positive(intent→delete)로 보완. harness 15 pass, lint clean. Opus judge PASS 5/5(무회귀·calendar.add 제외·teeth: fire-76 선례가 실패 가능 증명).
- **리스크:** 없음 — 순수 additive(기존 케이스 불변), scripts-only. teeth 있음(같은 verb가 followup에서 실제 0/3였음). 버그 클래스 배제 = 진짜 negative 결과(다른 destructive 표면 안전 확인).


## fire 78 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=eval-scan-no-actionable-bug(테마 maturity 정의적 확인) · verdict=NO-SLICE · firesSinceDrill=6
ratchet: testFiles 959 유지 · fabrication 0 유지 · eval:tools full REPEAT=3 스캔 — real-tool 선택 healthy, actionable 버그 0
- **무엇:** 슬라이스 없음(honest-close). 전체 eval:tools REPEAT=3 스캔(fire 76이 eval로 진짜 버그 발굴한 패턴 → 남은 일관 실패 정의적 탐색). agent-core hot 확인(email/handle grounding blocked 유지), 신호 clean.
- **왜:** 스캔 결과 **actionable real-tool 선택 버그 0건**: (a) synthetic weather 0/3 = 합성 도구명 "weather_in_city" 환각(Muse 실제 도구 아님, 이름 바꾸면 gaming = non-actionable), (b) time_diff "between 9am and 5:30pm today" 1/3 flaky = time_now 설명이 **이미 이 정확한 케이스를 명시 배제**(muse-tools-time.ts:26)하므로 설명 갭 아님, 6+ 동시루프 부하 하 8B stochastic noise. KO cancel(fire 76)이 진짜 버그였고 수정됨 → 테마 mature 정의적 확인.
- **리뷰지점:** 코드 변경 0. backlog에 두 finding 기록(synthetic 환각 non-actionable, time_diff 1/3 load-noise monitor). budget상 후반 시나리오 전 스캔 중단(real-tool 통과 확인 후); macos 42/42·followup 20/20은 최근 fire 검증됨. 고가치 레버(email/handle grounding=agent-core-hot, MCP-risk posture=진안, undo/veto=설계 진안) 여전히 blocked.
- **리스크:** 없음 — 코드 무변경. "할 게 없다" 아님: fire 76 패턴(eval→버그→fix)으로 정의적 스캔 → 진짜 negative 결과(actionable 버그 없음=maturity). 다음 fire는 진안 unblock 시 그 항목, 아니면 부하 조용할 때 time_diff 재확인 또는 재-close.


## fire 79 · 2026-06-14 · skill v1.14.0 · 6d454536
meta: value-class=new-capability · pkg=@muse/autoconfigure(+scripts eval) · kind=capability-extension(week_agenda에 due reminders 병합, EXPANSION) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 959 유지(+1 케이스 week-agenda.test) · fabrication 0 유지 · eval:tools week-agenda 4→**5/5 STABLE 3/3**
- **무엇:** week_agenda(cross-store "이번 주" 뷰)가 **due 리마인더도 병합** — 기존 events+tasks+birthdays에 시간-앵커 리마인더("금요일 집세") 추가. groupWeekAgenda가 reminders를 timed bucket(⏰, 이벤트와 시간순 interleave). 설명+배선(autoconfigure weekInput이 pending 리마인더 read). **새 도구 아님**(daily_brief는 week_agenda+days=1 중복 = tool-calling.md 위반).
- **왜:** 테마 mature(fire 78 eval 정의적 확인) → EXHAUSTION 규칙대로 value-class 상향(EXPANSION half underweighted). week_agenda가 8B의 불안정한 4-chain 대체인데 리마인더만 빠져 있었음 = 진짜 갭(시간-앵커 알림은 주간 뷰에 당연). KIND=capability-extension(최근 coverage/regression-guard와 다름).
- **리뷰지점:** week-agenda-tool.ts(WeekAgendaInput.reminders? + groupWeekAgenda bucketing + 설명) + autoconfigure/index.ts(weekInput이 readReminders pending) + week-agenda.test(+1: 리마인더가 요일에 ⏰·시간순) RED→GREEN 595 + eval-tool-selection.mjs(reminders 서버 + reminders-only 네거티브). eval 5/5 STABLE 3/3(holistic→week_agenda 무회귀, reminders-only→reminders.list over-fire 안 함). lint clean. pnpm check cli chat-ink-render 부하 timeout flake(isolated 2625 green). Opus judge PASS 5/5(RED-before loop 제거 실증·production 배선·선택 무회귀).
- **리스크:** 거의 없음 — read-only(risk 불변), fabrication 0(실 저장 text+dueAt), reminders optional(기존 caller/CLI week 뷰 무파손), empty/days-window 테스트 유지(595).


## fire 80 · 2026-06-14 · skill v1.14.0 · cfd5cd79
meta: value-class=hardening · pkg=@muse/mcp · kind=no-partial-side-effect(notes.append 쓰기-전-검사) · verdict=PASS · firesSinceDrill=8
ratchet: testFiles +1 케이스(mcp.test notes append over-cap) · fabrication 0 유지 · eval 무변동(handler correctness)
- **무엇:** muse.notes append 핸들러가 over-cap 콘텐츠를 **쓴 뒤** stat으로 cap 초과 에러 → oversize 바이트가 디스크에 잔류 = partial side-effect. 결과 크기(현재 bytes + Buffer.byteLength)를 **쓰기 전** 검사 → 초과면 거부·미기록으로 수정. exact-cap은 허용(`> maxFileBytes`, save와 일치).
- **왜:** agent-testing.md "실패한 액션은 아무것도 변경 안 함" 위반. 게다가 read 핸들러가 oversized 파일을 거부하므로 "실패한" append가 노트를 **읽기 불가**로 만듦 = cosmetic 아닌 data-integrity. Opus 스카웃이 marginal로 본 edge를 no-partial-side-effect + read-fails 프레임으로 재평가 → genuine 수정.
- **리뷰지점:** loopback-notes.ts append 핸들러(currentBytes from stat + appendBytes 합 검사 후 mkdir+appendFile) + mcp.test(601바이트 seed, 600 append 시도 → 에러 + re-read UNCHANGED, RED→GREEN). lint clean(catch comment-only). pnpm check auth flake(isolated 61 green). Opus judge PASS 5/5(read-back로 no-partial-write 검증, off-by-one 없음, "marginal undersells").
- **리스크:** 없음 — 거부 경로 mutate 0, 정상/첫-파일/exact-cap 유지, path-sandbox 우선. [기록 복원: 이 엔트리는 fire 80 ⑤b 커밋이 동시-루프 머지 churn에 유실되어 fire 81에서 복원]


## fire 81 · 2026-06-14 · skill v1.14.0 · a835684e
meta: value-class=hardening · pkg=scripts(eval infra) · kind=selection-coverage+confusable-probe(KO notes.append vs tasks.add) · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 966 유지(scripts-only) · fabrication 0 유지 · eval:tools notes 12→**14/14 STABLE 3/3**
- **무엇:** notes 시나리오에 KO notes.append positive 2건 추가 — "journal.md 일지에 한 줄 덧붙여줘"(덧붙여=clear append)·"내 노트 journal.md에 추가해줘"(collide-verb 추가 + .md path). 둘 다 notes.append로 라우팅 확인(PASS 3/3). 노트 PATH가 tasks.add와 변별.
- **왜:** notes 시나리오에 **KO append positive 부재**(KO save는 line 207 있음), "추가"가 tasks.add와 충돌(line 213 네거티브 "할 일에 추가→tasks.add"). fire-76 KO-verb mis-route 선례 → 잠복 confusable probe. 결과: mis-route 없음(genuine negative) + KO append coverage 갭 채움 + 추가/tasks.add 양방향 변별 가드.
- **리뷰지점:** eval-tool-selection.mjs buildNotesScenario(+2 케이스, 순수 additive). selected scorer가 toolCalls[0] 채점→tasks.add 오라우팅이면 FAIL(teeth). no exemplarBank=zero-shot(siblings 무회귀). 14/14 STABLE 3/3. lint clean, harness 15 pass. Opus judge PASS 5/5(teeth·no-regression·genuine-coverage, fire-77 probe와 동급). [정리: 미추적 0바이트 정크 maxFileBytes 파일 제거]
- **리스크:** 없음 — scripts-only, 기존 케이스 불변. GREEN-on-arrival이나 fire-76 선례+coexisting 네거티브로 동기화된 regression 가드. 테마 mature → 다음 fire는 진안 unblock 항목 또는 재-honest-close.


## fire 82 · 2026-06-14 · skill v1.14.0 · 5b76004a
meta: value-class=hardening · pkg=@muse/mcp(test) · kind=JUDGE-DRILL(softball FAIL 확인)+rollover-coverage(datetime impossible-date, mutation-verified) · verdict=PASS · firesSinceDrill=0(드릴 완료, 리셋)
ratchet: testFiles 966 유지(+2 케이스 mcp.test rollover) · fabrication 0 유지 · eval 무변동(parser correctness guard)
- **무엇:** (A) JUDGE-DRILL — 고의 softball eval 케이스(프롬프트가 `muse.notes.save` 도구 id를 리터럴 누설 → 선택 회귀 못 잡는 무-teeth) 주입 → ④b Opus judge **VERDICT: FAIL** 확인(teeth 없음·line 207 중복·churn) → git restore 롤백(트리 clean). (B) 진짜 fix — dueAt rollover 가드(parseTaskDueAt/parseReminderDueAt)에 **datetime 형태 불가능 날짜** 2건("2026-02-30T09:00:00Z"·"2026-04-31T23:59:59Z") 추가(기존 8개는 date-only).
- **왜:** firesSinceDrill 10 도달 → 드릴 미루기 불가(롤백 경로 재검증, maker≠judge 보상통제). 실수정: 챗 모델이 reminder dueAt를 full ISO datetime로 emit하는데 date-only 케이스는 "full datetime은 valid니 day-check skip" mutation을 못 잡음 → 잘못된 날짜가 ~2일 어긋난 reminder 스케줄(correctness-critical). past-time/bare-time edge는 스카웃대로 judgment-call(의도된 "오늘 <시각>" 시맨틱, false-reject 위험) → skip 확정.
- **리뷰지점:** mcp.test.ts "rejects impossible calendar dates" 루프에 datetime 2건(+주석). **mutation-verified 독립 teeth**: 가드를 `trimmed.includes("T")` early-return으로 변조 시 → datetime 케이스만 RED("2026-03-02T..."), date-only 8개는 GREEN 유지(‘T’ 없어 무영향) → 기존 케이스가 못 잡는 mutation 클래스 포착. 복원 후 GREEN(1860). pnpm check exit=0, lint clean. ④b judge가 mutation 독립 **REPRODUCE**해 PASS 5/5.
- **리스크:** 없음 — test-only(src 무변경, 변조는 복원됨), 순수 additive(기존 assert 불변). 드릴+실수정 둘 다 같은 fire(드릴 규약). 테마 여전히 mature → 다음 fire는 진안 unblock 항목 또는 재-honest-close.


## fire 83 · 2026-06-14 · skill v1.14.0 · 60f3460c
meta: value-class=hardening · pkg=@muse/mcp(test) · kind=no-collateral-damage(reminders.clear 실패 시 store 불변, mutation-verified) · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 967 유지(+1 케이스 mcp.test clear no-collateral) · fabrication 0 유지 · eval 무변동(destructive-verb safety invariant)
- **무엇:** reminders.clear(DESTRUCTIVE delete)가 실패(ambiguous word / unknown ref)할 때 **populated store가 불변**임을 검증하는 OUTCOME 테스트. dentist×2(ambiguous)+milk 3건 add → clear "dentist"→multiple 에러+2 candidates+list all total 3 / clear "passport"→not found+total 3.
- **왜:** EXPANSION 시도가 dry — Opus 스카웃(26 tool)이 표면 mature 확정(unwired 0·add_contact 이미 update-in-place·multi-store merge 기존). 스카웃 fallback lead = under-tested destructive verb OUTCOME. clear 핸들러는 코드상 정확(ambiguous/not-found가 mutateReminders 전 return)이나 기존 테스트는 happy-path(exact id) + **빈 store** 에러 메시지뿐 → populated store no-collateral 미검증 = agent-testing.md #1 속성("실패 액션은 아무것도 mutate 안 함") 갭.
- **리뷰지점:** mcp.test.ts 새 it(reminders clear). **mutation-verified 독립 teeth**: clear의 ambiguous 분기를 "첫 candidate 추측 삭제"로 변조 → **새 테스트만 RED**(1/1861), 기존 happy-path(4811, exact id라 ambiguous 안 탐)·empty-store(4874, total 미확인)는 green → 기존이 못 잡는 regression 포착. 복원 GREEN(1861), pnpm check exit=0, lint clean. ④b judge PASS 5/5(mutation 독립 REPRODUCE).
- **리스크:** 없음 — test-only(src 무변경, 변조 복원됨), 순수 additive. **부수 발견:** snooze 핸들러의 동일 ambiguous-no-mutation 불변도 미검증(변조 시 무 RED) → 향후 fire 후보로 backlog 기록.


## fire 84 · 2026-06-14 · skill v1.14.0 · b2ad3fa3
meta: value-class=hardening · pkg=@muse/mcp(test) · kind=no-collateral-damage(reminders.snooze 실패 시 dueAt 불변, mutation-verified) · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 970 유지(+1 케이스 mcp.test snooze no-collateral) · fabrication 0 유지 · eval 무변동(destructive-verb safety invariant parity)
- **무엇:** reminders.snooze(dueAt를 MUTATE) 실패(ambiguous/unknown ref) 시 **모든 reminder dueAt 불변** OUTCOME 테스트. fixed now로 dentist×2+milk seed → snooze "dentist"→multiple+2 candidates+dueByText 불변 / snooze "passport"→not found+불변. fire 83 clear sibling = destructive-verb no-collateral parity 완성.
- **왜:** fire 83에서 snooze의 동일 ambiguous 블록(284)을 변조했을 때 무 RED → snooze no-mutation 미검증 확정(backlog ◦로 기록했던 항목). snooze는 row-count가 아닌 dueAt를 mutate하므로 total로는 약함 → dueAt 값 deep-equal로 검증(fixed now면 guess-snooze가 08:10Z로 튀어 seed 12/13/14와 구별 → 결정적 포착).
- **리뷰지점:** mcp.test.ts 새 it(snooze, 4906~). **mutation-verified 독립 teeth**: snooze ambiguous를 guess-snooze로 변조(snooze-고유 `const index=findIndex` 다음줄로 정밀 타깃) → **새 테스트만 RED**(1/1862), fire 83 clear 테스트 포함 1861 green → snooze 고유 경로 커버 입증. 복원 GREEN(1862), pnpm check exit=0, lint clean. ④b judge PASS 5/5(mutation 독립 REPRODUCE, fire 83과 구별 가치 확인).
- **리스크:** 없음 — test-only(src 무변경, 변조 복원됨), 순수 additive. **남은 sibling:** `fire` verb(ambiguous@380, pending→fired flip)도 동일 무-mutation 불변 미검증 → backlog ◦로 parity 완성 후보.


## fire 85 · 2026-06-14 · skill v1.14.0 · 00b91511(sweep)
meta: value-class=hardening · pkg=@muse/mcp(test) · kind=no-collateral-damage(reminders.fire 실패 시 status 불변, mutation-verified; PARITY 완성) · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 970 유지(+1 케이스 mcp.test fire no-collateral) · fabrication 0 유지 · eval 무변동(destructive-verb safety invariant PARITY 완결)
- **무엇:** reminders.fire(status pending→fired flip) 실패(ambiguous/unknown ref) 시 **모든 status 불변(all "pending")** OUTCOME 테스트. dentist×2+milk seed → fire "dentist"→multiple+2 candidates+statusByText all-pending / fire "passport"→not found+all-pending. **reminders destructive-verb no-collateral PARITY 완성**(clear✓83·snooze✓84·fire✓85 = resolveReminderRef 쓰는 3 verb 전부).
- **왜:** fire 84 mutation-discovery로 fire verb가 마지막 미검증 sibling 확정. fire는 row(clear)·dueAt(snooze) 아닌 **status**를 mutate → status 값 deep-equal로 검증. "linking/lifecycle → audit ALL ops, rot은 silent"(memory) — 2/3만 audit하면 latent 갭.
- **리뷰지점:** mcp.test.ts 새 it(fire, 4945~). **mutation-verified 독립 teeth**: fire ambiguous를 guess-fire로 변조(fire-고유 `const next=fireReminder` 다음줄 타깃) → **새 테스트만 RED**(1/1863), clear·snooze 테스트 1862 green → fire 고유 경로 입증. 복원 GREEN(1863), pnpm check exit=0, lint clean. ④b judge PASS 5/5(mutation 독립 REPRODUCE, parity-completion 정당·3에서 정확히 멈춤). **⚠️ 패키징 사고:** 미커밋 test 편집이 동시 codebase-quality 루프의 `git add -A` merge(`00b91511`)에 쓸려 들어감 — test code는 거기에, 이 fire는 write-back만 별도 커밋. 향후 edit 직후 즉시 stage 교훈.
- **리스크:** 없음 — test-only(src 무변경, 변조 복원됨), 순수 additive. no-collateral KIND 소진(3 verb 완결) → fire 86+ 강제 KIND 다양화.


## fire 86 · 2026-06-14 · skill v1.14.0 · b7baadfa
meta: value-class=hardening · pkg=scripts(eval infra) · kind=selection-confusable-coverage(calendar read-verb list/availability/conflicts; KIND 다양화) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 970 유지(scripts-only) · fabrication 0 유지 · eval:tools +calendar-read 시나리오 7/7 STABLE 3/3
- **무엇:** eval:tools에 calendar READ-verb golden 시나리오 추가 — list(일정 보기)/availability(빈 시간)/conflicts(겹침) 7 KO+EN 케이스. 전부 PASS 3/3 = 로컬 모델이 robustly 선택(real mis-route 없음). no-collateral KIND 소진 후 강제 다양화 → selection-confusable KIND(fire-76/81 계열).
- **왜:** eval 스위트에 calendar read-verb 커버리지 0. "언제 시간 돼?"(availability)가 list로 샐 가설 검증 → negative(robust). backlog 최상단 ◦들은 codebase-quality 소유(refactor), tool-hardening backlog 실질 비어 gap-scout. EXPANSION은 fire 83 Opus-confirmed dry.
- **리뷰지점:** eval-tool-selection.mjs buildCalendarReadScenario(+배열 등록, 순수 additive 31줄). **정직 teeth disclosure:** availability 설명을 list-like로 blur해도 케이스 통과(7/7) — 모델이 tool NAME+키워드로 선택, description 의존 안 함 → description-edit regression엔 약함, **structural regression(rename/merge/confusable-추가) guard**. 골든 스위트 전체가 이렇게 robust-pass(rename/merge lock) → 일관. ④b judge PASS 5/5(disclosure 정직 평가, KIND-diverse 확인).
- **리스크:** 없음 — scripts-only(loopback-calendar.ts 변조 복원, clean), 순수 additive. **교훈 적용:** ④b 후 즉시 커밋(fire 85 동시-루프 git add -A sweep 재발 방지). 다음 fire는 또 다른 KIND 또는 honest-close(테마 mature, 고가치 진안-blocked).


## fire 87 · 2026-06-14 · skill v1.14.0 · 4c0ebf78
meta: value-class=micro-fix(real correctness/data-loss bug) · pkg=@muse/mcp · kind=silent-data-loss-fix(add_contact update가 about/aliases/connections drop) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 970 유지(+1 케이스 contacts-tool update-preserves) · fabrication 0 유지 · eval 무변동(handler correctness)
- **무엇:** add_contact("Add or update")가 기존 이름 업데이트 시 id 재사용 → id-idempotent addContact가 contact을 wholesale REPLACE. 그런데 재구성된 contact이 5필드만 carry → **about(grounding evidence)·connections(people-graph)·aliases(resolution-critical)를 silent drop**. existing에서 carry-forward하도록 수정(+RED→GREEN 테스트).
- **왜:** Opus correctness-bug 스카웃(미-examined 핸들러 대상, EXHAUSTION→value-class 상향)이 발굴한 real 버그. "save Bob's new email" 같은 update-by-chat에서 발화(production 배선: autoconfigure:754·commands-ask:1627 둘 다 real addContact+reader). about은 타입 주석(:54-57)이 "grounding evidence … cite"라 명시 → **grounding-floor-adjacent 데이터 손실**(silent·irreversible). no-collateral/selection coverage와 다른 KIND(real fix, fire-80 계열).
- **리뷰지점:** contacts-tool.ts 머지에 `existing?.about/aliases/connections` 3 spread 추가(전부 existing? guard → fresh add는 no-op·byte-identical). 테스트 RED("expected undefined to be 'allergic to nuts'")→GREEN, 전 suite 1864 green, pnpm check exit=0, lint clean. ④b judge PASS 5/5(자체 pre-fix revert로 검증, over-reach/fabrication 없음·schema에 clear 입력 없으니 preserve가 유일한 non-lossy). 스카웃 negative: followups/history/week-agenda/contacts-other 핸들러는 correct.
- **리스크:** 없음 — update-merge만 변경(validation/dedup/fresh-add 불변), aliases 보존은 outbound-safety rule 3(recipient 해소)을 도움. **교훈 적용:** fix+test 빌드 통과 즉시 커밋(sweep 방지).


## fire 88 · 2026-06-14 · skill v1.14.0 · 5e35f693(merge-resolve)
meta: value-class=regression-fix(conflicted-main 머지 해소) · pkg=docs/INDEX(공유) · kind=broken-main-triage(동시 루프 머지 충돌) · verdict=N/A(결정적 검증) · firesSinceDrill=6
ratchet: testFiles 972 유지 · fabrication 0 유지 · 회귀 해소(self-eval green·pnpm check exit=0)
- **무엇:** fire 시작 시 main이 **conflicted merge IN PROGRESS**(동시 codebase-quality 루프가 남김) — INDEX.md에 `<<<<<<< / >>>>>>>` 마커, unmerged paths로 모든 루프의 커밋/머지 차단. INDEX 충돌(codebase-quality·tool-mcp-browser 두 row를 양쪽 갱신)을 **max-fire per row**로 해소(codebase-quality 49/c99be00d, tool-mcp-browser 22), backlog.md는 union auto-merge 확인, 머지 완료(5e35f693).
- **왜:** ① 규칙 "회귀가 있으면 그게 이번 이터레이션". 깨진 공유 main은 후속 모든 커밋의 base가 되어 전파되므로 최우선 해소. 새 hardening 슬라이스보다 우선(한 fire 한 슬라이스 = 이번엔 회귀 해소).
- **리뷰지점:** INDEX 해소 = 두 충돌 row를 각 루프의 최신 fire로(48 vs 49→49, 21 vs 22→22). 머지된 코드(commands-export.ts de-export = codebase-quality fire 49의 자체-judged 작업)는 내 작업 아님. 검증: 마커 0(git grep)·self-eval green(testFiles 972)·**pnpm check exit=0**(머지 semantic conflict 없음). behavioral slice 아니므로 ④b judge 불요.
- **리스크:** 없음 — docs 충돌 해소 + 이미-judged 코드 머지 완료. 교훈: 공유 main 워크트리에서 동시 루프 머지가 충돌을 남기면 regression-first로 즉시 해소(전파 방지).


## fire 89 · 2026-06-14 · skill v1.14.0 · b4d189be
meta: value-class=micro-fix(real correctness bug) · pkg=@muse/mcp · kind=validation-gap-fix(calendar parseIsoDate 불가능 날짜 silent 롤오버) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 972 유지(+2 케이스 calendar-add-anchor) · fabrication 0 유지 · eval 무변동(handler correctness)
- **무엇:** calendar의 parseIsoDate(add/update/availability/conflicts의 날짜 파서)가 date-headed 값에 `new Date()` 후 non-NaN이면 반환 → `new Date("2026-02-30")`=Mar 2 silent 롤오버 → 이벤트가 ~2일 어긋나게 생성(에러 없이 잘못된 날 confirm). Y-M-D를 Date.UTC로 round-trip해 불가능 날짜 거부(parseTaskDueAt 미러) → undefined → add 핸들러가 에러, createEvent 미호출.
- **왜:** fire 87 패턴(sibling hardened, this missed) — parseTaskDueAt(:282-294)엔 이 가드가 있으나 calendar의 별도 파서 parseIsoDate는 누락. fire 82는 tasks/reminders 가드를 *테스트*했고, calendar는 가드 *자체*가 없었음(real bug, coverage 아님). correctness-bug 스카웃이 비-examined 핸들러에서 발굴(2연속 real fix: 87 contacts·89 calendar).
- **리뷰지점:** loopback-calendar.ts parseIsoDate에 Date.UTC round-trip probe(15줄). 테스트 RED("expected {event} to have property error" — Mar 2 이벤트 생성)→GREEN + 정상/full-ISO/leap(2028-02-29) 수용 케이스. 전 suite 1867, pnpm check exit=0, lint clean. ④b judge PASS 5/5(16 날짜 자체 probe, TZ-boundary month-end false-reject 없음 확인 — probe는 regex Y-M-D digits만 UTC 검증, parsed local과 비교 안 함).
- **리스크:** 없음 — parseIsoDate만 변경(non-date-headed phrase는 resolveRelativeTimePhrase로 unchanged, 핸들러 불변). 스카웃 negative: browser/macos/cli-actuators/tasks/reminders/episodes/history/search/fetch/web-read/notes 모두 correct-hardened. 교훈: fix+test 빌드 통과 즉시 커밋(sweep 방지).


## fire 90 · 2026-06-14 · skill v1.14.0 · 6cca8650
meta: value-class=micro-fix(real correctness/contract bug) · pkg=@muse/mcp · kind=validation-gap-fix(time readDate 불가능 날짜 롤오버; date-parser audit 완성) · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 973 유지(+1 케이스 mcp.test diff_ms) · fabrication 0 유지 · eval 무변동(handler correctness)
- **무엇:** readDate(muse.time#diff_ms 뒤)가 user 날짜를 NaN만 거부 → `new Date("2026-02-30")`=Mar 2 롤오버 → diff_ms가 Mar 2 기준 3일(259200000ms)을 반환, 그런데 에러 메시지는 "valid ISO-8601 strings"라 약속 = **contract 위반**. parseIsoDate(fire 89)·parseTaskDueAt와 동일 Date.UTC round-trip 가드 → 불가능 날짜 undefined → diff_ms 에러.
- **왜:** fire 89에서 발견한 date-parser 롤오버 패턴을 직접 cheap grep으로 3번째(마지막) user-facing 파서까지 추적 → readDate. **rollover-guard audit 완성**(tasks✓·calendar✓89·time✓90 = loopback 도구 뒤 3 user-date 파서 전부). "audit ALL sibling paths, rot은 silent". 정직: read-only utility(diff_ms)라 calendar write(89)보다 stakes 낮으나 contract 위반 + bounded audit 경계 완결.
- **리뷰지점:** loopback-time-server.ts readDate에 Date.UTC probe(now 도구는 날짜 무인자라 무영향, diff_ms 로직 불변). 테스트 RED({milliseconds:259200000})→GREEN + 정상 날짜 86400000 수용. 전 suite 1868, pnpm check exit=0, lint clean. ④b judge PASS 5/5(TZ+14·leap probe, audit-completion ≠ churn 판정). DRY: 가드 3 inline 복사 → 공유 helper 추출 ◦(codebase-quality용).
- **리스크:** 없음 — readDate만 변경. firesSinceDrill=8(드릴 fire 92). 교훈: 비싼 217k scout 대신 직접 grep으로 proven 패턴(sibling-inconsistency) 추적 = budget-efficient.


## fire 91 · 2026-06-14 · skill v1.14.0 · 7e026b87(+062936da swept)
meta: value-class=hardening · pkg=scripts(eval infra) · kind=irrelevance-coverage(personal-crud write 도구 past-tense report IrrelAcc; KIND 다양화) · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 974 유지(scripts-only) · fabrication 0 유지 · eval:tools personal-crud +3 IrrelAcc 케이스 STABLE 3/3(12/12)
- **무엇:** personal-crud 시나리오(tasks/reminders/calendar add+list)에 **past-tense report IrrelAcc 네거티브** 3건 — KO "어제 우유 샀어"/"방금 약 먹었어", EN social report. 전부 PASS 3/3(strict noTool scorer = read .list 발화도 금지) → 모델이 statement에 write/list 도구 안 쏨. rollover 2연속 후 다른 KIND(IrrelAcc).
- **왜:** personal-crud에 positive intent만 있고 over-invocation 네거티브 0. agent-testing.md 명시 우선 dimension("most suites skip; we do not"). write 도구 over-fire = phantom task/event/reminder = spurious state = 최고비용 false-positive. **teeth 입증:** borderline 프로브("I already finished the quarterly report" — task-noun+완료 암시)가 tasks.list over-fire(0/3) → abstention은 description-의존(무조건 아님). fire-70 교훈대로 그 unfair 케이스는 clean social report로 교체(over-strict 기대 금지).
- **리뷰지점:** eval buildPersonalCrudScenario +3 expectNoTool 케이스(순수 additive). ④b judge PASS 5/5(fair expectation·strict noTool teeth·KIND-diverse). **⚠️ sweep 재발:** probe/replace 중 동시 codebase-quality 머지(`062936da`)가 미커밋 2 KO 케이스를 쓸어담음 → EN swap만 내 커밋 7e026b87에; net 3 케이스 모두 main(검증). 교훈: "즉시 커밋"도 probe 사이클 중 sweep 못 막음 — 공유 main의 구조적 한계, net-correct면 수용.
- **리스크:** 없음 — scripts-only, 순수 additive. firesSinceDrill=9 → **fire 92 = JUDGE-DRILL**(10).


## fire 92 · 2026-06-14 · skill v1.14.0 · dfedca87
meta: value-class=micro-fix(real correctness bug) · pkg=@muse/mcp · kind=JUDGE-DRILL(vacuous gibberish FAIL 확인)+date-window-boundary-fix(on_this_day Jan-1 경계 miss) · verdict=PASS · firesSinceDrill=0(드릴 완료, 리셋)
ratchet: testFiles 976 유지(+1 케이스 on-this-day boundary) · fabrication 0 유지 · eval 무변동(grounded-recall correctness)
- **무엇:** (A) JUDGE-DRILL — 고의 vacuous IrrelAcc 케이스("asdfgh qwerty…" gibberish, "더 많은 커버리지" 위장, 현실 over-invocation 무관·no teeth) 주입 → ④b judge **VERDICT: FAIL**(3항목: 비현실·no teeth·churn) → git restore. (B) 진짜 fix — selectOnThisDay(on_this_day_notes 도구 + `muse on-this-day` CLI + morning-brief)가 prior-year 노트 month-day를 now.year로만 투영 → **Jan-1 경계 깨짐**: Dec-31 노트가 Jan-1 now에서 ~364일로 계산돼 1일 anniversary가 silent miss. year before/of/after 투영 후 min gap으로 수정.
- **왜:** firesSinceDrill 10 → 드릴 미루기 불가(롤백 경로 재검증). 실수정: tight scout(fresh 핸들러 proactive/context/dev-utility/aggregators 한정, budget-efficient)가 발굴. grounded-recall 표면의 silent miss(New-Year's-Eve 노트가 1월 초에 안 뜸). 주석은 "handles year boundaries cleanly" 거짓 주장했음. KIND=date-window-boundary(rollover/IrrelAcc와 구별).
- **리뷰지점:** on-this-day-tool.ts window-gap 계산만 변경(prior-year filter·sort·yearsAgo 불변). 테스트 RED("expected +0 to be 1", Dec-31 drop)→GREEN + far-July negative(@window7 무매치). **직접 검증:** src fix stash→RED, 복원→GREEN(1869). pnpm check: apps/cli chat-ink-render 74s 부하 timeout flake(isolated 2631 green, 무관). ④b judge PASS 5/5(exhaustive sweep: 전 day×month-day → 0 spurious·0 missed, min-of-3는 wrap-around 정확).
- **리스크:** 없음 — window-gap만 변경, mid-year 무변동. 드릴+실수정 같은 fire(드릴 규약). firesSinceDrill=0. scout는 fix까지 적용(maker)했으나 ④b judge는 별개 fresh 인스턴스(maker≠judge 유지).


## fire 93 · 2026-06-14 · skill v1.14.0 · b9d6460a
meta: value-class=micro-fix(real security bug) · pkg=@muse/mcp · kind=fail-close-bypass-fix(home_action empty-target가 whole-domain 가드 우회) · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 976 유지(+createHomeActionTool 첫 테스트 3 it) · fabrication 0 유지 · eval 무변동(security fail-close)
- **무엇:** home_action(risk:execute)의 fail-close 가드 — 타깃 없는 서비스 콜은 HA의 whole-domain 경로(light.turn_off=온 집 소등, lock.unlock=전 잠금 해제). 가드의 dataHasTarget이 **키 존재만** 검사 → empty target(`{target:{}}`/`{entity_id:[]}`/`{entity_id:""}`)이 우회 → 승인된 서비스 콜이 도메인 전체 blast. **concrete(non-empty 문자열/배열) 타깃 요구**로 수정(top-level + nested target).
- **왜:** home 도구는 어느 prior scout도 examine 안 한 fresh 표면(genuinely un-examined). createHomeActionTool은 **테스트 전무**. outbound-safety의 fail-close 우회 = 高harm 보안 홀(되돌릴 수 없는 whole-domain 액션). KIND=fail-close-bypass(rollover/IrrelAcc/recall과 구별).
- **리뷰지점:** smart-home-tool.ts dataHasTarget만 변경(service-format·entityId·performHomeActionWithApproval 불변). 테스트 = **승인 게이트 + fetch 스파이**(가드만이 콜 차단 가능): empty-target RED("expected performed:true,status:200" — 승인 액션이 fetch escape)→GREEN(calls=[]) + no-target refuse + concrete entity proceed. 첫 weak 시도(performed:false만)는 throwing-gate가 catch→false-green이라 fetch-spy로 강화. 전 suite 1872, pnpm check exit=0, lint clean. ④b judge PASS 5/5(pre-fix revert로 RED 재현, 전 HA 타깃 shape over-rejection 없음 확인).
- **리스크:** 없음 — 가드를 더 fail-closed로(legitimate concrete 타깃은 전부 통과 확인). 교훈: fail-close 가드는 키 존재가 아닌 concrete 값 검사여야(empty가 우회). fetch-spy + 승인-게이트가 보안 fail-close의 올바른 teeth(performed:false만으론 false-green).


## fire 94 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=fresh-handler-bug-vein-exhausted(6 버그 수정 후 clean) · verdict=NO-SLICE · firesSinceDrill=2
ratchet: testFiles 977 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close)
- **무엇:** 슬라이스 없음(honest-close). 이 fire 직접 clean 검증: web_action(URL length·method allow-set·SSRF guard 전부 concrete)·remember_fact(key/value non-empty·slug sanitize)·mac_spotlight `--`(non-viable: mdfind `--` 미지원, 작성자 인지, leading-dash는 error 반환=read-only 무해). tight scout: scheduler(없음)·skills(allowlist+spawn 안전)·feeds/objectives(read, clamp 정확)·loopback-helpers(공유 numeric helper 부재)·relative-time(~50 phrase 라이브 정확) 전부 clean.
- **왜:** fresh-handler 버그 vein이 fires 87-93(contacts·calendar·time·on_this_day·home_action 5 버그 + drill 1)에서 productive였으나 이제 **고갈** — 3 scout(87/89/92) + tight scout(94) + 직접 grep이 표면 well-hardened 확정. EXHAUSTION 규칙: value-class 상향(bug-hunt scout) 시도 → dry. "할 게 없다" 아님: 6 fire 연속 genuine 수정 후의 정직한 maturity.
- **리뷰지점:** 코드 변경 0. 미수행 옵션: (a) DRY-refactor(rollover 가드 3-copy → 공유 helper) = risky(보안 date 파서 3개 fiddly rewire) + codebase-quality territory(backlog ◦ 유지). (b) week-agenda daysUntil 정수-가드 = scout가 non-user-reachable·not-a-bug 판정("could be stricter" 안티패턴). 둘 다 이 fire 슬라이스로 부적합.
- **리스크:** 없음 — 코드 무변경. 다음 fire: 진안 unblock 레버(email/handle grounding=agent-core-hot, MCP-risk posture, undo/veto) 또는 새 신호(.muse/runs 실패 클러스터) 또는 재-fresh-scout(다른 표면). vein 고갈 backlog 기록.


## fire 95 · 2026-06-14 · skill v1.14.0 · 13d6c45c
meta: value-class=micro-fix(real precision bug) · pkg=@muse/tools · kind=substring-false-positive-fix(mutation-intent gate가 단어 중간 substring 매치) · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 978 유지(+3 case tools.test) · fabrication 0 유지 · eval 무변동(노출 게이트는 eval 시나리오 미경유)
- **무엇:** isWorkspaceMutationPrompt(write 도구 노출 게이트 = workspace && mutation && target hint)의 hasWorkspaceHint/hasMutationTargetHint가 `normalized.includes(hint)`(substring) → **짧은 hint이 무관 영단어 중간 매치**: "pr"(pull request)→approve/price/surprise, "spec"→special/inspect/respect, "repo"→report, "event"→prevent. promptHasHint 헬퍼(`(?<![a-z])${hint}s?(?![a-z])` /u — standalone 토큰, plural·KO 조사 허용, latin 단어 중간 거부)로 수정.
- **왜:** write 도구 과노출 = distractor↑ → "fewer distractors = better one-shot selection"(같은 파일 relevance-filter tokeniser 주석이 word-boundary로 이미 보호하는 목표) 훼손. mutation-intent gate만 substring으로 남아있던 불일치. fresh 표면(도구 노출/투영 레이어, @muse/tools — per-handler bug과 다른 패키지·KIND). 3-way AND가 완화하나 "Delete the special surprise gift"는 pre-fix 3조건 모두 통과(오분류 실증).
- **리뷰지점:** index.ts promptHasHint + hasWorkspaceHint/hasMutationTargetHint 적용(mutationPatterns·koreanMutationHints·exceptions·multi-word/KO hint은 substring 유지). 테스트 RED("Delete the special surprise gift" expected true→false)→GREEN + 회귀가드(spec/endpoint·plural tickets·KO PR에·기존 issue/task). 첫 회귀 테스트(close=non-mutation 가정 오류)는 delete로 수정 후 amend. 전 196 pass, pnpm check exit=0, lint clean. ④b judge PASS 5/5(전 토큰 형태 probe: plural/digit-suffix/hyphen/조사 정확, under-match 없음).
- **리스크:** 없음 — 게이트가 더 엄격(false workspace-mutation 감소), 기존 true 케이스 전부 유지(under-expose 없음). 교훈: hint 매칭은 substring 아닌 토큰-경계(짧은 abbrev는 단어 중간 매치).


## fire 96 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=tool-delivery-layer-examined-clean(fire-95가 유일 버그 수정 후) · verdict=NO-SLICE · firesSinceDrill=4
ratchet: testFiles 978 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close)
- **무엇:** 슬라이스 없음(honest-close). fire 95가 연 도구-전달/노출 레이어 vein을 thorough 검사 — 전부 clean: (1) @muse/tools 노출(select/blockReason·relevance filter tokenMatchesKeywordWord word-boundary+≤3suffix+Korean-containment·comparator+relevanceScore·maxTools); (2) MCP 투영 createLoopbackMcpMuseTools(risk 충실 복사, mutating-verb 도구 중 write 주석 누락 0); (3) MCP allowlist McpManager register+connect(둘 다 enforce, terminal denial).
- **왜:** fire 94가 per-handler vein 고갈 → fire 95가 도구-전달 레이어로 피벗해 mutation-intent substring 버그 발굴+수정. fire 96이 그 vein 나머지를 검사 → clean. maxTools-NaN edge는 numberMetadata(`Number.isFinite?value:undefined`, runtime-helpers:101)가 upstream 방어 = reachable 아님("could be stricter" not-a-bug). exception hints(unassigned·미할당·Korean 포맷어)는 long/Korean이라 substring 무해 → fire-95 fix 완전했음 확인.
- **리뷰지점:** 코드 변경 0. 미수행: maxTools-NaN defense-in-depth(public API 견고성이나 defended upstream + could-be-stricter → not-a-bug 판정). 두 vein(per-handler·delivery) 모두 examined+clean = 테마 genuine maturity(87-95에서 6 real 버그 수정).
- **리스크:** 없음 — 코드 무변경. 다음 후보: 진안-blocked 레버(MCP-risk-annotation posture·undo/veto·email/handle grounding=agent-core-hot) / 외부-MCP 도구 투영 schema 심화 검사 / .muse/runs 신호 대기 / 다른 표면. vein 고갈 backlog 기록.


## fire 97 · 2026-06-14 · skill v1.14.0 · abd4f7af+f7074099
meta: value-class=new-capability(EXPANSION) · pkg=@muse/autoconfigure(+scripts eval) · kind=capability-extension(today_brief — today/triage 도구, week_agenda의 비대칭 trine) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 978→979(+today-brief-tool.test) · fabrication 0 유지 · eval:tools week-agenda 시나리오 5→**8/8 STABLE 3/3**(today_brief carve)
- **무엇:** 새 read 도구 today_brief — week_agenda의 TODAY/triage 쌍둥이. **OVERDUE(과거-due tasks/reminders/missed followups)를 LEAD**하고 오늘 남은 events/reminders/tasks 병합(1콜). composeTodayBrief 순수 aggregator(overdue: ms<now / today: now..cutoff, cutoff=end-of-day 또는 now+lookaheadHours) + createTodayBriefTool + autoconfigure 배선(todayInput thunk) + barrel export.
- **왜:** bug-hunt 양 vein 고갈(fire 94/96) → RATCHET "EXPANSION 절반 0건 실패" 명시 → value-class 상향. Opus EXPANSION scout가 **evidence-backed 갭** 발굴(1c: today 집계가 CLI/`/today`/API/web엔 있으나 agent 도구 미배선 — week는 fire 79에 받음 = 비대칭; 1a: commands-today.ts:596 in-code 주석이 4-call-chain 실패 명시). week_agenda는 forward planning(overdue 개념 없음) → carve real.
- **리뷰지점:** today-brief-tool.ts(aggregator+tool)+index.ts(배선+export)+today-brief-tool.test(599 green: overdue-lead·lookahead-window·unparseable-drop)+eval scenario(today_brief+week_agenda 둘 다 노출). **make-or-break confusability: eval 8/8 STABLE 3/3**(today/overdue→today_brief, week→week_agenda, cross-leak 0). pnpm check exit=0, lint clean. ④b judge PASS 5/5(eval 독립 재현 24 inference, week_agenda overdue-grep 0=carve 코드상 real). 첫 시도 inert(barrel export 누락→eval SKIP) 발견·수정.
- **리스크:** 거의 없음 — read-only(mutation 0, 새 write 표면 없음), agent-core 무관, 기존 week_agenda 선택 무회귀(carve 검증). EXPANSION 검증: 빌드+배선+단위+selection 모두 통과(inert 아님).


## fire 98 · 2026-06-14 · skill v1.14.0 · 6b53a9f1
meta: value-class=hardening · pkg=scripts(eval infra) · kind=irrelevance-coverage(today_brief IrrelAcc, fire-97 triad 완성) · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 980 유지(scripts-only) · fabrication 0 유지 · eval:tools week-agenda 8→**10/10 STABLE 3/3**(today_brief IrrelAcc)
- **무엇:** week-agenda 시나리오에 today_brief IrrelAcc 네거티브 2건 — KO "고마워, 오늘 도움 많이 됐어!"·EN "I'm in such a good mood today" → casual "오늘"/"today" 언급이 NO tool(today_brief over-fire 안 함). 전부 PASS 3/3.
- **왜:** fire 97이 today_brief를 selection+confusability 케이스로 ship했으나 IrrelAcc 누락. today_brief 주키워드 "today"/"오늘"은 **최고빈도 casual 충돌어**(thanks for today, good mood today) = eager-invocation 트랩. agent-testing.md triad(selection+confusability+irrelevance) 완성 — 새 도구의 trap 키워드 가드. fire 97(capability-extension)과 다른 KIND(IrrelAcc), fire 91 패턴.
- **리뷰지점:** eval buildWeekAgendaScenario +2 expectNoTool(순수 additive, week-agenda는 이전 IrrelAcc 0). strict noTool scorer. 10/10 STABLE 3/3(today_brief selection+week carve+casual-today 무발화 동시 검증). lint clean, harness 17. ④b judge PASS 5/5(fair·real-teeth: "오늘"은 today_brief 주키워드+casual 빈출, fire-86보다 강한 teeth). scripts-only라 pnpm check 무관(live eval+harness가 gate).
- **리스크:** 없음 — scripts-only, 순수 additive. GREEN-on-arrival이나 high-freq 트랩어("오늘")라 description/keyword 저하 regression 가드. firesSinceDrill=6.


## fire 99 · 2026-06-14 · skill v1.14.0 · e21cb3e1+06626072
meta: value-class=new-capability(EXPANSION) · pkg=@muse/autoconfigure(+scripts eval) · kind=capability-extension(day_recap — 회고 도구, today_brief의 retrospective 쌍둥이) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 980→981(+day-recap-tool.test) · fabrication 0 유지 · eval:tools +day-recap 시나리오 **6/6 STABLE 3/3**(risky carve hold)
- **무엇:** 새 read 도구 day_recap — today_brief의 RETROSPECTIVE 쌍둥이. **accomplished**(오늘 완료 tasks + fired reminders) + **slipping**(still-overdue) 병합(1콜). composeDayRecap 순수 aggregator + 배선(recapInput thunk) + barrel export + carve eval 시나리오.
- **왜:** EXPANSION scout가 today_brief-class 비대칭 발굴(recap 집계가 `muse recap` CLI+저녁 daemon엔 있으나 agent 도구 미배선). **person-dossier는 REJECT**(find_contact과 confusable). day_recap의 **carve가 make-or-break**(today_brief=forward / recent_actions=Muse 행동 / tasks.list=단일 — "did/done/뭐 했" 겹침). sharp description carve("for what MUSE did use recent_actions, NOT this") + 키워드 겹침 회피로 해소.
- **리뷰지점:** day-recap-tool.ts+index.ts(배선+export)+day-recap-tool.test(602 green)+eval scenario(day_recap+today_brief+recent_actions+tasks.list 동시 노출). **carve 6/6 STABLE 3/3**(회고→day_recap, "내 대신 뭐 했어"→recent_actions 안 cross). pnpm check exit=0, lint clean. ④b judge PASS 5/5(carve eval 독립 RE-RAN, discriminator 무-bleed). **⚠️ vitest-no-typecheck 트랩:** e21cb3e1을 빌드 전 커밋해 타입 에러 3개(optional dueAt/completedAt/firedAt non-null) 포함 → 06626072로 fix. 교훈: ④ 규칙대로 커밋 전 build.
- **리스크:** 거의 없음 — read-only(mutation 0), agent-core 무관, recent_actions/today_brief 선택 무회귀(carve 검증). EXPANSION 검증 통과(inert 아님).


## fire 100 · 2026-06-14 · skill v1.14.0 · 2a4d05e0
meta: value-class=hardening · pkg=scripts(eval infra) · kind=irrelevance-coverage(day_recap IrrelAcc, fire-99 triad 완성) · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 984 유지(scripts-only) · fabrication 0 유지 · eval:tools day-recap 6→**8/8 STABLE 3/3**(day_recap IrrelAcc)
- **무엇:** day-recap 시나리오에 day_recap IrrelAcc 네거티브 2건 — KO "오늘 하루 진짜 길었다…"·EN "Today was rough, honestly" → casual day remark이 NO tool(day_recap over-fire 안 함). 전부 PASS 3/3.
- **왜:** fire 99가 day_recap을 selection+confusability로 ship했으나 IrrelAcc 누락. day_recap 키워드에 **"오늘 하루"가 literal 포함**(day-recap-tool.ts:87) = 최고빈도 casual 충돌어("오늘 하루 길었어"). agent-testing.md triad 완성(fire 98 today_brief 패턴 미러). KIND=irrelevance-coverage(fire 99 capability-extension과 구별).
- **리뷰지점:** eval buildDayRecapScenario +2 expectNoTool(순수 additive). strict noTool scorer. 8/8 STABLE 3/3(day_recap selection+recent_actions/today_brief carve+casual-day 무발화 동시 검증). lint clean, harness 17. ④b judge PASS 5/5(fair·literal-keyword-collision teeth·accepted fire-98 precedent). scripts-only라 pnpm check 무관.
- **리스크:** 없음 — scripts-only, 순수 additive. GREEN-on-arrival이나 literal 키워드 충돌("오늘 하루")이라 description/keyword 저하 regression 가드. firesSinceDrill=8(드릴 fire 102 근접).


## fire 101 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=EXPANSION-digest-vein-exhausted(2 wins 후 잔여 confusable/served) · verdict=NO-SLICE · firesSinceDrill=9
ratchet: testFiles 984 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close)
- **무엇:** 슬라이스 없음(honest-close). EXPANSION 비대칭 디지털-digest vein 직접 검증 → 고갈: week_agenda(79)·today_brief(97)·day_recap(99) 3 shipped로 temporal 패밀리(week/today-forward/today-retrospective) 완결. 잔여 후보 전부 reject: morning_brief(`muse brief`)=today_brief와 heavily 겹침(둘 다 today tasks+events 집계, confusable); status=muse.status.snapshot 이미 agent 도구; person-dossier=find_contact과 confusable(fire 99 scout가 이미 reject).
- **왜:** fire 94/96에서 bug-hunt 양 vein(per-handler·delivery) 고갈 → fire 97/99에서 EXPANSION 상향(2 genuine wins, RATCHET under-served 절반 충족). 이제 EXPANSION digest vein도 dry — 잔여는 confusable(carve 실패 예정) 또는 이미-served. EXHAUSTION 규칙: 2 win 후 잔여가 마르면 정직 종료(가짜 confusable 도구 금지). budget 절약 위해 3rd scout 대신 직접 grep 검증.
- **리뷰지점:** 코드 변경 0. 미수행: morning_brief(confusable)·in-progress-event를 today_brief에 추가(debatable, "could be richer" not-a-bug)·MCP-risk-annotation posture(진안-decision). 두 EXPANSION 도구는 완전 triad 보유(97/98 today_brief, 99/100 day_recap).
- **리스크:** 없음 — 코드 무변경. 다음 후보: non-temporal EXPANSION scout(genuine non-confusable capability gap 있으면) / 진안-blocked 레버(MCP-risk posture·undo-veto·email-handle grounding=agent-core-hot) / .muse/runs 신호 대기. EXPANSION digest vein 고갈 backlog 기록. firesSinceDrill=9 → fire 102 JUDGE-DRILL.


## fire 102 · 2026-06-14 · skill v1.14.0 · 7ad46190(swept)
meta: value-class=micro-fix(real completeness bug) · pkg=@muse/autoconfigure · kind=JUDGE-DRILL(confusable EXPANSION FAIL 확인)+today_brief in-progress 이벤트 누락 fix · verdict=PASS · firesSinceDrill=0(드릴 완료, 리셋)
ratchet: testFiles 984→985(+today-brief in-progress 케이스) · fabrication 0 유지 · eval 무변동(aggregator-only, description 불변)
- **무엇:** (A) JUDGE-DRILL — 고의 confusable EXPANSION morning_brief(today_brief와 description 첫문장 거의 동일·키워드 today/오늘/plate 겹침) 주입 → ④b Opus judge **VERDICT: FAIL**(3항목: identical lead·subset-no-carve·redundant churn) → rollback(파일 삭제+index restore). (B) 진짜 fix — today_brief가 events를 `ms>=now`(upcoming)만 표시 → **진행 중 회의(start<now<end) drop** = "what's on my plate RIGHT NOW"인데 현재 회의 누락. start<now<end면 "(now)" 표시(finished는 drop), endsAtIso? optional 추가.
- **왜:** firesSinceDrill 10 → 드릴 미루기 불가(confusability 바 재검증, maker≠judge 보상통제). 실수정: fire 101서 "could be richer"로 deferred했으나 재평가 — 도구 목적("plate right now")상 진행 중 항목 누락은 cosmetic 아닌 **완성도 버그**(fire 101 EXPANSION-vein-exhausted honest-close를 부분 refute — shipped 도구에 genuine 갭 있었음).
- **리뷰지점:** today-brief-tool.ts(events 루프 + endsAtIso? + composeTodayBrief)+index.ts(배선 endsAtIso 매핑, e.endsAt optional 조건부)+test(in-progress RED→GREEN, finished 제외). branches mutually-exclusive(ms>=now vs ms<now, no double-push), end==now strict drop, no-endsAtIso→drop(pre-fix 동작). 빌드 후 커밋(fire 99 교훈). 604 green, pnpm check exit=0, lint clean. ④b judge PASS 5/5(crux #2 over-inclusion 없음 확인). ⚠️ sweep 재발(동시 codebase-quality merge 7ad46190가 미커밋 fix 포착).
- **리스크:** 없음 — events 처리만 변경(overdue/today partition·description·keywords 불변→selection 무회귀), endsAtIso optional(기존 caller/eval 무파손), read-only.


## fire 103 · 2026-06-14 · skill v1.14.0 · 0d94ee1e
meta: value-class=micro-fix(regression-correction of fire 102) · pkg=@muse/autoconfigure · kind=today_brief all-day 이벤트 mis-render fix · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 985→986(+all-day 케이스) · fabrication 0 유지 · eval 무변동(aggregator-only, description/keywords 불변)
- **무엇:** fire 102가 추가한 in-progress 분기(`start<now<end` → "(now)")가 **all-day 이벤트를 오분류**: allDay 이벤트는 start=자정<now<end=하루끝이라 그 분기에 빠져 "00:00 <title> (now)"로 렌더 — 생일/공휴일/여행이 흔한 all-day인데 가짜 timed 항목이 됨. fix: TodayBriefInput.events에 `allDay?` 추가, composeTodayBrief가 allDay면 timed 로직 *전에* "📅 <title> (all day)"로 렌더+continue(자정 start로 정렬→오늘 항목 최상단). 배선(index.ts ~759)이 CalendarEvent.allDay → `allDay:true` 매핑.
- **왜:** fire 102 in-progress fix가 노출한 직접 회귀(just-shipped 변경의 textbook follow-up 하드닝, value churn 아님). all-day는 calendar의 1급 이벤트 종류(allDay:boolean required)이고 "지금 내 plate"에서 "00:00 (now)"는 명백히 오해유발 — cosmetic 아닌 correctness.
- **리뷰지점:** today-brief-tool.ts(allDay 분기 timed 로직 위, continue) + index.ts(배선 conditional spread) + test(RED: "00:00 (now)" → GREEN: "📅 (all day)", NOT 00:00·NOT (now)). 빌드 후 즉시 커밋(fire 99 교훈, sweep 회피 — 이번엔 0d94ee1e 안 쓸림). 605 green, pnpm check exit=0, lint clean. ④b Opus judge PASS 6/6(crux #1 pre-fix가 진짜 "00:00 (now)" 냈는지·#5 ratchet 3/8 same-pkg 미달 확인).
- **리스크:** 없음 — allDay 이벤트 렌더 경로만 분기(timed/in-progress/upcoming·overdue partition·description·keywords 불변→selection 무회귀), allDay optional(기존 caller/eval 무파손), read-only.


## fire 104 · 2026-06-14 · skill v1.14.0 · b2cfefd4
meta: value-class=hardening(latent parity bug in sibling tool) · pkg=@muse/autoconfigure · kind=week_agenda all-day 이벤트 mis-render fix(today_brief parity) · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 987→988(+week-agenda all-day 케이스) · fabrication 0 유지 · eval 무변동(렌더 fix, selection/schema 불변)
- **무엇:** week_agenda가 today_brief와 **동일한 all-day 결함** 보유 — groupWeekAgenda가 모든 이벤트를 무조건 `toTimeString().slice(0,5)` HH:MM로 렌더하고, 배선(index.ts:740)이 CalendarEvent.allDay를 드롭 → date-only 휴일/여행이 "00:00 Christmas"(가짜 시계시각)로 표시. 14일 span이라 single-day today_brief보다 all-day 노출 多. fix: WeekAgendaInput.events에 `allDay?` 추가, allDay면 "📅 <title> (all day)"로 렌더(자정 ms로 그날 최상단 정렬), 배선이 allDay 매핑.
- **왜:** parity 결함 — fire 102/103이 today_brief의 all-day/in-progress를 고쳤으나 쌍둥이 week_agenda는 미수정으로 동일 버그 잔존. scout가 mcp 도구들(interactionsFromEvents·overdue IrrelAcc) clean 확인 후 이걸 최고가치로 PICK. "같은 결함을 존재하는 모든 곳에서 고친다"는 정당 hardening(가짜 vein churn 아님), value-class=hardening·다른 파일.
- **리뷰지점:** week-agenda-tool.ts(allDay 분기 else 보존) + index.ts:740(배선 conditional spread) + test(RED: "00:00 Christmas" → GREEN: "📅 (all day)"·NOT 00:00·"15:00 Standup" 유지=timed 불변 증명). 빌드 후 즉시 커밋(sweep 회피, b2cfefd4 안 쓸림). 606 green, pnpm check exit=0, lint clean. ④b Opus judge PASS 6/6 — crux #5 KIND-monotony 정밀검토(3연속 event-render fire) 후 ratchet 4/8 same-pkg·2/8 micro-fix 미tripped + latent parity 정당 판정. tasks/reminders/birthdays/bucketing/clamp/sort 불변 확인.
- **리스크:** 없음 — allDay 이벤트 렌더 경로만 분기(timed/task/reminder/birthday·day-window·정렬 불변→selection 무회귀), allDay optional(기존 caller/eval 무파손), read-only. ★다음 fire 주의: all-day/event-render vein 양 digest 도구서 고갈 — 105는 반드시 다른 vein(non-temporal EXPANSION scout·다른 패키지 hardening·.muse/runs 신호).


## fire 105 · 2026-06-14 · skill v1.14.0 · da9ddba0
meta: value-class=hardening(reachable SSRF security fix) · pkg=@muse/mcp · kind=SSRF bypass close(IPv4-mapped IPv6 hex normalization) · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 987 유지(기존 web-url-guard-boundaries.test.ts에 +2 케이스) · fabrication 0 유지 · eval 무변동(결정적 가드 로직, selection 무관)
- **무엇:** web-url-guard.ts의 `isPrivateIPv6`가 **dotted** IPv4-mapped form(`::ffff:127.0.0.1`)만 매칭 → WHATWG `new URL()`이 host를 **hex**로 정규화(`::ffff:7f00:1`)하므로 실 URL에선 dotted 분기 절대 안 탐 → loopback/cloud-metadata(`169.254.169.254`→`::ffff:a9fe:a9fe`)/RFC-1918 mapped가 "public"으로 통과 = wired web_download/web_action/web_read 도구의 **reachable SSRF/메타데이터 유출 구멍**. fix: hex 2그룹을 octet으로 디코딩(`(hi>>8)&0xff…`)해 isPrivateIPv4 재실행; 정상 public mapped(`::ffff:8.8.8.8`)는 통과 유지.
- **왜:** non-autoconfigure 강제(ratchet autoconfigure 5/8) + 다른 KIND(security, 3연속 event-render 탈피). scout가 file-read(이미 realpath 재검증)·web-download(size/redirect 캡)·smart-home(fail-close) 검토 후 이걸 유일 reachable 보안 결함으로 PICK. 컴파일 가드로 exploit 직접 재현(ALLOWED ✗)→fix 후 blocked ✓. 보안 작업=이 테마의 가치 본령.
- **리뷰지점:** web-url-guard.ts(hexMapped regex+octet 디코딩, 기존 dotted 분기 보존) + 기존 boundaries 테스트에 +2(helper hex form + assertPublicHttpUrlSync end-to-end 3 URL). 기존 dotted 케이스(line 49-52)는 regex 매칭되는 입력만 테스트해 **실 URL 경로 미커버=거짓 확신**이었음(이번에 hex 경로 추가로 메움). 1864 green, @muse/mcp 격리 재확인. ④b Opus judge PASS 7/7 — octet 디코딩 산술(a9fe→169.254.169.254)·padded/uncompressed form 동일 정규화·over-match 부재(`2001:db8::ffff:1` 미차단 안 함) 정밀검증. ⚠️ pnpm check exit-134는 @muse/auth OOM(동시 루프 메모리 포화); auth 격리 61/61 green·mcp 변경은 auth 무의존 → 환경, 진짜 회귀 아님.
- **리스크:** 없음 — 가드를 더 엄격하게만(over-block 없음 확인: 8.8.8.8/example.com/GUA 통과), 순수 분류 함수 +10라인 추가(기존 절 무변경), read-path만. 비차단 후속: deprecated IPv4-compatible form(`::127.0.0.1`, ffff 없음) 미디코딩 — backlog ◦ 기록(low-risk, RFC4291 deprecated).


## fire 106 · 2026-06-14 · skill v1.14.0 · e874bb25
meta: value-class=hardening(date-arithmetic correctness bug) · pkg=@muse/mcp · kind=Feb-29 생일 rollover phantom-surface fix · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 988 유지(기존 birthday-briefing.test.ts에 +3 케이스) · fabrication 0 유지 · eval 무변동(순수 store 로직, selection 무관)
- **무엇:** `resolveUpcomingBirthdays`가 next occurrence를 `new Date(year, 1, 29)`로 생성 → 비윤년(2026)에 Mar 1로 silent rollover → 02-29 생일이 daily brief/upcoming_birthdays 도구에 "in 2 days"·존재하지 않는 date "02-29"로 phantom imminent(실제 다음 Feb-29는 2028, ~733일 후). fix: isLeapYear 헬퍼 + occurrence(year) inner fn이 비윤년엔 02-29→day 28 clamp(윤년 유지), 보고 date를 raw md.day 아닌 resolved occ.day에서 파생(date+daysUntil 일관). 非-Feb-29 생일 무변경.
- **왜:** non-autoconfigure(ratchet) + 다른 KIND/seam(contacts date-arithmetic, web-url-guard SSRF와 다른 파일/관심사). scout가 weather(place name이라 lat/lon 노출 없음)·remember_fact/feeds/objectives(검증 clean)·contacts substring match(resolveContact 이미 exact 우선·phoneMatches ≥7자리) 검토 후 이걸 유일 reachable correctness 결함으로 PICK. on_this_day Feb-29도 같은 family지만 lower-value(rare·single-day choice defensible)라 reject. 컴파일 dist로 phantom 직접 재현.
- **리뷰지점:** personal-contacts-store.ts(isLeapYear + occurrence clamp, year-wrap가 +1년 leap 재평가) + birthday-briefing.test.ts +3(non-leap 2026→02-28/daysUntil1·NOT 02-29, leap 2028→02-29/daysUntil2, Mar-5 비-imminent). 빌드 후 즉시 커밋(e874bb25, sweep 회피). 1867 green, pnpm check exit=0, lint clean. ④b Opus judge PASS 7/7 — Gregorian leap rule(2000✓/1900✗/2100✗)·clamp 범위(month2&day29&non-leap만)·year-wrap leap 재확인(Mar2027→2028 leap→02-29)·Feb-28 midnight 경계(daysUntil 0, same-day hit not roll) 무자비 검증.
- **리스크:** 없음 — Feb-29 경로만 분기(非-leap-day 생일 출력 동일·sort/withinDays/parse 불변), 순수 함수 무 I/O, read-path. on_this_day Feb-29 projection은 별도 vein(backlog 후보, 이번 미포함).


## fire 107 · 2026-06-14 · skill v1.14.0 · 23728582
meta: value-class=new-capability(EXPANSION) · pkg=@muse/autoconfigure(+apps/cli move·scripts eval) · kind=find_items cross-store 키워드 sweep 도구(non-temporal axis) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 989→990(+find-items-tool.test 4 케이스) · fabrication 0 유지 · eval:tools +1 시나리오(find-items 7 케이스 STABLE 3/3)
- **무엇:** structured store(tasks+reminders+contacts+events) substring sweep가 `muse find` CLI로만 존재 → agent 도구 미투영이라 12B가 4개 list 체이닝+키워드 교집합(coherence 붕괴)을 불안정하게 수행. find_items로 투영: 순수 findAcrossDomains+types를 apps/cli→@muse/autoconfigure 이동(runtime이 투영하는 패키지, relationship-tool 선례, no dup), CLI re-import. createFindItemsTool(risk:read·domain knowledge) tool-array 배선(find: closure가 실 store 읽음).
- **왜:** fires 102-106 5연속 hardening/bug-fix로 EXPANSION 0건 — 루프가 명시적으로 막는 "EXPANSION 절반 0" 실패. fire 101 honest-close가 named한 "non-temporal EXPANSION scout(genuine non-confusable gap)" 후보 실현. temporal-digest family(week/today/recap)는 고갈 유지 — find_items는 NON-temporal axis(topic across my items)라 별 vein. value-first: 가짜 confusable 도구가 아닌 진짜 갭(eval로 carve 증명).
- **리뷰지점:** find-items-tool.ts(이동된 순수 로직+도구) + index.ts(import+배선 thunk+barrel) + commands-find.ts(local def 제거·re-import) + commands-find.test.ts(import re-point) + eval-tool-selection.mjs(buildFindItemsScenario 등록). 611 green·cli 2642 green·**eval:tools find-items STABLE 3/3 전 7케이스**(3 positive selection + 3 confusability 이웃 find_contact/web/notes 비교차 + IrrelAcc "found my keys"). ④b Opus judge PASS 8/8 — crux #2(wired: find closure 실 store) #3(eval 7/7 직접 재실행) 무자비 검증 + no-dup(findAcrossDomains 1곳) + cross-loop swarm noise 독립 확인. ⚠️ git stash 사고: HEAD~1 swarm 검증 중 stash가 동시 cognition 루프 미커밋 작업(followup-capture-hook·user-context-commitment) 포착→index.ts import 충돌, committed-main으로 해소(타 루프 파일 미접촉); swarm fail은 그 미커밋 agent-core發 증명(격리 시 2642 green), 내 커밋 무관.
- **리스크:** 낮음 — 새 read 도구(no write), 이동은 byte-identical 로직(CLI 무회귀 2642 green), eval로 selection 신뢰성 증명. 잔여: pnpm check는 동시 루프 미커밋 swarm fail로 red(내 슬라이스 무관, 다음 루프 커밋 시 해소). 다음 fire: EXPANSION 1건 달성 후 hardening/EXPANSION 균형 — non-confusable gap 더 있으면 EXPANSION, 없으면 hardening.


## fire 108 · 2026-06-14 · skill v1.14.0 · 106b520c
meta: value-class=hardening(reachable SSRF completeness fix) · pkg=@muse/mcp · kind=deprecated IPv4-compatible+SIIT IPv6 SSRF form close · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 990 유지(기존 web-url-guard-boundaries.test.ts에 +2 케이스) · fabrication 0 유지 · eval 무변동(결정적 가드)
- **무엇:** ① baseline에서 lint:pass→fail 회귀 떴으나 진단 결과 **동시 cognition 루프의 미커밋 followup-capture-hook.ts:217**發(committed main은 clean — 그 파일만 stash시 error 소멸), 내 책임 아님 → 정상 슬라이스 진행. fire-105가 IPv4-mapped form만 닫았으나 probe로 **deprecated IPv4-compatible form 여전히 우회 확인**: `new URL()`이 `[::127.0.0.1]`→`::7f00:1`, `[::169.254.169.254]`→`::a9fe:a9fe`(메타데이터 REACHABLE), `[::ffff:0:127.0.0.1]`→`::ffff:0:7f00:1`(SIIT) 정규화, 전부 public 분류. fix: 단일 mapped regex를 일반 `expandIPv6Hextets` 파서+embedded-IPv4 검사로 대체(upper 6 hextets 전부 0x0000/0xffff → low 32bit를 IPv4로 디코딩→isPrivateIPv4).
- **왜:** fire-105 judge가 deprecated form을 "low-risk"로 비차단 노트했으나 probe가 **메타데이터 reachable임을 반증** — security completeness가 곧 가치(테마). 단일 regex보다 파서가 robust(compatible/mapped/SIIT 모든 embedding form 일거에 커버, fire-105 regex subsume). non-autoconfigure·SSRF는 3연속 KIND 아님(105 SSRF·106 Feb-29·107 EXPANSION).
- **리뷰지점:** web-url-guard.ts(expandIPv6Hextets 파서 + isPrivateIPv6 embedded 검사, fire-105 hexMapped regex 제거·파서가 subsume) + boundaries 테스트 +2(helper 6 form + assertPublicHttpUrlSync end-to-end 4 URL, over-block 가드 2001:db8::7f00:1 포함). 1869 green, 내 파일 lint clean(유일 lint error는 동시 루프 followup-capture-hook). ④b Opus judge PASS 7/7 — completeness(13 embedding 전부 blocked: CGNAT·uppercase·uncompressed)·over-block(6 public 통과)·parser malformed-safe(8 입력 무throw)·fire-105 무회귀 무자비 검증. NAT64는 scope 내 acceptable follow-up(backlog ◦).
- **리스크:** 없음 — 가드 더 엄격하게만(over-block 0 확인), 순수 분류 함수, read-path. 잔여: NAT64 `64:ff9b::/96` 미커버(backlog ◦, narrower vector). pnpm check는 동시 루프 미커밋 lint/swarm fail로 red(내 슬라이스 무관). 교훈: ① baseline 회귀가 동시 루프 미커밋發일 수 있음 — 진단 후 cross-loop면 정상 진행([[project_main_worktree_git_hazards]]).


## fire 109 · 2026-06-14 · skill v1.14.0 · 82580783
meta: value-class=hardening(coverage-guard + schema consistency, NOT a live bug) · pkg=@muse/mcp(+scripts eval) · kind=tasks.add dueAt time-phrase argFieldMatches guard 추가 · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 994 유지(eval 케이스 +1, 단위 testFile 수 무변동) · fabrication 0 유지 · eval:tools personal-crud +1 케이스(tasks.add dueAt STABLE 3/3)
- **무엇:** scout가 tasks.add per-property dueAt 스키마("ISO-8601 due timestamp")가 12B에게 ISO pre-compute를 유도(P45-20)한다고 가설 → eval 케이스 추가해 검증했으나 **gemma4:12b는 현 스키마로도 phrase를 통과 3/3**(tool-level prose "pass the phrase" 우세). live 버그 재현 안 됨. 정직히 재framing: ① tasks.add가 형제 add 도구 중 **유일하게 dueAt phrase argFieldMatches 가드 누락**(reminders.add/calendar.add는 보유) — 그 회귀 가드 추가(agent-testing.md time-field 가드 mandate). ② per-property dueAt 스키마를 sibling update(line 340)와 정렬(prose/스키마 모순 제거).
- **왜:** 선언-only 아님 — eval 케이스가 실 모델 행동 검증(argFieldMatches가 dueAt 필드에 /내일|오후/ 요구, ISO면 trip). live RED는 없지만 가드는 real tripwire(미래 모델/잘못된 스키마 편집이 ISO pre-compute하면 FAIL). 스키마 정렬은 cosmetic 아님 — 핸들러(parseTaskDueAt)가 실제 phrase resolve하므로 스키마가 이제 진실을 말함. write-path(잘못된 instant 영속 방지)·non-web seam(SSRF 2회 후 다양화).
- **리뷰지점:** loopback-tasks.ts(dueAt 스키마 description) + eval-tool-selection.mjs(buildPersonalCrudScenario에 tasks.add dueAt phrase 케이스). 1869 green·loopback-tasks lint clean·**eval personal-crud 13/13 STABLE 3/3**(tasks.add dueAt 포함). ④b Opus judge PASS 8/8 — 정직성(overclaim 없음)·real gap(형제 비교로 lone-missing 확인)·tripwire 검증(argFieldMatches field-targeted, ISO면 trip)·스키마 정렬 truthful 무자비 검증; "live 버그 없어도 coverage-guard 가치가 bar 통과" 명시 판정.
- **리스크:** 낮음 — 스키마 string + eval 케이스만(핸들러 무변경, 1869 green), read하면 무해. 잔여: 이 vein(time-field 가드)은 3 add 도구 모두 커버 완료. ★다음 fire 110 = JUDGE-DRILL 예정(allPASS streak 7→8, firesSinceDrill 7→8) — 고의 나쁜-슬라이스 주입→judge FAIL 확인→롤백→진짜 fix, 미루기 불가.


## fire 110 · 2026-06-14 · skill v1.14.0 · 91c0244d (JUDGE-DRILL)
meta: value-class=hardening(SSRF NAT64 completeness) · pkg=@muse/mcp · kind=JUDGE-DRILL(inert 도구 FAIL 확인)+NAT64 prefix SSRF close · verdict=PASS · firesSinceDrill=0(드릴 완료, 리셋)
ratchet: testFiles 994 유지(boundaries 테스트 +1 NAT64 케이스) · fabrication 0 유지 · eval 무변동(결정적 가드)
- **무엇:** (A) JUDGE-DRILL(allPASS streak 8 트리거) — 고의 inert 도구 task_count 주입(핸들러 단위테스트 green·배럴 export까지 했으나 **assembly 배선 누락 + eval 골든 없음**, self-incriminating 주석 없이 현실적 실수 형태) → ④b Opus judge **VERDICT: FAIL**(crux #2 wired: 배럴 re-export만·배선 0, #3 selects: eval 케이스 0 → "미배달"; 핸들러 green 불충분 명시) → 롤백(git checkout index.ts + 새 파일 rm, build clean). (B) 진짜 fix — NAT64 well-known prefix `64:ff9b::/96`(RFC 6052)가 embedded IPv4를 low 32bit에 담아 게이트웨이가 번역 → `[64:ff9b::169.254.169.254]`→host `64:ff9b::a9fe:a9fe`로 메타데이터 도달, 그런데 prefix 0064:ff9b가 0/0xffff 아니라 fire-108 검사 skip. isPrivateIPv6에 NAT64 prefix 인식(exact hextets[2..5]==0) 추가해 low 32bit 디코딩.
- **왜:** 드릴 — firesSinceDrill≥8 하드카운터(maker≠judge 보상통제 재검증, 롤백 경로 살아있음 확인). 미루기 불가. 실수정 — NAT64는 fire-108 judge가 지목한 유일 잔여 embedded-form 갭(backlog ◦), probe로 메타데이터 도달 재현, security completeness=가치. 3번째 web-url-guard SSRF이나 비연속(109 tasks.add 사이).
- **리뷰지점:** (드릴) task_count 주입→judge FAIL→롤백 clean(task_count 흔적 0). (실수정) web-url-guard.ts(NAT64 isNat64 분기, fire-105/108 upperEmbeds 분기 불변) + boundaries 테스트 +1(NAT64 private→blocked·public 8.8.8.8→allowed). 1870 green·내 파일 lint clean. ④b Opus judge 실수정 PASS 7/7 — completeness(NAT64-of-private 5종 전부 blocked)·over-block 0(exact /96: `64:ff9b:1::`·`64:ff9b:0:0:0:1:…` 미오인, public NAT64 통과)·fire-105/108 무회귀 무자비 검증.
- **리스크:** 없음 — 가드 더 엄격하게만(over-block 0 확인), 순수 분류 함수 read-path. embedded-IPv4 SSRF 가드 vein 완결(mapped/compatible/SIIT/NAT64 모두 커버). pnpm check는 동시 루프 미커밋 lint/swarm fail로 red(내 슬라이스 무관). 드릴 교훈: inert(배선/eval 누락)을 judge가 핸들러-green에도 정확히 FAIL — 자동 게이트(build/test)가 못 잡는 미배달을 maker≠judge가 잡음.


## fire 111 · 2026-06-14 · skill v1.14.0 · 9a53af23
meta: value-class=hardening(harmful-direction correctness bug) · pkg=@muse/autoconfigure · kind=overdue_contacts 이름 substring false-match fix · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 995 유지(relationship-tool.test +3 케이스) · fabrication 0 유지 · eval 무변동(헬퍼 매칭 로직, selection/description 불변)
- **무엇:** `interactionsFromEvents`가 연락처 이름을 raw `event.text.includes(needle)`로 매칭 → "ann"이 "pl**ann**ing", "sam"이 "**Sam**sung"에 매칭 → 가짜 최근 상호작용 주입 → 하류 overdueContacts가 gap-since-last-contact를 ~0으로 붕괴 → **정작 소홀한 사람을 "누구한테 연락 뜸했지?"에서 silently DROP**(harmful 방향: 도구가 surface해야 할 사람을 누락). fix: ASCII 이름은 whole-word만(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, promptHasHint 미러), non-ASCII(한국어)는 substring 유지(조사가 이름에 직접 붙음 "민지랑"이라 word-boundary면 회귀), metachar 이스케이프, per-contact precompile.
- **왜:** fresh seam(@muse/autoconfigure relationship-tool, mcp 5/8에서 다양화·SSRF vein 완결 후 비-SSRF) + 실 outcome 버그(답을 harmful 방향으로 변형). 코드베이스의 마지막 raw-substring 이름 매처를 promptHasHint/groundToolArguments가 이미 채택한 word-boundary 규율로 통일(principled). wired 3소비자(overdue_contacts 도구·muse contacts overdue CLI·evening recap) 동시 수정.
- **리뷰지점:** relationship-tool.ts(matchers precompile, ASCII word-boundary/non-ASCII substring 분기) + test +3(EN-FP planning/Samsung→[], EN-TP+KO-particle 보존, 종단상태 tool에서 overdue Ann 안 누락 gapDays 60). 614 green·내 파일 lint clean. ④b Opus judge PASS 7/7 — crux #2(매칭 로직) 무자비 probe: prefix(Sam⊄Samsung)·suffix(Ann⊄Deann)·punctuation·space·metachar(J.R.⊄JxR 이스케이프)·한국어(민지⊂민지랑) 전 케이스 통과, false-positive 누출 0·Korean over-block 0·crash 0.
- **리스크:** 없음 — 매칭 더 엄격하게만(한국어 substring 보존으로 true-positive 무회귀, 기존 Mina/Mimi 테스트 green), 순수 함수 read-path, 하류 overdueContacts 불변. embedded-substring-false-match vein은 이름 매처에 한해 완결(promptHasHint·groundToolArguments는 이미 word-boundary). pnpm check red는 동시 루프 미커밋 noise.


## fire 112 · 2026-06-14 · skill v1.14.0 · 7fe1488a
meta: value-class=hardening(P45-20 live correctness fix) · pkg=@muse/mcp(+scripts eval) · kind=calendar read 도구 fromIso/toIso→from/to 중립명 rename · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 997 유지(calendar-availability +1 back-compat 케이스) · fabrication 0 유지 · eval:tools calendar-read +3 argFieldIncludes(전 3 도구 from phrase STABLE 3/3, 이전 0/3)
- **무엇:** Opus scout가 NO-GENUINE-GAP 보고하며 calendar read 도구의 `fromIso`/`toIso` 필드명을 P45-20 잔여로 "uncertain RED"라 언급 → **probe-first 검증**(eval REPEAT=3)으로 진짜 라이브 버그 확정: "이번 주 언제 비어?"에 모델이 `fromIso="2025-01-24T13:48:00Z"`(**잘못된 연도 2025**, 오늘 2026) 환각 pre-compute → parseIsoDate가 2025년 1월 윈도우로 availability 계산 = 완전 오답(phrase 검증 0/3). calendar ADD는 startsAt로 고쳤으나 READ 3 도구(list/availability/conflicts) 누락. fix: 모델-facing 필드를 중립 `from`/`to`로 rename, 핸들러는 `from ?? fromIso` back-compat(CLI HTTP/legacy 무파손).
- **왜:** P45-20는 0/8→8/8 기록 고가치 레슨(`*Iso` 필드명 자체가 steer). scout가 "mitigated(description이 phrase 언급)"로 과소평가했으나 description이 있어도 **필드명이 우세**해 wrong-year ISO 환각 — probe가 입증. 라이브 correctness 버그(coverage-guard 아님): argFieldIncludes가 `from` 필드 요구라 pre-rename(값이 fromIso 아래+ISO엔 phrase 없음) 구조적으로 불가 → 진짜 RED→GREEN.
- **리뷰지점:** loopback-calendar.ts(3 도구 스키마 from/to + 핸들러 back-compat + 에러문구 + required) + calendar-availability.test(primary from/to + legacy fromIso back-compat 케이스 + error assert) + eval(3 argFieldIncludes). 1871 green·내 파일 lint clean·**eval calendar-read STABLE 3/3 전 3 도구**(이전 "이번 주" 0/3→PASS, 모델이 `{"from":"this week"}` 전달). ④b Opus judge PASS 7/7 — genuine LIVE fix 확정(argFieldIncludes on `from` pre-rename 구조적 불가)·back-compat load-bearing+검증·output 필드(windowFromIso 등) 불변·CLI HTTP 경로(apps/api/calendar-routes.ts 자체 파서) 무영향·3 도구 일관 무자비 검증.
- **리스크:** 없음 — 입력 필드명만 중립화(semantics 불변, parseIsoDate 라우팅·defaults·output 불변), legacy fromIso back-compat로 기존 caller 무파손(테스트 증명). ★LESSON: scout가 *Iso 잔여를 "uncertain RED"라 하면 honest-close 말고 probe(eval REPEAT=3) — wrong-year 버그를 scout가 과소평가했음. pnpm check red는 동시 루프 미커밋 noise.


## fire 113 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=per-tool+meta-tool veins source-verified hardened(2nd 연속 clean scout) · verdict=NO-SLICE · firesSinceDrill=3
ratchet: testFiles 998 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close)
- **무엇:** 슬라이스 없음(honest-close). ① `*Iso` 입력필드명 vein 완결 확인(grep 0 — calendar read가 마지막, fire 112). ② Opus scout가 meta-tool 영역 5개 source-level 검토 → 전부 hardened: approval/outbound gate(executeToolCall try/catch fail-close, *WithApproval 라우팅, messaging DENY_WITHOUT_CONFIRMATION 더블 fail-close)·MCP risk-restamp(withOfficialMcpRisk wired index.ts:818, unlisted destructive→write, allowlist 정확)·relevance filter(word-boundary·relevance-first sort·CJK)·arg validation(enum을 핸들러서 재검증: web_action method/remember_fact kind)·EXPANSION(non-confusable 갭 없음). ③ scout가 남긴 유일 후보(MCP risk-restamp eval 커버리지)도 **이미 테스트됨**(official-mcp-write-draft-first·mcp-stack-official-presets·official-mcp-presets 3 파일) → redundant.
- **왜:** 2회 연속 clean scout 보고(112 NO-GAP→probe로 fromIso 발견했으나, 113은 source-level 검증으로 probe 여지도 없음). EXHAUSTION 규칙: 3번째 scout로 토큰 더 안 태우고 value-class 올렸으나(meta+EXPANSION = 최고 레버리지) 마름. 가짜 marginal 슬라이스는 ④b judge가 FAIL(JUDGE-DRILL 입증) — 정직 종료가 fabrication보다 낫다. 코드베이스가 자기 레슨 내재화(enum-recheck·fail-close-on-throw·risk-restamp·word-boundary·relevance-first).
- **리뷰지점:** 코드 변경 0. scout 174k 토큰 source-level 검토(approval gate·MCP projection·relevance filter·arg validation·EXPANSION). 미수행: 직접 bug vein 고갈 — 다음 fire 후보는 (a) .muse/runs 실패 신호 대기, (b) 더 깊은 end-to-end eval 커버리지 감사, (c) 진안-blocked 레버(MCP-risk 기본 posture·undo/veto·email-handle grounding). 
- **리스크:** 없음 — 코드 무변경, floor·불변식 무접촉. ★다음 fire: 직접 correctness/security bug vein이 source-level로 고갈 — fresh 신호(.muse/runs) 없으면 EXPANSION 재시도 또는 진안-blocked 레버 escalate 고려. firesSinceDrill=3(no-slice도 fire 카운트).


## fire 114 · 2026-06-14 · skill v1.14.0 · 6c2ba105
meta: value-class=hardening(write-tool eval coverage, NOT a live bug) · pkg=scripts(eval) · kind=remember_fact eval triad(selection+confusability+IrrelAcc) 추가 · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 998 유지(eval 케이스, 단위 testFile 무변동) · fabrication 0 유지 · eval:tools +1 시나리오(remember-fact 8 케이스 STABLE 3/3)
- **무엇:** fire 113 honest-close 후 value-class 올리기 → blocker 후보 (b) eval-coverage 감사. `remember_fact`(risk:**write**, durable fact/pref 영속)가 eval:tools 커버리지 **전무** 발견. buildRememberFactScenario 추가 — 완전 triad: selection 3(durable fact/pref) + confusability 2(자기 "do NOT use for" tasks.add/notes.save) + IrrelAcc 3(fleeting statement "방금 커피 마셨어"/"I'm tired" → NO tool, write 도구라 over-fire=메모리 오염). probe-first로 over-fire 확인 → 없음.
- **왜:** write 도구 zero-coverage는 명확한 agent-testing.md 갭(write는 IrrelAcc 필수, spurious 영속=실 harm). live 버그 아님(coverage-guard) — 정직 framing. ★probe가 confound 규명: **all-namespaced 이웃 set이 가짜 selection 실패 제조**(12B가 flat remember_fact 대신 존재하지 않는 `muse.facts.add`/`muse.memory.add` 환각). 혼합(flat find_contact/weather + namespaced muse.*) 이웃=production 대표로 재-probe → 8/8 STABLE 3/3. fire-112 probe-first가 이번엔 진짜 버그 대신 eval 비대표성을 드러냄.
- **리뷰지점:** eval-tool-selection.mjs만(remember_fact 코드 무변경). 8 케이스 STABLE 3/3. ④b Opus judge PASS 8/8 — 정직성(no overclaim)·real gap(zero prior coverage)·IrrelAcc tripwire 실재(noTool=0-call 단언)·**representative 이웃 set 공정함 decisive 확인**(find_contact/weather는 production 공존 flat 빌트인, rigged 아님)·value bar 통과(write-tool coverage). 
- **리스크:** 없음 — eval-only, remember_fact 코드 무접촉. ★LESSON(방법론): eval 시나리오 이웃 set이 production 도구 혼합(flat+namespaced)을 반영해야 — 단일 네이밍 컨벤션만 노출하면 가짜 selection 실패를 제조한다(probe로 confound 검증 필수). 다음 후보: 다른 write/uncovered 도구 eval 감사 또는 fresh .muse/runs 신호. pnpm check red는 동시 루프 미커밋 noise.


## fire 115 · 2026-06-14 · skill v1.14.0 · 0a830d10
meta: value-class=hardening(LIVE over-fire fix on destructive tool + write CRUD eval coverage) · pkg=@muse/mcp(+scripts eval) · kind=remove_contact 관계-statement eager-invocation fix · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 999 유지(eval 케이스) · fabrication 0 유지 · eval:tools +1 시나리오(contacts-crud 8 케이스 STABLE 3/3, "안 친해" 0/3→PASS)
- **무엇:** fire 114 eval-coverage 감사 계속 → add_contact/remove_contact(둘 다 risk:write)가 expectTool 커버리지 전무 발견(find_contact만 커버). buildContactsCrudScenario 빌드(contacts 스텁에 real "Bob" 두어 trap 강화) → **라이브 over-fire 발굴**: remove_contact가 "이제 Bob이랑 안 친해"(I'm not friends with Bob)에 **0/3 eager 삭제 제안**(destructive!). 원인: 구 description "delete / **forget** a contact"의 "forget"이 "안 친해"(관계 distancing)에 매칭. fix: tool-calling.md rule 4대로 "EXPLICIT delete command에만, 관계/감정 statement엔 NOT use(삭제는 비가역)" 명시.
- **왜:** destructive write 도구의 over-fire는 가장 비싼 false-positive(approval gate가 막지만 잘못된 삭제 제안+오독). agent-testing.md eager-invocation 함정. coverage-guard 아닌 **라이브 RED→GREEN**("안 친해" 0/3→PASS 3/3, explicit "delete Bob"은 3/3 유지=over-block 0). ★METHODOLOGY WIN: fire 114에서 시작한 eval-coverage 감사(blocker 후보 b)가 단순 커버리지 추가가 아니라 **진짜 라이브 버그를 발굴** — uncovered write 도구에 IrrelAcc 시나리오를 지으면 실 over-fire가 드러난다.
- **리뷰지점:** contacts-tool.ts(remove_contact description 2줄, 핸들러 resolveContact/ambiguous/no-collateral 불변) + eval(buildContactsCrudScenario, representative 혼합 이웃 fire-114 레슨, real Bob target, noTool=0-call tripwire). 1871 green·내 파일 lint clean. ④b Opus judge PASS 8/8 — crux #1(라이브 RED→GREEN, 구 desc "forget" steer 검증)·#2(over-block 없음, explicit delete 3/3 decisive)·시나리오 non-rigged·IrrelAcc 케이스 genuinely 비-command(싸움은 삭제 안 함, 비가역) 무자비 검증.
- **리스크:** 없음 — description string만 변경(핸들러·불변식 불변), explicit delete 무회귀 증명. 다음 후보: 남은 uncovered write 도구(email_send/reply/forward 등 outbound — 단 provider 셋업 복잡)·다른 eval 감사. pnpm check red는 동시 루프 미커밋 noise.


## fire 116 · 2026-06-14 · skill v1.14.0 · 4a31f4aa
meta: value-class=hardening(outbound eval coverage, NOT a live bug) · pkg=scripts(eval) · kind=email_send/reply outbound IrrelAcc+selection 커버리지 · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 999 유지(eval 케이스) · fabrication 0 유지 · eval:tools +1 시나리오(email-send 6 케이스 STABLE 3/3)
- **무엇:** eval-coverage 감사 계속(가장 위험한 미커버 도구) → email_send/reply/forward(전부 risk:execute, **제3자 outbound**)가 eval 커버리지 전무 발견. buildEmailSendScenario(full email suite send/reply+recent/search/read+find_contact 노출=production 대표) — selection 2 + confusability 1 + IrrelAcc 3(make-or-break "Bob한테 이메일 보낼까 말까 고민 중이야"=deliberation→NO tool, outbound-safety tripwire). 전 6 STABLE 3/3.
- **왜:** outbound(제3자 메시지)은 최고 blast-radius — over-fire=원치 않는 draft가 타인에게. agent-testing.md outbound IrrelAcc 필수. **probe 결과 명확한 버그 없음**(fire 115 remove_contact와 달리 outbound는 안전 — deliberation/complaint/musing에 abstain). coverage value(zero→커버). ★probe 과정 confound 2건 규명·정직 처리: (1) minimal 이웃 set이 가짜 실패 제조(모델이 find_contact 먼저/read 도구 환각) → full suite 노출로 수정(fire-114 레슨); (2) positive 실패는 합당한 multi-step(recipient resolve-first)이라 strict first-call 단언 부적절 → known-contact(Bob in stub)로 SEND 의도만 핀. dropped 케이스(email_reply multi-step·"받았어"→harmless search_email)는 진짜 confound(버그 은폐 아님, git -S로 judge 확인).
- **리뷰지점:** eval-tool-selection.mjs만(email 도구 코드 무변경). 6 STABLE 3/3. ④b Opus judge PASS 8/8 — 정직성·real gap(outbound zero-coverage)·IrrelAcc tripwire(deliberation→NO tool)·**representative set 공정(full suite, Bob-in-contacts는 disclosed 공정 단순화, case-drop으로 버그 은폐 없음 git -S 확인) decisive**·value bar·KIND-monotony 허용(114 memory/115 contacts/116 email = 다른 클래스, escalating 위험축, 115는 실 버그).
- **리스크:** 없음 — eval-only, email 도구 무접촉. ★CAUTION: 3연속 eval-coverage 슬라이스(114/115/116) — 다음 fire는 KIND 다양화(다른 value-class/seam). 남은 eval-coverage 후보 적음(home_entities/home_state read·email read 도구). pnpm check red는 동시 루프 미커밋 noise.


## fire 117 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=high-value veins tapped(direct-bug + write/execute eval-coverage 완료) · verdict=NO-SLICE · firesSinceDrill=7
ratchet: testFiles 999 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close)
- **무엇:** 슬라이스 없음(honest-close). 저널 CAUTION(114/115/116 3연속 eval-coverage → KIND 다양화)을 지키려 다른 KIND를 찾음: (a) email 핸들러 correctness 검토 → outbound-safety 불변식(ambiguous/unknown recipient→refused, reply id 검증) 잘 갖춤, clean. (b) on_this_day Feb-29 date projection → Mar-1 convention(overflow), fire-106 contacts(Feb-28)와 convention 차이일 뿐 **버그 아닌 defensible 선택**(scout도 동일 결론). (c) 고위험 eval-coverage 후보 점검 → 모든 write/execute 도구(remember_fact 114·contacts CRUD 115·email outbound 116) 커버 완료; 남은 미커버는 READ 도구뿐(read_email/email_recent/home_entities/home_state — over-fire harm 낮음).
- **왜:** 직접 correctness/security bug vein은 source-고갈(fire 113), 고가치 eval-coverage(write/execute)는 114-116으로 완료, EXPANSION은 scout가 genuine 갭 없음 확인, hardening 테마엔 paper-grounded escalation 부적합(룰: 이 테마선 security/correctness 자체가 가치). KIND-다양화 제약이 유일 생산 vein(eval-coverage)을 막고 나머지가 마름 → 가짜 marginal 슬라이스(read-tool coverage·cosmetic keyword fix)는 ④b judge가 FAIL시킴(JUDGE-DRILL 입증). 정직 종료 > fabrication.
- **리뷰지점:** 코드 변경 0. 검토함: email-send.ts(resolveContact ambiguous/unknown fail-close)·on-this-day-tool.ts(selectOnThisDay 3-projection minGap, Feb-29 Mar-1 defensible)·eval 커버리지 매트릭스(고위험 도구 전부 covered). 미수행: read-tool eval coverage(저가치)·email_send "reply" 키워드 정리(relevance-filter 행동테스트 필요, marginal). 
- **리스크:** 없음 — 코드 무변경, floor·불변식 무접촉. ★SIGNAL: tool-hardening 테마의 고가치 vein(직접 correctness/보안 버그 + 고위험 도구 eval-coverage)이 17 fire에 걸쳐 genuine 성숙. 다음-fire 후보: (a) 저가치 read-tool eval coverage(monotony 감수), (b) 진안-blocked 레버(MCP-risk posture·undo/veto·email-handle grounding), (c) 진안에게 테마 확장/pivot 제안. firesSinceDrill=7(no-slice도 카운트).


## fire 118 · 2026-06-14 · skill v1.14.0 · bfa27bc0
meta: value-class=hardening(outbound over-fire guard, NOT a live bug) · pkg=scripts(eval) · kind=mac_message_send iMessage 채널 deliberation IrrelAcc 추가 · verdict=PASS(qualified) · firesSinceDrill=8
ratchet: testFiles 1000 유지(eval 케이스) · fabrication 0 유지 · eval:tools macos-actuators +2 IrrelAcc(STABLE 3/3)
- **무엇:** fire 117 honest-close(연속 회피) 후 KIND 다양화 시도하다 mac 도구 검토 → mac_message_send(OUTBOUND iMessage 제3자)가 positive 커버되나 **over-fire IrrelAcc 없음**(기존 2 expectNoTool은 전부 mac_shortcut_run용; commit msg "3"은 사소 오기→실제 2). probe로 deliberation over-fire 확인: "Bob한테 문자 보낼까 말까 고민 중이야"→**NO tool PASS 3/3**(email_send처럼 안전). media-comment("플레이리스트 잘 만들었다")→NO mac_media_control PASS. 둘 추가.
- **왜:** outbound iMessage는 email과 별개 채널·동일 최고위험 클래스(outbound-safety.md) — deliberation 가드가 mandated(fire-116 email 가드와 평행). probe 결과 **버그 없음**(mac_message_send abstain). dropped "받았어"→harmless knowledge_search(read, defensible, fire 116 email "받았어"와 동일 처리). 117 연속 honest-close 회피(stall 방지).
- **리뷰지점:** eval-tool-selection.mjs만(mac 도구 코드 무변경). macos-actuators 44 케이스 100%, 신규 2 STABLE 3/3. ④b Opus judge PASS(qualified) — 정직성(scripts-only, 사소 count 오기 cosmetic)·real gap(iMessage outbound 무가드)·tripwire(deliberation→drafting 방지)·distinct 채널 decisive. judge 명시: **media-comment는 filler·high-value eval-coverage seam NEAR-TAPPED·thin end of acceptable**.
- **리스크:** 없음 — eval-only, mac 도구 무접촉. ★STRONG SIGNAL: high-value eval-coverage seam near-tapped(judge). 직접-bug vein 고갈(113·117) + write/execute/outbound 도구 IrrelAcc 전부 커버(114-118). 다음 fire는 진짜 다른 KIND/value-class 필요 — 저가치 read-coverage·진안-blocked 레버·테마 pivot. ★firesSinceDrill=8 → fire 120에 JUDGE-DRILL 트리거(≥10) 임박. pnpm check red는 동시 루프 미커밋 noise.


## fire 119 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=theme high-value veins genuinely tapped(2nd honest-close in 3 fires) · verdict=NO-SLICE · firesSinceDrill=9
ratchet: testFiles 1001 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close)
- **무엇:** 슬라이스 없음(honest-close). fire 118 judge "seam near-tapped" 신호 후 KIND 다양화로 진짜 가치 탐색: (a) email_send keywords "reply" 오염(별도 email_reply 존재) → 제거 검토했으나 `isToolRelevantToPrompt`가 keyword 하나라도 매칭하면 relevant이고 "reply to email"은 "email" 토큰이 email_send "email" 키워드와 매칭 → "reply" 제거해도 행동 무변경 = **cosmetic**, judge FAIL 예정. (b) read-tool over-fire(search_email/knowledge_search on "받았어") → harmless read·defensible(fire 116/118 동일 판정). (c) EXPANSION → scout(112·113) genuine 갭 없음. (d) 진안-blocked 레버 → 미actionable.
- **왜:** EXHAUSTION 규칙: 2연속 clean scout(112·113) 후 3번째 scout 금지 — 다른 value-class로 전환했고(eval-coverage 114-118 생산적이었으나 write/execute/outbound 전부 커버 완료=near-tapped; keyword=cosmetic) 전부 마름. hardening 테마엔 paper-grounded escalation 부적합(룰). 가짜/cosmetic 슬라이스는 JUDGE-DRILL이 입증한 대로 ④b judge가 FAIL → 정직 종료 > fabrication. 2nd honest-close in 3 fires(117·119)는 테마가 genuine 성숙했다는 강한 신호.
- **리뷰지점:** 코드 변경 0. 검토: isToolRelevantToPrompt(keyword OR 매칭, "reply" 제거 cosmetic 확인)·read-tool over-fire(defensible)·EXPANSION(scout 갭 없음). 미수행: 저가치 read-coverage(monotony)·진안-blocked 레버. 
- **리스크:** 없음 — 코드 무변경, floor·불변식 무접촉. ★SIGNAL(진안 결정 필요): tool-hardening 18 fire 생산 후 고가치 vein genuine 고갈(직접 correctness/보안 버그 + write/execute/outbound 도구 IrrelAcc + meta-tool 영역 전부 hardened). 다음: 진안이 (a) 테마 확장(다른 패키지/표면), (b) 다른 테마 pivot, (c) 저가치 유지보수 수용 중 결정. ★firesSinceDrill=9 → fire 120 JUDGE-DRILL 트리거(≥10) 확정. pnpm check red는 동시 루프 미커밋 noise.


## fire 120 · 2026-06-14 · skill v1.14.0 · 891eae1a (JUDGE-DRILL)
meta: value-class=hardening(outbound eval coverage, NOT a live bug) · pkg=scripts(eval) · kind=JUDGE-DRILL(cosmetic+선언-only FAIL 확인)+muse.messaging.send over-fire 가드 · verdict=PASS · firesSinceDrill=0(드릴 완료, 리셋)
ratchet: testFiles 1002 유지(eval 케이스) · fabrication 0 유지 · eval:tools +1 시나리오(messaging-send 5 케이스 STABLE 3/3)
- **무엇:** (A) JUDGE-DRILL(firesSinceDrill≥10 트리거) — 고의 cosmetic 슬라이스 주입: email_send keywords에서 "reply" 제거(fire 119서 cosmetic 판명 — isToolRelevantToPrompt가 "email" 매칭으로 행동 무변경) + declaration-only 테스트(`keywords.not.toContain("reply")`, 정적 단언). build+test green(결정적 게이트 통과)에도 ④b Opus judge **VERDICT: FAIL** — **양쪽 eval arm 직접 실행**해 byte-identical selection(6/6 동일) 입증·declaration-only·no RED→GREEN. → 롤백(git checkout, "reply" 복원·테스트 제거). (B) 진짜 fix — muse.messaging.send(risk:write outbound 채팅 DM, loopback-tools.ts:142 wired) eval 커버 전무 = 3번째 outbound 채널. buildMessagingSendScenario(채널/handle destination 2 selection + find_contact 1 confusability + deliberation/complaint 2 IrrelAcc).
- **왜:** 드릴 — maker≠judge 보상통제 재검증. judge가 build/test 통과시킨 cosmetic+선언-only를 잡음(자동 게이트 못 잡는 미배달). 실수정 — outbound 3채널(email 116/iMessage 118/chat DM 120) over-fire 가드 **trilogy 완성**. probe 결과 messaging.send도 deliberation에 abstain(안전, 다른 둘과 일관). KO positive 0/3은 "Bob" 핸들 resolve로 find_contact 먼저(fire-116 multi-step confound) → 채널 destination(#공지 Discord)으로 수정해 SEND 의도만 핀.
- **리뷰지점:** (드릴) email_send keyword 제거→judge FAIL→롤백 clean(email-tool 무변경 확인). (실수정) eval-tool-selection.mjs만(messaging 도구 코드 무변경). 5 STABLE 3/3. ④b Opus judge 실수정 PASS 8/8 — honest·real gap(wired loopback-tools.ts)·tripwire(deliberation→DM draft 방지)·**representative(real sibling mac_message_send + find_contact, 채널-switch 정직한 confound·bug-hiding 아님) decisive**·trilogy 완성 value.
- **리스크:** 없음 — eval-only, messaging 도구 무접촉. ★드릴 교훈: cosmetic config tweak + static-value test = 미배달; judge가 양쪽 arm 비교로 no-behavioral-delta 입증(robust). outbound 3채널 over-fire 가드 완성. high-value eval-coverage seam 이제 사실상 tapped(write/execute/outbound 전부). pnpm check red는 동시 루프 미커밋 noise.


## fire 121 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=wiring audit clean + theme personal-store domain saturated(21 fires) · verdict=NO-SLICE · firesSinceDrill=1
ratchet: testFiles 1003 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close, wiring 감사만)
- **무엇:** 슬라이스 없음(honest-close). KIND 다양화로 WIRING value-class 감사: (a) autoconfigure 도구 팩토리 5개(week_agenda/today_brief/day_recap/find_items/overdue_contacts) 전부 index.ts assembly 배선 확인 — inert 없음. (b) email send/reply/forward + mac_message_send(outbound) → actuator-tools.ts:341-408 배선, 각 도구가 approvalGate(emailGate/macMessageGate) + actionLogFile 제대로 받음(fail-close, outbound-safety.md 준수). wiring correct, inert 도구 0.
- **왜:** 고가치 vein 전수 고갈 재확인 — 직접 correctness/security bug(113·117·121), eval-coverage(write/execute/outbound trilogy 완성 114-120), wiring(inert 0·gate 정확), EXPANSION(scout 112·113 non-confusable 갭 없음). 진안-blocked 레버(MCP-risk posture·undo/veto·email-handle grounding)만 남음. hardening 테마엔 paper-grounded escalation 부적합. 가짜/cosmetic/저가치-thin은 ④b judge FAIL(fire 120 드릴이 cosmetic+선언-only를 정확히 FAIL시켜 입증).
- **리뷰지점:** 코드 변경 0. 감사: autoconfigure 팩토리 vs index.ts assembly(전수 배선)·actuator-tools.ts outbound 배선(gate+actionLog 정확). 미수행: 저가치 read-tool IrrelAcc(harmless·judge near-tap 경고)·진안-blocked 레버. 
- **리스크:** 없음 — 코드 무변경, floor·불변식 무접촉. ★DECISION-REQUIRED(진안): tool-hardening 테마가 **personal-store 도메인을 21 fire에 걸쳐 saturate**. ratchet이 막으려는 "EXPANSION 0 지속"은 도메인 포화의 결과(find_items 107 이후 non-confusable EXPANSION 갭 genuine 없음). 더 많은 EXPANSION/가치를 풀려면 진안이 (a) 테마 확장(새 도구 도메인/통합/표면), (b) 다른 테마 pivot, (c) 진안-blocked 레버 unblock, (d) 저가치 유지보수 수용 중 결정. firesSinceDrill=1. pnpm check red는 동시 루프 미커밋 noise.


## fire 122 · 2026-06-14 · skill v1.14.0 · (no-slice)
meta: value-class=exhaustion-report · pkg=none · kind=utility-tool families(time/math) handler+security verified clean · verdict=NO-SLICE · firesSinceDrill=2
ratchet: testFiles 1004 유지 · fabrication 0 유지 · 코드 변경 0(EXHAUSTION honest-close, 핸들러 감사만)
- **무엇:** 슬라이스 없음(honest-close). fresh KIND으로 미심층검토 **유틸-tool family handler correctness/security** 감사: (a) next_weekday_date → WEEKDAY_NAMES[sunday=0..saturday=6]가 getUTCDay() 정렬과 일치 + delta 불변식(target==current→+7, 항상 strictly future) 정확. (b) time_add → epoch-ms 산술(DST-agnostic, 24h-period defensible). (c) cron_for_datetime → UTC 컴포넌트 cron 생성 + 스케줄러 defaultTimezone="UTC"(scheduler-helpers.ts:37)로 일관(UTC-throughout, KST 등 정확). (d) math_eval → MATH_EXPRESSION regex 화이트리스트 + 256자 캡 + 커스텀 evaluateArithmetic 파서(eval 미사용) = injection 안전. 전부 clean, 코드 변경 0.
- **왜:** 직접 correctness/security bug vein이 personal-store(113·117·121) 넘어 **유틸-tool family(time/date/math)까지 genuine 고갈** 확인 — date-arithmetic은 실 버그 발견 family였으나(Feb-29·calendar fromIso) 유틸 도구는 정확. eval-coverage tapped·wiring dry·EXPANSION 갭 없음. 가짜/cosmetic/저가치-thin은 ④b judge FAIL(fire 120 드릴 입증). 4번째 honest-close = 테마 saturation의 누적 증거.
- **리뷰지점:** 코드 변경 0. 감사: muse-tools-time.ts(next_weekday delta·time_add·cron UTC)·muse-tools-data.ts(math_eval 화이트리스트)·scheduler-helpers.ts(defaultTimezone UTC). 미수행: 저가치 read-tool IrrelAcc·진안-blocked 레버·cron_for_datetime DST-aware TZ 옵션(enhancement, 버그 아님·UTC 설계 documented). 
- **리스크:** 없음 — 코드 무변경, floor·불변식 무접촉. ★DECISION-REQUIRED 지속(진안): tool-hardening이 personal-store + 유틸-tool 도메인 모두 22 fire에 걸쳐 saturate. 누적 honest-close(117·119·121·122). 진안 redirect(테마 확장/pivot/레버 unblock/저가치 수용) 대기. firesSinceDrill=2. pnpm check red는 동시 루프 미커밋 noise.


## fire 123 · 2026-06-14 · skill v1.14.0 · ac540459
meta: value-class=new-capability(EXPANSION) · pkg=@muse/tools(+scripts eval) · kind=unit_convert 결정적 물리단위 변환 도구 · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1004→1005(+muse-tools-units.test) · fabrication 0 유지 · eval:tools +1 시나리오(unit-convert 6 케이스 STABLE 3/3)
- **무엇:** 4회 honest-close(117·119·121·122)로 personal-store + 유틸 도메인 saturation 확인 후, 룰의 "value-class 올려라" + ratchet "EXPANSION 0 지속 방지"에 따라 genuine EXPANSION 빌드: `unit_convert`(zero-IO 유틸 family, math_eval/slugify 동질). convertUnit(length/mass/volume 정적 factor + temperature offset C/F/K), cross-category/unknown→error(wrong-guess 없음). createMuseTools 배선(autoconfigure index.ts:542 default-on).
- **왜:** find_items(107) 이후 16 fire간 EXPANSION 0 — ratchet이 막으려는 실패. personal-store 갭은 saturated이나 **유틸 도메인엔 genuine 비-confusable 갭 존재**(unit conversion). Muse grounding edge 부합: 12B의 근사 factor("≈8 km")가 아닌 EXACT("5 mi = 8.04672 km"). 핵심 위험(모델 자답)은 eval로 반증 — 모델이 도구 SELECT 3/3(산술은 math_eval 쓰는 행동과 일관).
- **리뷰지점:** muse-tools-units.ts(convertUnit + 도구) + units.test(변환/throw 정확) + muse-tools.ts(배선) + tools.test(inventory 17→18) + eval(buildUnitConvertScenario). 207 green·내 파일 lint clean·**eval unit-convert STABLE 3/3 ×6**(3 positive selection + math_eval/web-search 비교차 + "5km 뛰었어" IrrelAcc). ④b Opus judge PASS 8/8 — crux #2(변환 수학: 모든 factor 독립 재유도 — 1kg→2.20462lb·12in→30.48cm·212°F→373.15K, lying factor 없음)·#4(wired)·#5(model selects 3/3 자답 안 함) 무자비 검증.
- **리스크:** 없음 — 순수 read 도구(no mutation), 잘못된 factor=grounded lie 위험을 judge가 전수 검증, cross-category/unknown→error. EXPANSION drought 종료. 다음: 유틸 도메인 추가 EXPANSION 갭(있으면) 또는 진안 방향. pnpm check red는 동시 루프 미커밋 noise.


## fire 124 · 2026-06-14 · skill v1.14.0 · 3b641b27
meta: value-class=hardening(completeness extension of fire-123 EXPANSION) · pkg=@muse/tools(+scripts eval) · kind=unit_convert에 SPEED+TIME-duration 카테고리 추가 · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1005 유지(units.test +2 케이스) · fabrication 0 유지 · eval:tools unit-convert +2 케이스(STABLE 3/3 ×8)
- **무엇:** 다음 유틸 EXPANSION 후보 점검 → 타임존은 **이미 covered**(time_now가 timezone 인자 지원 + world_time 도구) = redundant, 안 지음. 대신 fire-123 unit_convert가 length/mass/volume/temperature만 — 흔한 SPEED("100 km/h는 몇 mph", 해외 운전)·TIME duration("90분은 몇 시간")에 error. SPEED(m/s base) + TIME(second base) 카테고리 추가(정확 factor + alias). JSDoc 주석도 6 카테고리로 정정(judge nit, comment-only 별도 커밋 9dd87e47).
- **왜:** unit_convert 완성도 — 그 두 변환은 실 유저 쿼리이고 사전엔 {error}였음(judge가 pre-commit CATEGORIES=[LENGTH,MASS,VOLUME]로 확인). 12B는 0.621 km/h↔mph factor 반올림 → 결정적 도구가 grounding. TIME-duration이 time_diff(2 timestamp)와 혼동 위험 있었으나 eval로 unit_convert 선택 확인(time_diff/time_add는 timestamp 연산, pure duration-unit 변환 아님).
- **리뷰지점:** muse-tools-units.ts(SPEED/TIME map + alias + description) + units.test(+2) + eval(+2 케이스). 209 green·내 파일 lint clean·**eval unit-convert STABLE 3/3 ×8**(speed/time 포함 전 카테고리 selection + math_eval/web 비교차 + IrrelAcc). ④b Opus judge PASS 8/8 — crux #2(factor 전수 독립 검증: 100km/h→62.1371mph·90min→1.5h·1week→7day, lying 없음)·#3(cross-category leak 없음: km/h→km/kg·min→m throws, m=metre/min=minute 별 키)·#5(model selects 3/3 time-tool 혼동 없음) 무자비 검증.
- **리스크:** 없음 — 순수 read 도구 확장(기존 카테고리 무회귀), factor judge 전수 검증, cross-category→error. DATA(byte) 카테고리는 1000/1024 ambiguity로 의도적 제외. 다음: 추가 유틸 갭(area? 단 저빈도) 또는 진안 방향. pnpm check red는 동시 루프 미커밋 noise.


## fire 125 · 2026-06-14 · skill v1.14.0 · 5212008f
meta: value-class=hardening(area+평 카테고리, user-specific grounding) · pkg=@muse/tools(+scripts eval) · kind=unit_convert에 AREA + 한국 평 추가 · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1006 유지(units.test +1 케이스) · fabrication 0 유지 · eval:tools unit-convert +1 케이스(STABLE 3/3 ×9)
- **무엇:** unit_convert에 AREA 카테고리(m2/km2/cm2/mm2/ha/ft2/in2/yd2/acre/**평**) 추가. 평(平)은 진안(Korean 유저)의 일상 면적 단위("30평 아파트는 몇 ㎡?")인데 12B가 1평=400/121=3.305785㎡ factor를 부정확 recall → 결정적 도구가 grounding. 정확 factor(평=400/121, 반올림 아님) + alias(제곱미터/sqm/sqft/pyeong 등). description+JSDoc 갱신.
- **왜:** 3연속 unit fire(123 EXPANSION·124 speed/time·125 area)지만 각각 distinct 카테고리·distinct 가치(outbound trilogy 유사) — 평은 generic padding 아닌 **user-specific grounding 승리**(진안이 실제 쓰는 단위, 모델 unreliable). @muse/tools 2/8(ratchet 무관). 핵심 위험(모델이 평을 단위로 인식?)은 eval로 반증 — "30평은 몇 제곱미터" → unit_convert 3/3.
- **리뷰지점:** muse-tools-units.ts(AREA map 평=400/121 + alias + description) + units.test(+1 area/평 round-trip) + eval(+1 평 케이스). 210 green·내 파일 lint clean·**eval unit-convert STABLE 3/3 ×9**(평 포함 전 카테고리 + 비교차 + IrrelAcc). ④b Opus judge PASS 8/8 — crux #1(**평 factor 정확히 400/121, full float 3.3057851239669422, 반올림/오류 없음**)·#2(전 area factor 정확)·#3(cross-cat leak 없음: 평→km·m2→m throws, m2≠m 별 키)·#5(model selects 평 3/3) 무자비 검증, "genuine user-specific value, not padding".
- **리스크:** 없음 — 순수 read 확장(기존 카테고리 무회귀), 평 factor judge full-float 검증(grounded lie 회피), cross-cat→error. unit_convert 이제 7 카테고리(length/mass/volume/temp/speed/time/area). 다음: unit 작업 충분 — 다음 fire는 다른 KIND/value-class 또는 진안 방향. pnpm check red는 동시 루프 미커밋 noise.


## fire 126 · 2026-06-14 · skill v1.14.0 · 4fad0320
meta: value-class=new-capability(EXPANSION) · pkg=@muse/tools(+scripts eval) · kind=lunar_date 한국 음력 calendar 도구(solar→lunar) · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1006→1007(+muse-tools-lunar.test) · fabrication 0 유지 · eval:tools +1 시나리오(lunar-date 6 케이스 STABLE 3/3)
- **무엇:** fire-125 노트(unit 충분, 다른 KIND)대로 새 도메인 EXPANSION: `lunar_date`(solar→한국 음력). Node Intl의 ICU `dangi` 캘린더가 authority → custom 알고리즘 불필요(grounded-lie 위험 0). Asia/Seoul tz(음력 day boundary), 윤달("6bis"→leap) 표기. now 주입(time_now 패턴). lunar→solar(생일용)는 backlog ◦.
- **왜:** 진안(Korean)은 음력 생일/명절(설날·추석)을 쓰는데 12B는 음력 계산 **불가**(추측) — 결정적 도구가 유일한 grounded 답. 평(125)과 같은 user-specific grounding 승리, 단 fresh KIND(calendar≠unit, 3연속 unit 후 다양화). Intl 검증으로 정확성 확보(custom 코드 없음).
- **리뷰지점:** muse-tools-lunar.ts(solarToLunar Intl dangi + 도구) + lunar.test(설날/추석/윤달/KST boundary) + muse-tools.ts(배선) + tools.test(inventory 18→19) + eval(buildLunarScenario). 218 green·내 파일 lint clean·**eval lunar-date STABLE 3/3 ×6**(음력 selection 3 + 양력→time_now carve 2 + 설날 greeting IrrelAcc). ④b Opus judge PASS 9/9 — crux #1(음력 7날짜 전부 exact: 설날/추석 2025+2026·단오·윤6월, lying 없음)·#3(KST boundary 정확: 2026-02-16 23:00KST→음12/29 not 1/1)·#6(model selects 3/3, time_now carve) 무자비 검증.
- **리스크:** 없음 — 순수 read 도구, ICU가 변환 authority(no grounded lie), bad input→error. EXPANSION 2개 연속(unit_convert·lunar_date)으로 ratchet "EXPANSION 0" 우려 완전 해소. 다음: lunar→solar follow-up 또는 진안 방향. pnpm check red는 동시 루프 미커밋 noise.


## fire 127 · 2026-06-14 · skill v1.14.0 · 55d34fa1
meta: value-class=new-capability(EXPANSION) · pkg=@muse/tools(+scripts eval) · kind=lunar_to_solar 음력→양력(lunar_date의 역방향) · verdict=PASS(judge가 1차 FAIL → 수정 후 재판정 PASS) · firesSinceDrill=7
ratchet: testFiles 1007→1008(muse-tools-lunar.test +month-12 leap 케이스로 227) · fabrication 0 유지 · eval:tools +1 시나리오(lunar-to-solar 6 케이스 STABLE 3/3)
- **무엇:** fire-126 follow-up ◦ 구현: `lunar_to_solar`(음력→양력). 진안의 #1 음력 쿼리 "음력 생일이 올해 양력으로 며칠?". solar Jan 1부터 전진 탐색해 각 날의 ICU dangi 값을 target 음력 M/D+윤달과 매칭 → 정확한 양력 날짜 또는 없는 날짜엔 정직한 error. year 생략 시 now()의 현재 양력연도. createMuseTools 배선(20 도구). 양방향 lunar 쌍 완성.
- **왜:** lunar_date(126)는 solar→lunar뿐 — 실제로 유저가 묻는 건 역방향(음력 생일→올해 양력). 결정적(ICU authority, custom 알고리즘 무, grounded-lie 위험 0). 5연속 @muse/tools·2번째 lunar이나 ratchet 무관(value-class=EXPANSION/new-capability, micro-fix 아님) — judge도 "genuine bidirectional completion, not padding" 확인.
- **리뷰지점:** ④b Opus judge가 1차 슬라이스를 **FAIL**(crux #3): 400일 bound가 윤년 음 12/29·12/30(실재, →2027-02-05/06)을 false "no such date"로 → grounded lie. 독립 검증으로 확인(354개 실제 음력 날짜가 offset≥400). **수정**: bound 400→460, **36,525일 round-trip 증명**(2000–2100 전 음력 날짜 0 miss, worst offset 414) + RED 테스트(음2026 12/30→2027-02-06). 재판정 PASS(judge 자체 36,890일 round-trip 0 miss, no regression, no perf 우려—first-match early return). 226→227 green·내 파일 lint clean·eval STABLE 3/3 ×6.
- **리스크:** 없음(수정 후) — 순수 read, ICU 변환 authority, 없는 날짜→error, bound는 round-trip로 전 범위 증명. LESSON: 탐색-기반 역변환의 bound는 "직관상 1년"이 아니라 **worst-case offset을 데이터로 증명**해야(윤년 끝달이 다음다음 해 2월로 새어나감); judge가 grounding-floor 위반을 정확히 잡아냄(maker≠judge 가치 입증). 다음: lunar 충분 — 다른 KIND/value-class 또는 진안 방향. pnpm check red는 동시 루프 미커밋 noise.


## fire 128 · 2026-06-14 · skill v1.14.0 · f55cbc4f
meta: value-class=correctness-bug(durable-memory write 한글 키 드롭) · pkg=@muse/mcp · kind=remember_fact Unicode 키 보존(ASCII slug→normalizeMemoryKey) · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 1009→1009(기존 2 test 파일에 +3 케이스) · fabrication 0 유지 · eval 무변동(execute-only, 선택/스키마 무변경) · 패키지 다양화 @muse/tools 5연속→@muse/mcp
- **무엇:** `remember_fact`(risk:write 영속 메모리 actuator)가 키를 ASCII-only `[^a-z0-9_]`로 slug → 한글 키("취미")가 ""→error/무기록, "내 취미"→쓰레기 "_" 기록. 스토어 자신의 canonical `normalizeMemoryKey`(@muse/memory, Unicode 보존·파일스토어와 동일·idempotent)로 위임 + `/[\p{L}\p{N}]/u` 가드 선행("!!!"/"___"는 여전히 거부 — normalizeMemoryKey가 all-punct를 raw로 fallback하므로 가드 필수). 라이브 배선(autoconfigure:723, 실 userMemoryStore).
- **왜:** KO-default 로컬 모델이 자연 대화에서 내뱉는 키는 한글인데 영속-메모리 쓰기 경로가 그걸 통째로 드롭 → "Tell it everything" 핵심 약속의 조용한 파손(grounding/memory floor가 잡아야 할 correctness rot). VALUE-CLASS RATCHET 압력 해소: @muse/tools 5연속(123-127) → @muse/mcp로 패키지·KIND 다양화. 보안·correctness 자체가 가치(hardening 테마).
- **리뷰지점:** RED 확인(취미→[], 내 취미→"_" garbage) → fix → 1874 mcp green. ④b Opus judge PASS 7/7 — crux #2(기존 assertion "favoritedrink"→"favorite_drink" 변경이 weaken인가?를 normalizeMemoryKey("Favorite-Drink!")=="favorite_drink" 독립 계산으로 검증: 스토어와 일치하는 MORE-correct, 약화 아님)·#3(가드가 dead-code 아님: normalizeMemoryKey("!!!")=="!!!" non-empty라 가드 필수)·#5(idempotent라 파일스토어 재정규화 무드리프트) 무자비 검증. lint clean·byte-hygiene clean. pnpm check의 @muse/db SIGABRT는 동시루프 메모리압 OOM(고립 재실행 395ms green) — 내 변경 무관.
- **리스크:** 없음 — execute-only(선택/description/스키마 무변경 → eval:tools 골든 불요), 순수 키 정규화 위임, 무효입력 무기록 불변식 유지, 의존성(@muse/memory)은 이미 선언+import 중(무순환). 다음: `/remember` CLI(parseRememberArg)도 동일 버그 → backlog ◦ 기록(follow-up). 다른 KIND/패키지 계속 또는 진안 방향.
