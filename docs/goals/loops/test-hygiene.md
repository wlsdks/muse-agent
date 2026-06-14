# Loop journal — test-hygiene

> Per-loop append-only journal (loop-creator). One entry per fire, newest at bottom.
> Schema (going-forward entries):
>
>     ## fire N · YYYY-MM-DD · skill vX.Y.Z · <commit-sha>
>     meta: kind=prune|add · pkg=@muse/… · verdict=PASS|FAIL · firesSinceDrill=N
>     ratchet: testFiles before→after · netCoverage ± · fabrication 0
>     - 무엇 …  - 왜 …  - 어떻게-증명(mutation) …  - 리스크 …
>
> 테마: 테스트 스위트 위생 — 저가치/중복 테스트 제거(PRUNE) + 누락 고가치 테스트 추가(ADD).
> 모든 테스트의 가치는 MUTATION-FIRST로 증명한다(ADD는 대상 코드 변형 시 FAIL해야, PRUNE은 같은 행동을
> 잡는 다른 named 테스트를 cite). Why per-loop (not shared digest): 동시 루프가 공유 append 파일에서
> 충돌·오염되므로 disjoint path를 쓴다. Worktree: /tmp/muse-test-hygiene (branch `loop/test-hygiene`).
> Convention: [README](README.md).

## fire 1 · 2026-06-13 · skill v1.14.0 · a0c7be0f
meta: kind=add · pkg=@muse/autoconfigure · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 915→915 (케이스 +1, 파일수 불변) · netCoverage +1 branch · fabrication 0
- **무엇:** `interactionsFromEvents`에 "startsAt이 파싱 불가능한 이벤트는 텍스트가 contact를 언급해도 버려진다" 케이스 추가 (`packages/autoconfigure/test/relationship-tool.test.ts`).
- **왜:** `Number.isFinite(event.ms)` 필터 분기를 **어느 테스트도** 커버하지 않았다(autoconfigure 정식 테스트도, CLI 재-export 테스트 `commands-contacts.test.ts`도 전부 유효한 ISO 날짜만 사용). 잘못된 날짜 이벤트가 `NaN` 타임스탬프로 새면 overdue/cadence 계산이 오염된다.
- **어떻게-증명(MUTATION-FIRST):** 필터 줄을 제거하면 새 테스트가 RED(`[NaN, validMs]` ≠ `[validMs]`), 복원하면 GREEN(파일 5/5). 별개 독립 Opus ④b judge가 mutant 동작을 직접 재추론 + autoconfigure/CLI 양쪽 중복부재 확인 후 **VERDICT: PASS**.
- **리스크:** 슬라이스는 격리 green + judge PASS. 단 full `pnpm check`는 **무관 패키지** `@muse/mcp`의 `playbook-store.test.ts > "weighted eviction"`이 5000ms 타임아웃 경계 flake로 red(부하 시 timeout, 격리 재실행 시 ~3.3s pass) — 본 슬라이스와 무관·pre-existing, backlog에 별도 PRUNE/하드닝 후보로 기록.

## fire 2 · 2026-06-13 · skill v1.14.0 · 32dcf51e
meta: kind=fix(flaky) · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 915→915 (case rewrite, no count change) · netCoverage 0 (동작 보존) · fabrication 0
- **무엇:** fire 1이 발견한 flaky 테스트 수정 — `playbook-store.test.ts > "weighted eviction"`이 `recordPlaybookStrategy`를 **121회 순차 디스크 write**(champion + MAX+20 fillers)로 ~5.1s 걸려 5000ms 경계서 timeout. setup을 **1회 `writePlaybook`(champion + 99 fillers = cap)로 pre-seed → `recordPlaybookStrategy` 1회로 overflow→eviction 트리거**로 재작성. 121 writes → 2 writes, 동일 assertion(length=MAX, champion 생존).
- **왜:** flaky 테스트는 매 full-tree run을 오염시켜(없는 회귀처럼 보임) 무가치보다 해롭다. 이 테스트만 fire-1 baseline부터 부하와 무관하게 ~5s(intrinsic) 걸렸음.
- **어떻게-증명(MUTATION-FIRST):** record 경로 eviction을 `retainPlaybookEntries(...)`→naive `.slice(-MAX)`(blind FIFO)로 변형 시 새 빠른 테스트가 RED(`champion` 나이로 evict, "expected false to be true"), 복원 시 GREEN(파일 33/33, 해당 테스트 5140ms→285ms). 별개 독립 Opus ④b judge가 **recency=배열 index만** 사용함을 확인(pre-seed가 per-append와 동일 경로) + mutant 재현 후 **VERDICT: PASS**.
- **리스크:** 슬라이스 격리 green + judge PASS + 타깃 flake 제거됨. full `pnpm check`는 여전히 red지만 **환경 부하 아티팩트** — 동시 루프 6개(tool-hardening/codebase-quality/cognition/differentiation/이 루프 + agent-core-enhance)가 머신을 포화시켜 **trivial 테스트**(`sanitizeFollowupSummary` 단순 `.replace`, `plan-cache` upsert)가 5000–5021ms로 CPU-starvation timeout. 격리 재실행 시 plan-cache PASS(1.3s); sanitizeFollowupSummary는 격리에서도 머신 포화로 느렸으나 함수는 선형 `.replace`라 perf 버그 아님(부하 확정). 본 슬라이스와 무관·pre-existing. backlog에 "동시-루프 부하 시 5000ms timeout 부류 — 테스트 품질 아닌 환경; vitest testTimeout 상향 후보" 기록.

## fire 3 · 2026-06-13 · skill v1.14.0 · 29dc8bd5
meta: kind=add · pkg=@muse/recall · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 920→920 (케이스 +1, 파일수 불변) · netCoverage +1 branch · fabrication 0 · pnpm check FULL GREEN (부하 여유)
- **무엇:** `formatCoarseAge`(recall/present.ts)의 **`years >= 2` 분기**(`.toFixed(0)` 정수 연도) 커버 추가 (`present.test.ts`). 기존 테스트는 400d(1.1y, `years < 2`→1소수) 한 케이스뿐 — 2년+ 정수-반올림 경로는 미커버였음.
- **왜:** grounding presentation 함수(소스 인용 나이 표기 — 핵심 edge). "2.2y ago"가 아니라 "2y ago"로 읽히는 의도된 정밀도 분기가 검증 없이 회귀 가능했음. 패키지 다양성도 충족(fire1 autoconfigure·fire2 mcp와 다른 recall).
- **어떻게-증명(MUTATION-FIRST):** `years.toFixed(years < 2 ? 1 : 0)`→`toFixed(1)` 변형 시 800d/1100d 테스트 RED(`'2.2y ago'`≠`'2y ago'`), 복원+클린리빌드 후 GREEN(파일 22/22). ※복원 직후 stale-dist로 한 번 빨갰다 — `rm -rf dist && tsc -b` 클린리빌드 후 green 확정([[project_stale_dist_from_loop]]). 별개 독립 Opus ④b judge가 양쪽 assertion이 mutant 잡음 + ≥730d 케이스 부재(진짜 미커버) 재확인 후 **VERDICT: PASS**.
- **리스크:** 없음 수준 — 테스트-only, 소스 무변경, full `pnpm check` 이번엔 **완전 GREEN**(머신 부하 여유, fire2의 부하-timeout 부류 미발생). FIX 슬라이스 중 stale-dist가 mutation 증명을 한 번 오염시킬 수 있다는 교훈(클린리빌드로 확정 필요).

## fire 4 · 2026-06-13 · skill v1.14.0 · cb49e2f9
meta: kind=prune · pkg=@muse/a2a · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 924→919 (−5 의도된 중복 삭제, judge 승인) · netCoverage 0 (2 케이스 twin에 이식) · fabrication 0 · pnpm check FULL GREEN
- **무엇:** 검토(audit)의 ★최상위 항목 — `packages/a2a` **이중 실행** 제거. vitest.config 부재로 `src/*.test.ts`가 `test/*.test.ts` 쌍둥이와 둘 다 돌던 것 중, test/가 **진짜 superset**인 5개(`peer-config·receive-quarantine·signing·council-wire·handler`)의 src/ 사본 삭제. `agent-card`(봉투 DataPart round-trip은 src에만)·`transport`(이름·내용 다름)는 상보적이라 **유지**.
- **왜:** 같은 테스트가 매 run마다 2번 = 순수 낭비 + 리뷰 노이즈. 진안이 핵심으로 든 "의미없는 중복 제거".
- **어떻게-증명(MUTATION-FIRST PRUNE):** 삭제 後 남은 `test/` twin이 행동을 여전히 잡음을 mutation으로 증명 — `verifySignature→true` 시 test/signing RED. ★④b judge가 **2회 FAIL로 진짜 손실을 잡음**: council-wire의 same-length-non-hex catch 분기 + peer-config의 빈-문자열 secretEnv 가드가 twin에 없었음(둘 다 보안 분기, mutation-detectable). → 두 유니크 케이스를 twin에 **이식**(migrate) + 각각 타깃 mutation으로 RED 증명(catch→true, `length>0`→`>=0`). 3차 judge가 전수 재확인 후 **VERDICT: PASS**.
- **리스크:** 소스(비-test) 무변경, full `pnpm check` GREEN. stale-dist가 또 한 번 full-check를 오염(mv 복원→mtime 역전→`tsc -b` 리빌드 스킵) → `rm -rf dist+tsbuildinfo` 클린리빌드로 확정. LESSON: a2a/tools/model의 src+test 이중구조는 vitest.config로 근본 해결 가능하나(별 슬라이스), 우선 명백한 중복부터 안전 제거. PRUNE은 "더 많은 케이스=superset"이 **거짓일 수 있음**(유니크 보안 케이스 존재) — 케이스 단위 대조 필수, judge가 이를 강제.

## fire 5 · 2026-06-13 · skill v1.14.0 · 7ee18256
meta: kind=add · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 927→927 (케이스 +5, 파일수 불변) · netCoverage +4 branch (protocol·blocked-host·private-addr·ok) · fabrication 0 · pnpm check FULL GREEN
- **무엇:** 검토 ★ 보안 ADD — `assertPublicHttpUrlSync`(mcp/web-url-guard.ts)의 **SSRF 가드 sync 진입점** 커버 추가(`web-url-guard-boundaries.test.ts`). async twin(`assertPublicHttpUrl`)·헬퍼(isPrivateIPv4/v6)는 테스트됐지만 **합성 sync 게이트는 테스트 0개**였음. 케이스: file:// 거부 / malformed URL / localhost·metadata.internal / 127.0.0.1·[::1]·169.254 메타데이터 / 공개 https 통과.
- **왜:** SSRF는 보안 게이트 — 어느 한 절(protocol/blocked-host/private-addr)이 회귀해도 조용히 통과될 수 있었음. CLAUDE.md "every export gets a direct test" + agent-testing.md "보안은 코드로 테스트".
- **어떻게-증명(MUTATION-FIRST):** `isBlockedHostname` 조건을 `false &&`로 무력화 시 blocked-hostname 케이스 RED(localhost 통과), 복원+클린리빌드 후 14/14 GREEN. ★④b judge가 **3개 가드 절을 각각 독립 mutate**해 모든 케이스가 mutation-caught(inert 없음)임을 재확인 + 값 정확성([::1] bracket-strip, 169.254 link-local) 검증 후 **VERDICT: PASS**.
- **리스크:** 없음 수준 — 테스트-only, 소스 무변경, full `pnpm check` GREEN. (mcp dist 클린리빌드 1회 필요했음 — [[project_stale_dist_from_loop]] 반복 패턴.)

## fire 6 · 2026-06-13 · skill v1.14.0 · 10541481
meta: kind=add · pkg=@muse/agent-core · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 929→930 (새 파일 1) · netCoverage +2 guard clause (verifiedSources·toolsUsed gate) · fabrication 0 · pnpm check FULL GREEN
- **무엇:** `createToolResultQualityAuditFilter`(agent-core/response-filters.ts)의 **게이팅 절** 직접 단위 테스트 추가(새 파일 `tool-result-quality-audit-filter.test.ts`, 3 케이스). 이 필터는 도구가 돌았고 **검증된 소스가 있을 때만** 사과("죄송합니다")를 요약으로 재작성 — 없으면 정직한 "못 찾음"을 보존해야 함. 두 early-return 절(`toolsUsed==0 || verifiedSources==0`)이 미커버였음(통합 테스트는 happy-path strip만, 두 절을 격리 못 함).
- **왜:** grounding 인접 — 검증 소스 없이 사과를 mangle하면 가짜 요약으로 둔갑(정직성 훼손). audit ADD 후보(단 audit의 `createCitationStreamFilter`는 false-positive였음 — 실제로 apps/cli에 있고 이미 테스트됨; verify-the-audit로 걸러냄).
- **어떻게-증명(MUTATION-FIRST):** verifiedSources 절 제거 → "NO source 보존" 케이스만 RED; toolsUsed 절 제거 → "no tool 보존" 케이스만 RED; 복원 3/3 GREEN. 각 절이 **격리되어** 핀됨. ④b judge가 두 mutation 독립 재현 + case(1)이 통합 테스트와 다른 분기(rewrite-prefix vs 💡-passthrough)임 확인 후 **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. ★LESSON: 통합 테스트로 게이트를 격리하려다 실패(toolsUsed/verifiedSources 결합) → **직접 `.apply(response, context)` 단위 테스트**가 정답(english-locale-filters 패턴). 또 mutation 증명이 false-GREEN을 두 번 줌 → incremental `tsc -b`는 stale-dist; **mutation 런마다 `rm -rf dist+tsbuildinfo` 클린 리빌드 필수**, 그리고 mutation 후 **전체 트리 클린 리빌드** 안 하면 의존 패키지(autoconfigure)가 `pnpm check`서 agent-core/dist 모듈 못 찾아 30개 false-fail. [[project_stale_dist_from_loop]]

## fire 7 · 2026-06-13 · skill v1.14.0 · dedc0c4d
meta: kind=prune · pkg=@muse/model (+baseline byte-hygiene fix) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 932→931 (−1 type-only 삭제, judge 승인) · netCoverage 0 (tsc+test/model이 커버) · fabrication 0 · pnpm check FULL GREEN
- **무엇:** (1) PRUNE `model/src/index.test.ts` 삭제 — `ModelResponse.citations`/`ModelEvent` union/`WebSearchCitation`를 구성하고 **방금 쓴 값을 다시 읽어 assert하는 type-conformance 동어반복** 3케이스. (2) ①-baseline 회귀 수정: 전체 레포 `pnpm check`를 막던 byte-hygiene 위반 2건(**differentiation 루프 파일** `scripts/eval-policy-symmetry.mjs:36` raw U+200B + `docs/goals/loops/differentiation.md:262` backtick 안 raw U+200B)을 `\u200b` escape로(값 보존).
- **왜:** type-tautology는 컴파일러가 이미 보장(`tsc`) + runtime citation 동작은 `test/model.test.ts`(count·items·empty-no-fabrication)·`provider-wire.test.ts`가 이중 커버 → 삭제해도 손실 0. byte 위반은 모든 루프 게이트를 red로 막는 baseline 회귀(① "그게 이번 이터레이션").
- **어떻게-증명:** PRUNE — `provider-shared.ts:204` citations emit를 `items: []`로 변형 시 `test/model.test.ts`가 RED(살아남는 행동 커버 입증), 복원 green. ④b judge가 tsc-적합성이 provider 소스들에·runtime이 test/model+provider-wire에 있음 재확인 후 **VERDICT: PASS**. byte-fix — `\u200b`는 런타임 U+200B 그대로(len 1, eval 입력값 불변), byte-hygiene 테스트 0 offender.
- **리스크:** 소스(런타임) 무변경. byte-fix가 다른 루프(differentiation) 파일을 건드림 — 1-char escape라 내용 충돌 위험 낮음(그쪽 다음 머지가 흡수). LESSON: 동시 루프가 raw forbidden 바이트를 main에 흘리면 전체 게이트가 red → 어느 루프든 먼저 만난 fire가 escape로 unblock하는 게 맞음(byte-hygiene는 공유 floor).

## fire 8 · 2026-06-13 · skill v1.14.0 · 1efef75e
meta: kind=add · pkg=@muse/agent-core (+self byte-hygiene fix) · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 938→938 (케이스 +1, 파일수 불변) · netCoverage +1 branch (rest.length===0) · fabrication 0 · pnpm check FULL GREEN
- **무엇:** (1) ADD `createToolResultQualityAuditFilter`의 마지막 미커버 분기 `rest.length===0`(fire 6가 backlog에 남긴 known-gap) — 사과가 출력 전체(뒤에 본문 없음)일 때 필터가 빈 '조회한 결과를…' 헤더로 둔갑시키지 않고 **원문 보존**. (2) self-fix: fire-7 저널/backlog에서 byte-fix를 *설명*하며 backtick 안에 raw U+200B를 또 붙여넣은 내 위반 3곳(test-hygiene.md:68/70, backlog.md:123)을 escape 텍스트로 교정.
- **왜:** 이 필터는 grounding 인접 정직성 게이트 — 사과-only 응답을 내용 없는 가짜 '결과 정리' 헤더로 바꾸면 사용자를 오도. fire 6의 2개 게이트 + 이번 1개 분기로 필터 분기 커버 완결.
- **어떻게-증명(MUTATION-FIRST):** `if (rest.length === 0) return response`를 `if (false)`로 변형 시 새 케이스만 RED(출력이 '조회한 결과를 정리해드릴게요.\\n\\n' 빈 헤더로 둔갑), 복원 4/4 GREEN. ④b judge가 케이스가 `!leadingApology`가 아닌 정확히 `rest===0` 분기를 침(extractApologyLead가 전체 문단 반환→rest="") + 형제/통합 테스트 미커버 재확인 후 **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. ★LESSON(반복): byte-hygiene 위반을 *문서화*할 때 raw 바이트를 또 붙여넣지 말 것 — 저널/backlog에도 escape 텍스트(`\\u200b`)만. fire 7이 differentiation 실수를 고치며 같은 실수를 저질러 fire 8이 self-fix.

## fire 9 · 2026-06-13 · skill v1.14.0 · 9e1b6732 · JUDGE-DRILL + add
meta: kind=add · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=0 (드릴 후 리셋)
ratchet: testFiles 941→942 (새 파일 1) · netCoverage +2 branch (tomorrow·in-N-days) · fabrication 0 · pnpm check RED(무관 회귀, 아래)
- **무엇:** (A) **JUDGE-DRILL**(연속 allPASS≥8 트리거) — 고의 inert 테스트(`formatCoarseAge`가 무엇을 반환하든 통과하는 `typeof==="string"`) 주입 → 변형(formatCoarseAge→"WRONG") 하에서도 통과(mutation-immune) 확인 → ④b judge가 **VERDICT: FAIL**(inert, 행동 미핀)로 정확히 잡음 → `git restore` 롤백. judge 신뢰성 입증. (B) 진짜 슬라이스: `formatDueLocal`(mcp)의 day-granularity 분기(tomorrow·in-N-days) 분기-정밀 커버 추가(`local-due-format.test.ts`). 기존엔 느슨한 OR-regex뿐.
- **왜:** judge가 rubber-stamp가 아니라 진짜 가짜를 잡는지 주기적 검증(maker≠judge 보상통제). + day-hint는 채팅 확인 메시지에 노출되는 시간 표기.
- **어떻게-증명(MUTATION-FIRST):** 드릴 — inert 테스트가 mutation-immune임을 결정적으로 보임. 슬라이스 — `days===1`→`days===999` 시 tomorrow RED, `in ${days} days`→`days+1` 시 in-3-days RED(judge 독립 재현), 복원 2/2 GREEN. TZ-robust(judge가 12개 zone+DST 검증). ④b judge **VERDICT: PASS**(단 내 3번째 케이스 unparseable-echo는 `formatReminderDueLocal` 별칭으로 이미 정밀 커버 → judge 지적 후 **중복 케이스 제거**, 위생 루프가 중복 안 싣도록).
- **리스크:** 내 슬라이스 mcp green + judge PASS. 단 full `pnpm check`는 **무관·진짜 회귀로 red** — `apps/cli/src/actuator-tools.test.ts`의 add_contact arg-grounding 2케이스 실패(사용자가 *말한* 전화번호가 드롭됨). 격리+클린리빌드 후에도 fail = stale-dist 아님. ★원인 커밋 `5ec47842 fix(agent-core): groundToolArguments... (cognition loop fire 21)` — anti-fabrication 게이트가 grounded 값을 과드롭하는 **핵심-edge 회귀**. cognition 루프 도메인이라 내가 그들 의도적 변경을 안 고침(blocker로 backlog 기록, 소유 루프가 수정). 내 mcp 추가는 독립적이라 커밋·머지(main 이미 red).

## fire 10 · 2026-06-13 · skill v1.14.0 · d09f864c
meta: kind=prune · pkg=@muse/model · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 943→942 (−1 중복 삭제, judge 승인) · netCoverage 0 (499 경계 src/로 이식) · fabrication 0 · pnpm check FULL GREEN
- **무엇:** model 이중-실행 중복 제거 — `isRetryableHttpStatus`를 두 파일이 테스트(`src/provider-base.test.ts` 8케이스 + `test/is-retryable-http-status.test.ts` 4케이스, 둘 다 돎). 더 완전한 `src/`(>=600·non-finite·ModelProviderError 추가)를 남기고 lesser `test/` 삭제. 단 `test/`만 가진 유니크 케이스 `499→false`(5xx 하한 경계)를 먼저 `src/`의 4xx 리스트에 **이식**.
- **왜:** 같은 함수를 두 파일이 매 run 중복 테스트(model double-run). fire-4 교훈: lesser 파일도 유니크 경계를 가질 수 있어 case-by-case 대조 필수.
- **어떻게-증명(MUTATION-FIRST PRUNE):** `status >= 500`→`>= 499` 변형 시 이식한 499 케이스가 RED(삭제 파일이 지키던 하한 경계를 src/가 그대로 잡음), 복원 8/8 green. ④b judge가 삭제 파일의 *모든* assertion이 src/에 subsumed + 양쪽 경계(499 하한·600 상한) mutation-caught 재확인 후 **VERDICT: PASS**.
- **리스크:** 소스 무변경. ★LESSON: `pnpm check` 전 whole-tree `rm -rf dist tsconfig.tsbuildinfo`는 빌드-순서 race 유발(의존 패키지가 dep dist를 test 중 못 찾아 "Failed to resolve @muse/model" 4파일 false-fail) → `pnpm -r build` 먼저 OR `rm` 없이 `pnpm check`만. 재실행으로 GREEN 확정([[project_stale_dist_from_loop]]).

## fire 11 · 2026-06-13 · skill v1.14.0 · 6fc80a16
meta: kind=prune · pkg=@muse/tools · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 944→943 (−1 중복 삭제, judge 승인) · netCoverage 0 (src/가 strict superset) · fabrication 0 · pnpm check FULL GREEN (첫 시도)
- **무엇:** tools 이중-실행 중 `muse-tools-helpers`(arg-parser 헬퍼 readOptionalString/readRequiredDate/readOptionalDate[3-state]/readOptionalNumber) 쌍 정리 — `src/`(11케이스)가 `test/`(7케이스)의 strict behavioral superset임을 함수별 확인 후 lesser `test/muse-tools-helpers.test.ts` 삭제. src/가 추가로 null/missing-key/음수/0 엣지까지 커버 → 이식 불필요.
- **왜:** 같은 헬퍼를 두 독립 스위트가 매 run 중복 테스트. readOptionalDate의 absent/invalid/date 3-state는 load-bearing(absent↔invalid 붕괴 시 도구가 잘못된 instant로 조용히 anchor).
- **어떻게-증명(MUTATION-FIRST PRUNE):** readOptionalDate 비-string `invalid`→`absent` 변형 시 src/의 "present-but-unparseable→invalid" RED(`{kind:'absent'}≠{kind:'invalid'}`), 복원 11/11 green. ④b judge가 삭제 파일의 *모든* assertion이 src/에 subsumed + invalid **양쪽 서브분기**(비-string + NaN-string) mutation-caught 재확인 후 **VERDICT: PASS**.
- **리스크:** 소스 무변경. ★data/text/time 쌍은 **독립 작성된 다른 스위트**(복사본 아님, 케이스 문구 다름)라 helpers처럼 깨끗한 subset이 아닐 수 있음 — 쌍마다 함수별 대조 필수(backlog 기록). fire-10 교훈 적용: whole-tree `rm -rf dist` 안 함 → stale-dist 캐스케이드 없이 첫 check GREEN.

## fire 12 · 2026-06-13 · skill v1.14.0 · ef59ddca
meta: kind=prune · pkg=@muse/tools · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 945→944 (−1 중복 삭제, judge 승인) · netCoverage 0 (2 유니크 케이스 test/로 이식) · fabrication 0 · pnpm check FULL GREEN
- **무엇:** tools 이중-실행 `muse-tools-time` 쌍 정리 — 6개 time 도구를 두 독립 스위트가 테스트(src 13 / test 18). 더 완전한 `test/` 유지, lesser `src/muse-tools-time.test.ts` 삭제. 단 src/만 가진 유니크 2개를 test/로 이식: ①대문자 weekday `MONDAY`(case-insensitivity) ②**유효 non-UTC zone `Asia/Seoul`**(요일 롤오버).
- **왜:** 같은 도구를 두 스위트가 중복. non-UTC zone은 "Seoul은 지금 무슨 요일?"의 조용한 오답을 막는 핵심 가드.
- **어떻게-증명(MUTATION-FIRST PRUNE):** `.toLowerCase()` 제거→MONDAY RED; `timeZone: timezone`→`"UTC"`→Seoul 케이스 RED(`'Saturday'≠'Sunday'`). 복원 19/19 green. ★④b judge **1차 FAIL**로 내가 놓친 Seoul non-UTC zone 손실을 잡음(zone 무시해도 222 green이던 구멍) → 더 강한 케이스(Sat 16:00 UTC=Sun 01:00 KST, 요일 롤오버)로 이식 → 2차 judge 전수 sweep 후 **VERDICT: PASS**.
- **리스크:** 소스 무변경. LESSON(반복): 독립 스위트 prune은 "fuller가 모든 걸 커버"가 거짓일 수 있음 — 함수별 전수 대조해도 사람(나)은 유니크를 놓침, judge가 보상통제. data/text 쌍 남음(backlog).

## fire 13 · 2026-06-13 · skill v1.14.0 · e5231481
meta: kind=prune · pkg=@muse/tools · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 946→945 (−1 중복 삭제, judge 승인) · netCoverage 0 (2 유니크 케이스 src/로 이식) · fabrication 0 · pnpm check GREEN(무관 부하-flake 제외, 아래)
- **무엇:** tools 이중-실행 `muse-tools-text` 쌍 정리 — 4개 text 도구(TextStats/Slugify/KvSummarize/MarkdownTable)의 두 독립 스위트 중 더 완전한 `src/`(18→20) 유지(depth-cap·200-line-cap·200-row-cap 보유), lesser `test/`(14) 삭제. test 유니크 2개를 src/로 이식: ①ZWJ 가족-emoji 3-grapheme(`\u{200D}` escape) ②**MarkdownTable 컬럼 union(다른 키 행) + 누락 셀 빈-채움**.
- **왜:** 같은 도구 중복 스위트. column-union/empty-fill은 `deriveMarkdownTableColumns`의 merge-across-rows + `undefined→""` 분기 — src/의 동일-키 derived 케이스가 안 치던 진짜 가드.
- **어떻게-증명(MUTATION-FIRST PRUNE):** ZWJ — `countGraphemes→text.length` 시 RED(UTF-16 과카운트); union — `deriveMarkdownTableColumns` 첫 행만(`index<1`) 시 RED(c 컬럼 손실). 복원 20/20 green. ★④b judge **1차 FAIL**로 내가 놓친 column-union/empty-fill 손실을 잡음(src의 derived 케이스는 동일-키라 union 미커버) → 이식 → 2차 judge 전수 sweep 표로 14→20 확인 후 **VERDICT: PASS**.
- **리스크:** 소스 무변경. full `pnpm check`는 **무관 부하-flake**로 red — `@muse/messaging pending-approval-store "caps to 200 most recent"`가 동시-루프 부하서 5028ms timeout(격리 3.04s pass). fire-2 playbook-store와 동일 부류(200 순차 write, slow-ish) → de-flake 후보로 backlog 기록(이번 슬라이스와 무관·pre-existing). LESSON: 독립 스위트 prune은 사람이 유니크를 놓침 — judge가 3 fire 연속(4·12·13) 실제 손실 잡음.

## fire 14 · 2026-06-13 · skill v1.14.0 · d3bb59ce
meta: kind=fix(flaky) · pkg=@muse/messaging · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 949→949 (재작성, 파일수 불변) · netCoverage 0 (동작 보존) · fabrication 0 · pnpm check FULL GREEN (단독)
- **무엇:** fire 13이 발견한 flaky 테스트 수정 — `pending-approval-store.test.ts > "caps to 200 most recent"`가 **205회 순차 디스크 write**로 ~3.0s(부하 시 5028ms timeout). setup을 **`fs.writeFile`로 e0..e203(204개) 1회 seed(`{pending:[...]}`) + `recordPendingApproval(e204)` 1회로 cap 트리거**로 재작성. 205 writes → 2 ops, 동일 assertion(length 200, [0]=e5, [last]=e204). 3040ms→73ms.
- **왜:** flaky 테스트는 동시-루프 부하 시 full check를 red로 오염. KIND 다양성(최근 3 fire 모두 prune)상 FIX 필수. fire-2 playbook-store와 동일 패턴.
- **어떻게-증명(MUTATION-FIRST):** cap slice를 `slice(len-MAX)`→`slice(0,MAX)`(oldest 유지)로 변형 시 재작성 테스트 RED(`'e0'≠'e5'`); ④b judge가 2차 mutation(cap 제거→length 205)도 잡힘 + seed가 충실(e0..e203+record=205→cap e5..e204, 원본과 동일 end-state) + 204 seed 전부 read-back(quarantine 안 됨) 재확인 후 **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. ★LESSON(강화): `pnpm check` 전 `pnpm -r build`나 `rm -rf dist` 절대 금지 — 더블 빌드가 stale-dist resolve 실패(mcp 4파일) + eslint stale-타입 false-positive(unused var) + **OOM SIGABRT(134)**까지 유발. `pnpm check` 단독만 → 클린 GREEN. [[project_stale_dist_from_loop]]

## fire 15 · 2026-06-13 · skill v1.14.0 · ce3e3855
meta: kind=prune · pkg=@muse/tools · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 952→951 (−1 중복 삭제, judge 승인) · netCoverage +3 (test 보안 케이스 src로 이식) · fabrication 0 · 슬라이스 격리 green+judge PASS (full check는 무관 부하-flake)
- **무엇:** 마지막 tools 이중-실행 `muse-tools-data` 쌍 정리(4 도구: math/hash/csv/base64). 더 완전한 `src/`(20→23) 유지, lesser `test/`(17) 삭제. ★사전 전수 대조로 test 유니크 3개(보안)를 한 번에 이식: CsvParse 200k·Base64 500k DoS 경계 + padBase64 %4===3 패딩-복원. (multi-dot·modulo는 src가 이미 커버 확인 — 불필요 이식 회피.)
- **왜:** tools 4쌍 이중-실행 정리 완결(helpers·time·text·data). test의 DoS 경계 케이스("mutation-surfaced gap")는 src가 없던 진짜 보안 커버 — 보존 필수.
- **어떻게-증명(MUTATION-FIRST PRUNE):** CsvParse 200k 경계 무력화(`>MAX`→`>999999999`) 시 RED; Base64 500k도 동일 메커니즘(judge 독립 확인). padBase64는 Node Buffer가 unpadded 관대 디코드라 mutation-immune(decode round-trip은 src url-safe가 커버, encode 출력은 assert) — 무해한 over-preservation. ④b judge **1차 PASS**(사전 전수 대조로 FAIL-재작업 회피, time/text 교훈): 17→23 전 행동 생존 + trailing-tokens는 다른 스위트가 커버 + 양쪽 DoS mutation-caught 확인.
- **리스크:** 소스 무변경. full `pnpm check` red지만 **무관 일시 아티팩트** — (1차) judge 서브에이전트의 동시 tools-mutation 빌드가 agent-core 테스트와 레이스("Failed to resolve @muse/tools"), (2차) apps/cli Ink-render `"echoes typed command"`가 동시-루프 부하서 5735ms timeout(다른 테스트 → 일시적). 둘 다 본 슬라이스·tools와 무관. LESSON: judge가 같은 패키지 dist를 mutation-churn하는 동안 full check를 돌리면 resolve 레이스 — judge 완료 후 check.

## fire 16 · 2026-06-13 · skill v1.14.0 · 06fb7452
meta: kind=add · pkg=@muse/recall · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 954→954 (케이스 +2, 파일수 불변) · netCoverage +2 branch (accumulation·alias, 패키지-로컬 직접) · fabrication 0 · pnpm check FULL GREEN (첫 시도)
- **무엇:** `contactMatchScore`(recall/select.ts, grounding 연락처 매칭)에 직접 단위 케이스 2개 추가(`contacts.test.ts`) — ①**누적**(매칭 토큰 *수*가 score, cap 1 아님): `{dana,lee,manager}`→3 ②**alias 매칭**: alias-only 토큰 `sparky`→1. 기존엔 단일 name 매칭 `>0`만.
- **왜:** 연락처 해소 스코어링(grounding). 기존 `>0`는 cap된 score로도 통과 → 누적/alias 동작 미보장(패키지-로컬).
- **어떻게-증명(MUTATION-FIRST):** `score += 1`→`= 1` 시 누적 케이스만 RED(3→1); alias loop 제거 시 alias 케이스만 RED(1→0); 복원+클린리빌드 8/8 green. ④b judge가 격리·값 정확(lexicalTokens "Dana Lee"→{dana,lee}) 확인 후 **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. ★정직한 caveat(judge 지적): 두 분기는 **repo-전역으론 이미 간접 커버**됨 — `apps/cli/commands-ask-contacts.test.ts`가 alias `>0`·누적을 `email sarah chen > email sarah`로 간접 검증. 본 슬라이스는 **함수 홈 패키지(@muse/recall)에 더 타이트한 절대값 직접 커버**를 추가(가치 있으나 "제로→커버"는 아님). recall 직접-테스트 갭이 거의 채워졌다는 신호 — 쉬운 ADD vein 얇음.

## fire 17 · 2026-06-13 · skill v1.14.0 · 4ce37691
meta: kind=prune · pkg=@muse/agent-core · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 958→957 (−1 중복 삭제, judge 승인) · netCoverage 0 (surviving test/가 strict superset) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** agent-core 동명 쌍 `citation-sanitiser` 정리 — 콜로케이트 `src/citation-sanitiser.test.ts`(7케이스) 삭제, 더 thorough한 `test/citation-sanitiser.test.ts`(5케이스, strict superset) 유지. 새 vein 발견: agent-core/mcp/messaging/model/autoconfigure 등에 **30개 동명 src+test 쌍**(dist 이중-실행 아님 — config가 dist exclude; 같은 모듈을 보완/중복 테스트하는 두 source 파일).
- **왜:** src/ 7케이스 전부 test/가 동등-이상으로 커버(https/http keep·js/data/empty/non-url drop·empty-input) + test/는 file/ftp/mailto·non-string·순서보존·mixed-partition까지 추가. 보안-관련(인용 링크 sanitise, grounding 표면) 모듈이라 우선. src/는 완전 redundant.
- **어떻게-증명(MUTATION-FIRST PRUNE):** 생존 `test/`를 cite — `isSafeUrl`의 `ALLOWED_PROTOCOLS.has(protocol)`→`return true` 변형 시 test/ 2/5 RED(protocol-drop + mixed-partition); 변형 복원 후 5/5 green. ④b **독립 Opus judge가 git show로 삭제본 복원해 7케이스 전수 대조 + 자체 mutation 재현** → strict-subset 확인, **VERDICT: PASS**.
- **리스크:** 소스 무변경, 삭제 1파일뿐(`git status` D 1줄). netCoverage 0(진짜 중복 제거). 남은 29쌍은 각각 superset 확인 필요(blanket 삭제 금지) — 향후 fire용 PRUNE vein.

## fire 18 · 2026-06-13 · skill v1.14.0 · 6428bcd8
meta: kind=prune(consolidate) · pkg=@muse/model · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 958→957 (−1 통합, 유니크 케이스 1 이식) · netCoverage 0 (overlap만 제거) · fabrication 0 · pnpm check: model GREEN(287); 무관 apps/api LINE-webhook 1건 20s timeout=동시-루프 부하(격리 4/4 9.4s) · lint 0
- **무엇:** model 동명 쌍 `web-search-policy` **통합** — `src/`(213L, fuzz-rich)와 `test/`(87L)가 같은 `decideWebSearchPolicy`를 둘 다 테스트. src/가 test/ 행동을 1개 빼고 전부 동등-이상 커버 → 그 1개("disabled 정책도 resolved maxUses 유지 = 비활성화가 검색 예산을 0으로 만들지 않음")만 src/로 이식하고 `test/` 삭제. fire 17의 동명-쌍 vein 후속(이번엔 strict-subset 아님 — **상보적**이라 overlap만 제거하는 consolidate).
- **왜:** 같은 모듈 enabled/maxUses 해소 로직이 두 파일에서 ~11 케이스 중복 실행(진안 "중복 제거"). 단 양쪽 유니크 케이스 손실 금지 — src/는 fuzz+kill-switch가 더 강하나 disabled-path maxUses 보존은 test/에만 있었음.
- **어떻게-증명(MUTATION-FIRST):** `args.override===false` 분기를 `maxUses: DEFAULT_MAX_USES`로 변형 시 이식된 케이스 **딱 1개만 RED**(나머지 15 green incl. property-fuzz는 `>0`만 보장 → 5도 통과) — disabled-path maxUses의 유일 가드임을 증명. 변형 복원+클린리빌드 16/16 green. ④b 독립 Opus judge가 삭제본 git show로 **15개 행동 전수 매핑**(전부 equal-or-stronger) + mutation-uniqueness 재현 + `model` 필드 미사용(브랜치 은닉 없음) 확인 → **VERDICT: PASS**.
- **리스크:** 소스(비-test) 무변경. 변경은 −87L(test/ 삭제) +11L(src/ 이식) 2건뿐. ★`pnpm check` red는 **무관 환경 아티팩트**(apps/api `messaging-webhooks` buildServer 테스트가 동시 6+ 루프 부하서 20s timeout; 격리 재실행 4/4 9.4s pass) — 본 @muse/model 슬라이스와 무관, backlog에 환경 이슈 기록.

## fire 19 · 2026-06-14 · skill v1.14.0 · 5bc93add
meta: kind=add · pkg=@muse/policy · verdict=PASS · firesSinceDrill=0 (★JUDGE-DRILL 완료 후 리셋)
ratchet: testFiles 959 (케이스 +1, 파일수 불변) · netCoverage +1 (count accumulation, maskPii+findPii 양 경로) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **★JUDGE-DRILL(firesSinceDrill≥10 도달, 미루기 불가):** model/web-search-policy에 고의로 inert 테스트 주입 — env MAX_USES="8"이 "양의 정수"임만 assert(값 8을 pin 안 함; property-fuzz가 이미 보장하는 invariant 복붙). 독립 ④b Opus judge가 **VERDICT: FAIL**(mutation으로 strictPositiveInt→3 해도 green 유지 = value-blind, 이미 precedence/typo/disabled 케이스가 값을 pin) → `git checkout`으로 롤백. maker≠judge 게이트 신뢰성 재확인 → 카운터 0 리셋.
- **무엇(진짜 슬라이스):** `@muse/policy` pii-patterns에 finding **count 누적** 커버 추가 — 기존 13개 테스트 전부 `.name`만 채점, `{name,count}`의 count(maskPii `(get??0)+1` per-match, findPii `+matches.length`)는 assert 0. 이메일 3개→count 3(maskPii), SSN 2개→count 2(findPii).
- **왜:** PII 감사 정확도(privacy/grounding 인접) — "이메일 1건"인데 실제 3건이면 잘못된 감사 보고. 보안 게이트 패키지(injection/PII/leakage)인데 count 출력이 미검증이었음. 패키지 다양성도(policy는 이 루프 첫 터치).
- **어떻게-증명(MUTATION-FIRST ADD):** maskPii 누적→상수 1 변형 시 email-count assert만 RED(7 green); findPii 누적→상수 1 변형 시 ssn-count assert만 RED — 양 경로 각각 pin, 다른 테스트는 무영향(진짜 미커버). 독립 ④b judge가 양 mutation 재현 + 값 정확성(패턴 overlap 없음) + 중복부재 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, full check GREEN. count 누적은 공개 API 필드라 회귀 시 조용한 부정확 — 이제 pin됨.

## fire 20 · 2026-06-14 · skill v1.14.0 · ff23c3e6
meta: kind=prune(consolidate) · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 960→959 (−1 통합, 유니크 케이스 1 이식) · netCoverage 0 (overlap만 제거) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `atomic-file-store` **통합**(fire 17·18 vein 후속, 첫 mcp 쌍) — `atomicWriteFile`/`withFileMutationQueue`를 `src/`(68L)·`test/`(91L)가 둘 다 실행. queue 4케이스는 완전 중복, test/는 atomicWriteFile에 3케이스 더(0600 mode·fsync 옵션·rename-실패 시 tmp-orphan 정리). src/ 유일 케이스 1개("40 동시쓰기 ENOENT rename 크래시 없음 = randomUUID tmp 가드")만 test/로 이식하고 src/ 삭제.
- **왜:** 파일 무결성의 기반 프리미티브(모든 store가 의존)인데 두 파일 중복 실행. 진안 "중복 제거" — 단 양쪽 유니크(test/ 3개 보안·src/ 1개 동시성)는 손실 금지.
- **어떻게-증명(MUTATION-FIRST):** 이식한 동시성 케이스 — tmp명에서 `-${randomUUID()}` 제거(same-pid 충돌 재현) 시 그 케이스만 RED(정확히 `ENOENT ... rename race.json.tmp-<pid>`), 나머지 9 green → 진짜 회귀 가드 + 유일성 증명. 복원+클린리빌드 10/10 green. ④b 독립 Opus judge가 삭제본 7개 행동 전수 매핑(전부 equal-or-stronger) + mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스(비-test) 무변경. 변경 −68L(src/ 삭제) +8L(이식) 2건뿐. mcp dist 클린리빌드 1회 필요(stale-dist 패턴 [[project_stale_dist_from_loop]]). 남은 mcp 동명 쌍 13개 — 각각 subset/complementary 판별 후 처리.

## fire 21 · 2026-06-14 · skill v1.14.0 · 679cd3c5
meta: kind=add · pkg=@muse/resilience · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 964 (케이스 +1, 파일수 불변) · netCoverage +2 branch (multiplier·maxDelay floor-clamp) · fabrication 0 · resilience 26/26 green + lint 0
- **무엇:** `computeRetryDelay`(resilience/index.ts)의 **오설정 knob floor-clamp 2개** 커버 추가 — `multiplier=Math.max(1,…)`(multiplier<1은 backoff를 *축소*시켜 실패 provider 폭격) + `maxDelay=Math.max(initial,…)`(maxDelayMs<initialDelayMs는 첫 delay를 floor 아래로 cap). 기존 테스트는 전부 multiplier≥2·maxDelayMs>initial이라 두 clamp 미커버. 한 테스트 2 assert(동종 floor-guard 배칭).
- **왜:** 결정적 retry/stop-condition 정책 코드(CLAUDE.md "policy/budget/stop은 결정적 코드"). NaN 가드와 같은 오설정-방어 계열인데 — multiplier<1이면 재시도 간격이 *줄어* 실패 중인 provider를 더 때림(조용한 회귀 가능).
- **어떻게-증명(MUTATION-FIRST ADD):** multiplier `Math.max(1,…)` 제거 시 0.5→`100*0.5²=25`로 multiplier-assert만 RED; maxDelay `Math.max(initial,…)` 제거 시 50으로 cap→maxDelay-assert만 RED. 각 assert가 자기 clamp만 잡음(독립·비-동어반복), 다른 25 green. 독립 ④b Opus judge가 양 mutation 재현 + 양 clamp 미커버 + 값(둘 다 100) 정확성 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, resilience 격리 green. ★`pnpm check` red 1건은 **무관 환경**(apps/api `messaging-webhooks` buildServer 20s timeout, 격리 4/4 8.6s — fire 18과 동일 부하 아티팩트, backlog既기록).

## fire 22 · 2026-06-14 · skill v1.14.0 · 6e17c3b9
meta: kind=prune(consolidate) · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 966→965 (−1 통합, 유니크 assert 1 이식) · netCoverage 0 (overlap만 제거) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `run-actuator-by-name` **통합**(fire 20 vein, 2번째 mcp 쌍) — 콜로케이트 `src/`(12케이스, **outbound-safety acceptance + action-log** describe 포함: performed/refused/failed 로깅·throwing-approval fail-close·ambiguous-recipient 거절)가 thinner `test/`(5케이스)를 1개 빼고 전부 동등-이상 커버. 그 1개("실패 detail이 `HTTP 500` 포함")만 src/ 500-케이스에 이식, `test/` 삭제. 더 fuller한 쪽이 src/라 src/ 유지.
- **왜:** outbound 액추에이터 디스패처(outbound-safety.md 핵심) — 두 파일 중복 실행. src/는 fail-close·action-log까지 더 강하나, test/의 "detail이 HTTP status 노출" assert만 src/에 없었음(손실 금지).
- **어떻게-증명(MUTATION-FIRST):** `web-action.ts:173`의 `server rejected (HTTP ${status})`에서 status 텍스트 제거 시 이식한 assert만 RED(`'server rejected' to contain 'HTTP 500'`), 나머지 11 green → 진짜 가드 + 유일성. 복원+클린리빌드 12/12 green. ④b 독립 Opus judge가 삭제본 5개 행동 전수 매핑(전부 equal-or-stronger, fail-close/approval/action-log 손실 0) + mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스(비-test) 무변경. 변경 −58L(test/ 삭제) +1L(이식) 2건뿐. mcp dist 클린리빌드 1회. 남은 mcp 동명 쌍 12개.

## fire 23 · 2026-06-14 · skill v1.14.0 · 4ff1310e
meta: kind=add · pkg=@muse/agent-core · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 970 (케이스 +1, 파일수 불변) · netCoverage +1 branch (DEFAULT_SECTION_PRIORITY fallback) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `enforceSystemPromptBudget`(prompt-budget.ts, 시스템프롬프트 토큰예산 eviction)의 **미지(未知) 섹션 mid-priority 기본값(`DEFAULT_SECTION_PRIORITY=55`)** 커버 추가. 기존 enforce 테스트 4개는 전부 *알려진* 섹션 id(active-context·feeds·episodic-recall)만 써서 `?? DEFAULT_SECTION_PRIORITY` fallback이 미커버였음. skills(50)<unknown(55)<episodic-recall(60)로 2/3 드롭 시 skills→unknown 순 evict, episodic 생존.
- **왜:** "새 transform 섹션은 *조용히 가장 먼저 버려지지 않는다*"는 설계 불변식(코드 주석 명시) — grounding/runtime trimming 경로(CLAUDE.md "context 작으면 trimming"). 새 섹션이 priority 미등록이어도 중간에 위치해야 active-context/memory 같은 핵심 전에 안 버려짐.
- **어떻게-증명(MUTATION-FIRST ADD):** `DEFAULT_SECTION_PRIORITY` 55→0 변형 시 unknown이 최우선-eviction 되어 drop 순서 뒤집힘(RED); 55→100 변형 시 unknown이 episodic보다 sticky해져 episodic이 대신 드롭(RED). 양 boundary가 55를 (50,60) 사이로 bracket — 각각 새 테스트만 RED, 다른 4개 무영향. 독립 ④b Opus judge가 양 mutation 재현 + fallback 미커버 + 순서/값 정확성 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, full check GREEN. 미지-섹션 우선순위는 새 transform 추가 시 회귀하기 쉬운 조용한 동작 — 이제 양방향 pin.

## fire 24 · 2026-06-14 · skill v1.14.0 · 196fb1b6
meta: kind=prune · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 972→971 (−1 strict-superset 삭제, 이식 불필요) · netCoverage 0 (진짜 중복) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `undo-action` **clean PRUNE**(fire 20·22 vein, 3번째 mcp 쌍, 이번엔 fire17처럼 strict-superset이라 이식 0) — 콜로케이트 `src/`(4케이스)가 thinner `test/`(3케이스)의 **strict superset**. src/ case1은 runDueObjectives→performConsentedAction→undo→재-tick 풀 e2e(reversible-reverse·veto-record·performed-log+detail 전부), case2 veto-overrides-consent-direct, case3 irreversible+veto, case4 hasVeto scope-exactness(src 유니크). test/ 3케이스는 src가 없는 행동 0 → test/ 삭제.
- **왜:** outbound 자율행동 undo/veto(outbound-safety.md #4 "reversible-where-possible + veto") — 두 파일 중복 실행. src/가 모든 행동 더 강하게 커버.
- **어떻게-증명(MUTATION-FIRST PRUNE):** 생존 src/ cite — recordVeto no-op化 시 src/ 3/4 RED; reverse() 제거 시 reversible case RED; veto scope 오염 시 fail-close 통합 2케이스 RED. ④b 독립 Opus judge가 삭제본 3개 행동(reversible-reverse+detail·irreversible·veto-overrides-consent fail-close) 전수 매핑(전부 equal-or-stronger, MISSING 없음) + 3 mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스 무변경, 삭제 1파일(−83L)뿐. consent/veto fail-close 커버 손실 0(judge 명시 확인). mcp dist 클린리빌드 1회. 남은 mcp 동명 쌍 11개.

## fire 25 · 2026-06-14 · skill v1.14.0 · 6fba9fd8
meta: kind=prune(consolidate) · pkg=@muse/agent-core · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 973→972 (−1 통합, 유니크 케이스 2 이식) · netCoverage +2 (test/의 약한 buildModelRequest 커버 강화) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** agent-core 동명 쌍 `model-invocation` **통합**(첫 agent-core 동명-쌍 consolidate) — 작은 콜로케이트 `src/`(6케이스)와 훨씬 풍부한 `test/`(invokeModel·failure-injection·token-usage + 두 순수함수, 323L)가 둘 다 실행. test/가 src/의 applyCitationSanitisation 2케이스(equal-or-stronger)·metadata-preserve를 이미 커버하나, buildModelRequestWithWebSearch는 "정의됨"만 확인하는 약한 1케이스뿐. src/의 유니크 2케이스(설정→정책 VALUE 배선·override=false 억제 배선)만 이식, src/ 삭제. case4(no-slash)는 SKIP(decideWebSearchPolicy가 model을 안 읽음 → dead input, judge 확인).
- **왜:** 같은 모듈 두 파일 중복 실행 + test/의 web-search 정책 배선 커버가 약했음("정의됨"만). 이식으로 settings/override→정책 배선을 값으로 pin(강화).
- **어떻게-증명(MUTATION-FIRST):** `settings: ctx.settings`→`{}` 변형 시 VALUE 케이스만 RED(maxUses 4→5); `override: ctx.override`→`undefined` 변형 시 override 케이스만 RED(enabled false→true) — 각 배선 독립 pin. ④b 독립 Opus judge가 삭제본 6개 행동 전수 매핑(전부 equal-or-stronger, MISSING 없음) + case4-SKIP 타당성(model=dead input) 소스 확인 + 양 mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스(비-test) 무변경. 변경 −64L(src/ 삭제) +17L(이식 2케이스) 2건. agent-core dist 클린리빌드 1회.

## fire 26 · 2026-06-14 · skill v1.14.0 · 6312e8c0
meta: kind=add · pkg=@muse/memory · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 976 (케이스 +1, 파일수 불변) · netCoverage +1 branch (hardBudget≤0 no-user 가드) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `trimConversationMessages`(memory-token-trim.ts, 컨텍스트 트리밍)의 **hardBudget≤0 fail-safe의 no-user 서브분기** 커버 추가. 예산이 비양수면 마지막 user 메시지만 남기되 — **user가 없거나(lastUserIndex<0) 단일 메시지면 전체 유지**. 기존 2케이스는 "user 있음→마지막만"·"단일→그대로"만 커버, "user 없음+다중→전체 유지"(`lastUserIndex>=0` 가드)는 미커버였음.
- **왜:** 트리밍은 provider 직전 마지막 sanitiser(CLAUDE.md "context 작으면 trimming"). 예산 고갈 + user 부재 시 `messages[-1]`=undefined를 앵커로 잡으면 빈/깨진 대화가 provider로 감 — 가드가 그걸 막음(KIND 다양성: 23 ADD·24·25 PRUNE라 이번 필수 ADD, FIX vein 고갈).
- **어떻게-증명(MUTATION-FIRST ADD):** `lastUserIndex >= 0 &&` 제거 시 no-user 케이스가 `[undefined]`를 keep → `estimateMessageTokens`에서 `undefined.role` 크래시(RED). 새 테스트만 RED, 다른 14 green = 진짜 미커버. ④b 독립 Opus judge가 mutation 재현(크래시 확인) + 서브분기 미커버 + 기대값(`["s","aaaa","bbbb"]`)·triggeredBy 정확성 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, full check GREEN. memory는 ADD 첫 터치 패키지(5 테스트파일로 잘 커버됐으나 이 edge 서브분기는 빠져 있었음).

## fire 27 · 2026-06-14 · skill v1.14.0 · b6a4a8a6
meta: kind=prune · pkg=@muse/messaging · verdict=PASS · firesSinceDrill=0 (★JUDGE-DRILL 완료 리셋)
ratchet: testFiles 977→976 (−1 strict-subset 삭제) · netCoverage 0 (진짜 중복) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **★JUDGE-DRILL(연속 allPASS=8 도달, 미루기 불가):** 같은 쌍에서 **더 풍부한 test/(74L superset)를 삭제**하고 thin src/(39L subset)가 커버한다고 거짓 주장하는 **커버-손실 PRUNE** 주입 → 독립 ④b Opus judge가 **VERDICT: FAIL**(삭제된 쪽이 실제 superset임을 git show로 확인, 잃은 fail-close 배터리 수십 개 — bare-emoji-strips-to-empty·yes👍please·한국어 qualifier·non-string null/123/{} 등 열거) → 복원. maker≠judge 게이트 신뢰성 재확인(rubber-stamp 아님) → 카운터 0 리셋.
- **무엇(진짜 슬라이스):** messaging 동명 쌍 `is-approval-reply` **clean PRUNE** — outbound-consent 게이트(`isApprovalReply`, 모호하면 fail-close)를 thin 콜로케이트 src/(4케이스)와 풍부한 test/(전체 APPROVALS·정규화·fail-close 적대 배터리·non-string 가드)가 둘 다 실행. test/가 src/의 strict superset(모든 affirmation·reject-longer·empty/non-string 동등-이상) → src/ 삭제, 이식 0.
- **왜:** state-변경 send를 게이트하는 consent 파서 — 두 파일 중복 실행. test/가 모든 행동 더 강하게 커버(특히 fail-close).
- **어떻게-증명(MUTATION-FIRST PRUNE):** 생존 test/ cite — `APPROVAL_PHRASES.has`→substring `.includes` 변형 시 7 fail-close 케이스 RED(yes-but-qualifier·yesss·yes👍please·한국어 qualifier 등) = consent fail-close 진짜 작동. 복원+클린리빌드 67/67 green. 실제 ④b judge가 삭제본 전 행동 전수 매핑(전부 equal-or-stronger, MISSING 없음) → **VERDICT: PASS**.
- **리스크:** 소스 무변경, 삭제 1파일(−39L)뿐. consent fail-close 커버 손실 0(judge 확인). messaging 동명-쌍 첫(남은 3: channel-approval-gate·pending-approval-store·provider-helpers).

## fire 28 · 2026-06-14 · skill v1.14.0 · 7ca64be4
meta: kind=add · pkg=@muse/memory · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 978 (케이스 +1, 파일수 불변) · netCoverage +1 branch (escape handling) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `extractJsonObject`(memory-extract-json.ts, LLM 출력에서 JSON 추출 — grounding 인접)의 **slow-path 균형-중괄호 스캐너 escape 분기** 커버 추가. fast parse 실패 시 `findBalancedBraceBlocks`(문자열-인식 brace 스캔)로 fallback — 그 안의 escape 처리(문자열 안 `\"`는 string-state를 토글하지 않아 뒤따르는 `}`가 in-string으로 유지)는 미커버였음(기존 brace-in-string 테스트는 전부 *비-escape* 중괄호 `"hi {there}"`만).
- **왜:** 작은 로컬 모델이 JSON을 prose로 감싸 내보낼 때 slow-path가 마지막 균형 블록을 추출 — 값에 escape된 따옴표+중괄호가 있으면 escape 처리 없이는 블록 경계가 깨져 추출 실패(grounding 입력 유실).
- **어떻게-증명(MUTATION-FIRST ADD):** prose wrapper로 slow-path 강제 + 값에 `\"`+`}`. `escape = true`→`false` 변형 시 `\"`가 문자열을 조기 종료 → 뒤 `}`가 블록 조기-마감 → 파싱 블록 없음 → undefined로 새 테스트만 RED(다른 10 + 자매 parse suite 8 green = 유일 sentinel). ④b 독립 Opus judge가 slow-path 강제 확인 + mutation 재현(유일 sentinel) + escape 분기 미커버 + 기대값 정확성 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, full check GREEN. JS 문자열 `\\"`→실제 `\"`(JSON escape) 주의. 새 머지된 모듈(memory-extract-json.ts)의 가장 까다로운 분기를 pin.

## fire 29 · 2026-06-14 · skill v1.14.0 · 848bd205
meta: kind=prune · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 980→979 (−1 strict-subset 삭제) · netCoverage 0 (진짜 중복) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `loopback-helpers` **clean PRUNE**(4번째 mcp 쌍) — 6 shared tool-arg shape reader(readString/readStringArray/readBoolean/readJsonObject/errorMessage/buildJsonToolSchema)를 thinner 콜로케이트 test/(65L)와 fuller src/(95L)가 둘 다 실행. src/가 test/의 superset(6 헬퍼 전부 동등-이상 + 유니크: empty-string readString·all-non-string→[]·errorMessage(undefined)·**fresh-required-array 방어적-복사 가드**) → test/ 삭제, 이식 0.
- **왜:** 같은 6 헬퍼 두 파일 중복 실행. src/가 모든 행동 더 강하게 커버 + test/엔 없는 방어적-복사 가드까지.
- **어떻게-증명(MUTATION-FIRST PRUNE):** 생존 src/ cite — readBoolean을 `typeof==="boolean"`→`!=="undefined"`로 변형 시 src/ readBoolean 케이스 RED(나머지 13 green). ④b 독립 Opus judge가 삭제본 6 헬퍼 전 행동 전수 매핑(전부 equal-or-stronger, MISSING 없음) + 5 mutation으로 8 케이스 RED(live 확인) → **VERDICT: PASS**.
- **리스크:** 소스 무변경, 삭제 1파일(−65L)뿐. mcp dist 클린리빌드 1회. 남은 mcp 동명 쌍 10개.

## fire 30 · 2026-06-14 · skill v1.14.0 · e7a54892
meta: kind=prune · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 984→983 (−1 strict-subset 삭제) · netCoverage 0 (진짜 중복) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `reflections-store` **clean PRUNE**(5번째 mcp 쌍) — 자기개선 reflections 저장소(addReflections/listReflections/readReflections)를 콜로케이트 src/(4케이스)와 test/(9케이스)가 둘 다 실행. test/가 src/의 **strict superset**(add+round-trip·정규화-insight dedupe·newest-first·tolerant/tamper-filter read 전부 동등-이상 + 유니크: in-batch dedupe·empty-list·MAX_REFLECTIONS recency-cap) → src/ 삭제, 이식 0.
- **왜:** 같은 모듈 두 파일 중복 실행. test/가 모든 행동 더 강하게 + cap/in-batch까지.
- **어떻게-증명(MUTATION-FIRST PRUNE):** 생존 test/ cite — normalize에서 `toLowerCase` 제거 시 dedupe 2케이스 RED; newest-first sort 깨면 list+recency-cap RED; read 검증 필터 제거 시 tamper 케이스 RED(judge가 3 mutation 재현). ④b 독립 Opus judge가 삭제본 4 행동 전수 매핑(corrupt-row `{id:"bad"}`·bare`99`는 isReflection·`typeof!=="object"`로 동등 필터 확인, MISSING 없음) → **VERDICT: PASS**.
- **리스크:** 소스 무변경, 삭제 1파일(−62L)뿐. mcp dist 클린리빌드 1회. ★이번 fire scout 비용 큼(redactSecretsInText connection-uri ADD가 goal-309로 既커버라 redundant→폐기; shared 암호/redaction 전수 커버 확인). 남은 mcp 동명 쌍 9개.

## fire 31 · 2026-06-14 · skill v1.14.0 · babadfef
meta: kind=add · pkg=@muse/model · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 985 (케이스 +1, 파일수 불변) · netCoverage +2 (mixed-array filter + original-index id) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `parseOpenAIToolCalls`(provider-openai-parse.ts, 새 머지 모듈 — OpenAI tool-call 파싱)의 **mixed-array robustness + original-index id** 커버 추가. flatMap이 malformed 엔트리(non-record·function non-record·name 비-string)를 드롭하고 누락 id를 `tool_call_<원본배열index>`로 기본값. 기존 테스트는 단일 valid 엔트리(id→tool_call_0)·non-array/empty 가드만 — 혼합 배열 per-entry 드롭과 original-index 기본값(tool_call_2)은 미커버.
- **왜:** tool-call 파싱은 grounding/tool 경로(contract 우선순위). OpenAI가 보낸 malformed tool-call 1개가 전체 턴 파싱을 깨면 안 됨(skip). 누락 id의 원본-index 보존도 미묘한 정확성(필터 후 재인덱스 아님).
- **어떻게-증명(MUTATION-FIRST ADD):** name-string 필터 제거 시 `{name:42}`가 출력에 누출 → 새 테스트 RED; `tool_call_${index}`→`tool_call_0` 시 valid 엔트리가 오-id → RED. 각 mutation이 새 테스트만 RED(나머지 10 green = 미커버). ④b 독립 Opus judge가 양 mutation 재현 + 미커버(단일-엔트리/empty만 기존) + 기대값(원본-index 2·explicit call_z·JSON-string+object args 양쪽) 정확성 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, full check GREEN. fire-30 교훈 적용(mutation으로 "기존 테스트가 잡는지" 사전 확인 — 이번엔 진짜 미커버 확정). 새 머지 모듈의 robustness 분기를 pin.

## fire 32 · 2026-06-14 · skill v1.14.0 · 2c0dfc78
meta: kind=add · pkg=@muse/model · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 989 (케이스 +1, 파일수 불변) · netCoverage +2 (nested cached+reasoning 추출) · fabrication 0 · pnpm check FULL GREEN(재실행) + lint 0
- **무엇:** `parseOpenAIUsage`(provider-openai-parse.ts)의 **중첩 cached/reasoning 토큰 추출** 커버 추가(fire-31에 기록한 후보). cachedInputTokens는 `prompt_tokens_details.cached_tokens`, reasoningTokens는 `completion_tokens_details.reasoning_tokens`(중첩 sub-object)에서, input/output는 flat. 기존 테스트는 flat 필드만 넘겨 input/output만 `toMatchObject` → 중첩 cached/reasoning 미커버.
- **왜:** 토큰 회계(cost/usage 추적). 중첩 추출이 flat-read로 회귀하면 캐시/추론 토큰이 조용히 0/undefined — 비용 부정확. `toEqual` 전체-객체로 4필드 모두 pin.
- **어떻게-증명(MUTATION-FIRST ADD):** `value.prompt_tokens_details`→`value`(cached flat read) 시 cachedInputTokens undefined → 새 테스트 RED; `value.completion_tokens_details`→`value` 시 reasoningTokens undefined → RED. 각 mutation이 새 테스트만 RED(나머지 11 green = 미커버). ④b 독립 Opus judge가 양 mutation 재현 + 미커버(flat-only 기존) + 기대값 정확성 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. ★`pnpm check` 1차 SIGABRT 134(동시-루프 OOM/abort) — 재실행 시 FULL GREEN(2641 cli pass). 부하 아티팩트, 본 슬라이스 무관([[project_stale_dist_from_loop]] 부류). provider-openai-parse 모듈 커버 완료(4 함수 전 분기).

## fire 33 · 2026-06-14 · skill v1.14.0 · 06b53b5c
meta: kind=prune(consolidate) · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 993→992 (−1 통합, 유니크 task 케이스 3 이식) · netCoverage 0 (overlap 제거, task 가드 보강) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `briefing-imminent` **통합**(6번째 mcp 쌍) — deriveBriefingImminent(task)+deriveCalendarBriefingImminent(calendar)를 콜로케이트 src/(4케이스)·test/(8케이스)가 둘 다 실행. test/가 calendar 전부 + task positive/done/no-due/proactive/far 동등-이상. src/ 유니크 task 3개(past-due `dueMs<nowMs` 하한·unparseable `Number.isNaN(dueMs)`·finite leadMinutes 창 축소)만 test/로 이식, src/ 삭제.
- **왜:** proactive 임박 브리핑(task+calendar) 두 파일 중복. test/가 calendar superset이나 task의 하한/NaN/custom-lead는 미커버였음 — fail-soft 가드 손실 금지.
- **어떻게-증명(MUTATION-FIRST):** 하한 `dueMs<nowMs` 제거 시 past 누출 RED; NaN 가드 제거 시 unparseable 누출 RED; cutoff가 custom lead 무시(`DEFAULT_LEAD_MINUTES`) 시 leadMinutes:30 케이스 RED. ★judge가 leadMinutes를 "equivalent"로 통과시켰으나 maker가 gap 발견(test/의 유일 lead 테스트=NaN→120이 "lead 하드코딩 120" mutation과 일치해 못 잡음) → 보수적으로 추가 이식+mutation 증명. ④b 독립 Opus judge가 삭제본 전 행동 매핑(MISSING 없음) + 2 mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스 무변경. 변경 −89L(src/ 삭제) +12L(이식 3케이스). mcp dist 클린리빌드 1회. 교훈: judge가 "equivalent"라 해도 mutation으로 직접 검증(coincidental-default가 mutation을 가릴 수 있음). 남은 mcp 동명 쌍 8개.

## fire 34 · 2026-06-14 · skill v1.14.0 · 39f030ce
meta: kind=prune · pkg=@muse/messaging · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 994→993 (−1 subset 삭제, 1 assert 강화-이식) · netCoverage 0 (진짜 중복) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** messaging 동명 쌍 `pending-approval-store` **PRUNE**(messaging 2번째 쌍) — 승인대기 액션 store(record/read/list/clear)를 콜로케이트 src/(6케이스)·test/(17케이스)가 둘 다 실행. test/가 src/ superset(record+list·expired-filter+strict-> boundary·channel-scope+newest-sort·clearById 3케이스·tolerant read+quarantine·filterUnexpired pure+immutability+200-cap). src/ case1 re-run-args round-trip은 verbatim filter라 mutation-비검출이나, 손실 0 위해 test/ worklist 케이스에 `toMatchObject({tool,arguments})` 강화-이식 후 src/ 삭제.
- **왜:** 같은 store 두 파일 중복. test/가 모든 행동 더 강하게 커버. re-run payload round-trip(승인 시 액션 재실행)은 store의 핵심이라 명시 assert 보존.
- **어떻게-증명(MUTATION-FIRST PRUNE):** 생존 test/ cite — isPendingApproval arguments 검증 제거 시 "drops malformed" RED; expired-filter 제거/sort 역전 시 worklist+boundary+sort 4케이스 RED. ④b 독립 Opus judge가 삭제본 6 케이스 전수 매핑(전부 equal-or-stronger, MISSING 없음) + 3 mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스 무변경, 삭제 1파일(−91L) + test/ 강화(+9L). messaging dist 클린리빌드 1회. 남은 messaging 동명 쌍 2개(channel-approval-gate·provider-helpers).

## fire 35 · 2026-06-14 · skill v1.14.0 · 4f983165
meta: kind=add · pkg=@muse/observability · verdict=PASS · firesSinceDrill=0 (★JUDGE-DRILL 완료 리셋)
ratchet: testFiles 997 (케이스 +1, 파일수 불변) · netCoverage +1 branch (reset-before-validity ordering) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **★JUDGE-DRILL(연속 allPASS=8 도달, 미루기 불가):** budget-tracker에 type/enum-only inert ADD 주입(status∈{ok,warning,exceeded}·currentCost typeof number만 assert — 타입시스템이 보장, 어떤 mutation도 RED 안 됨). 독립 ④b Opus judge가 **VERDICT: FAIL**(2 mutation 모두 green 유지 + sibling 테스트가 실제 행동 이미 커버 지적) → 제거. maker≠judge 게이트 신뢰성 재확인 → 카운터 0 리셋.
- **무엇(진짜 슬라이스):** `MonthlyBudgetTracker.recordCost`(budget-tracker.ts, 비용/예산 정책)의 **reset-before-validity ordering** 커버 추가. recordCost는 resetIfNewMonth를 비-유효 cost 검증보다 *먼저* 실행 — 새 달 첫 op이 NaN/음수 cost면 이전 달의 "exceeded"가 아니라 fresh $0 달의 "ok"를 반환해야 함. 기존 테스트는 같은-달 내 비-유효 cost·currentCost/snapshot 경유 roll만 — 이 ordering edge 미커버.
- **왜:** 예산 게이트가 읽는 status(돈-인접). ordering 버그면 새 달이 이전 달 exceeded로 잘못 보고 → 정상 예산을 차단. 문서화된 미묘 edge.
- **어떻게-증명(MUTATION-FIRST ADD):** 검증을 resetIfNewMonth보다 *앞으로* swap 시 새 테스트만 RED(`'exceeded' to be 'ok'`, 나머지 6 green). ④b 독립 Opus judge가 mutation 재현 + ordering 미커버 + 기대값(120→exceeded·June NaN→ok·currentCost 0) 정확성 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, full check GREEN. 새 머지 모듈(budget-tracker)의 문서화 ordering edge를 pin.

## fire 36 · 2026-06-14 · skill v1.14.0 · 9a68156f
meta: kind=prune · pkg=@muse/autoconfigure · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 998→997 (−1 strict-subset 삭제) · netCoverage 0 (진짜 중복) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** autoconfigure 동명 쌍 `response-filters` **clean PRUNE**(autoconfigure 첫 쌍) — `responseLocales`(MUSE_RESPONSE_LOCALES→{ko,en} 파싱, grounding 인접 로케일 게이트)를 콜로케이트 src/(5케이스, responseLocales만)·test/(12케이스, responseLocales 4 + createResponseFilters 8)가 둘 다 실행. test/가 src/ responseLocales 전부 동등-이상(default/single/case-whitespace/mixed-drop/fallback) → src/ 삭제, 이식 0.
- **왜:** 같은 모듈 두 파일 중복. test/가 responseLocales 전부 + createResponseFilters까지 더 강하게 커버.
- **어떻게-증명(MUTATION-FIRST PRUNE):** ★fire-33 교훈 적용 — src case5의 "   "(공백) sub-case가 distinct branch인지 직접 검증. parseCsv("   ")=undefined → `?? ["ko","en"]` default(unset과 *동일* branch); "english"/"fr,de"는 size===0 fallback("fr,english"가 커버). "   "만 RED시키는 single-line mutation 없음 → 진짜 redundant. 생존 test/ cite: ko/en 인식 제한 제거 시 2케이스 RED, size===0 fallback 제거 시 fallback RED. ④b 독립 Opus judge가 parseCsv 분석 확인 + 5 케이스 전수 매핑(MISSING 없음) + mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스 무변경, 삭제 1파일(−32L)뿐. autoconfigure dist 클린리빌드 1회. (fire-33는 leadMinutes가 진짜 gap이었고, 이번 "   "는 진짜 redundant — 매번 mutation으로 직접 판별이 정답.)

## fire 37 · 2026-06-14 · skill v1.14.0 · baaed7e9
meta: kind=add · pkg=@muse/memory · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 998 (케이스 +1, 파일수 불변) · netCoverage +1 branch (DECISION_HINTS break) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `scoreMessageContent`(message-importance.ts, 트리밍/compaction 중요도 스코어)의 **DECISION_HINTS `break`** 커버 추가. 결정-힌트 루프는 첫 매치서 +0.2 후 break — 여러 결정어가 있어도 +0.2 *한 번*(누적 아님). 기존 decision-vocab 테스트는 전부 단일-힌트 메시지라 break 미커버.
- **왜:** 트리밍 중요도 정확도(여러 결정어 메시지가 과대-점수 받으면 안 됨). 이미 exhaustively 커버된 모듈(plain-assistant bonus·matchableHint≥3·per-role exact·unknown-role·recency 등 prior loop가 pin)에서 남은 분기.
- **어떻게-증명(MUTATION-FIRST ADD):** "we decided and agreed on the plan"(decided+agreed 둘 다 hint)이 base 0.1+user 0.2+decision 0.2=**0.5**. `break` 제거 시 누적되어 0.7 → 새 테스트만 RED(17 green = 미커버). ④b 독립 Opus judge가 mutation 재현 + 미커버(기존 split-combine 테스트는 동등성만 assert, cap값 아님) + 0.5 산술 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경, full check GREEN. ★신호: message-importance는 prior loop가 거의 완전 커버 — 성숙 모듈 ADD vein 희박, break 같은 잔여 분기만 남음.

## fire 38 · 2026-06-14 · skill v1.14.0 · 0141d676
meta: kind=prune(consolidate) · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 999→998 (−1 통합, 유니크 케이스 1 이식) · netCoverage 0 (overlap 제거) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `objective-evaluation-loop` **통합**(7번째 mcp 쌍) — standing-objective 재평가 엔진 `runDueObjectives`를 콜로케이트 src/(6케이스)·test/(10케이스)가 둘 다 실행. test/가 src/ 행동 전부 동등-이상(met→act+done·unmet→backoff·unmeetable→escalate+sink·maxAttempts·fail-open throwing-evaluator+sibling) 1개 빼고 커버. src/ 유니크 1개("act() throws on MET → fired 아님·done 아님·active 유지")만 이식, src/ 삭제.
- **왜:** 같은 엔진 두 파일 중복. ★중요 fail-open: 조건은 met이나 act()(메신저)가 실패하면 objective를 done 마킹하면 안 됨(안 그러면 액션 영영 재시도 안 함). test/엔 이 act-throws 케이스 없었음.
- **어떻게-증명(MUTATION-FIRST):** act() 호출을 status:"done"+fired.push *뒤로* 이동(act 던져도 이미 done) 시 이식 케이스 RED(`fired ['o1'] != []`). ★judge가 contested claim 2개(escalate-sink·throwing-evaluator) test/ line 52-61·132에서 실제 assert됨을 소스 읽어 검증. ④b 독립 Opus judge가 6 행동 전수 매핑(MISSING 없음) + mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스 무변경. 변경 −180L(src/ 삭제) +12L(이식 1케이스). ★교훈: src 6케이스 중 5개가 test/에 既커버(특히 throwing-evaluator·escalate-sink) — "유니크처럼 보임"을 케이스 단위로 test/ 실제 assert와 대조해야(swarm/briefing처럼 과대-이식 회피). 남은 mcp 동명 쌍 7개.

## fire 39 · 2026-06-14 · skill v1.14.0 · fc42e46b
meta: kind=add · pkg=@muse/recall · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1001 (케이스 +1, 파일수 불변) · netCoverage +1 branch (per-claim untrusted) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `untrustedOnlyGroundingNotice`(grounding-notices.ts, 새 머지 grounding 표면)의 **per-claim untrusted-source 분기** 커버 추가. 두 분기 중 (1)whole-answer 게이트(전 인용 untrusted)는 기존 테스트 커버, (2)MIXED 답변 per-claim(전체 게이트는 trusted 1개로 통과하나 특정 claim이 poisonable tool 소스에만 의존 — grounded≠true 핵심 edge)은 미커버였음.
- **왜:** Muse 핵심 edge(grounded≠true). 신뢰 note + 오염가능 tool 소스가 섞인 답변에서 whole-answer 게이트가 놓치는 per-claim 위험을 표면화 — 이게 회귀하면 poisoned tool claim이 조용히 "grounded"로 넘어감. grounding 경로 contract 최우선.
- **어떻게-증명(MUTATION-FIRST ADD):** ★사전 probe(dist 직접 실행)로 mixed 시나리오가 per-claim 통지를 내는지 확인 후 작성. per-claim 블록 제거 시 mixed 답변이 undefined 반환 → 새 테스트만 RED(6 green). ④b 독립 Opus judge가 소스 trace로 2번째 분기 적중(whole-answer 아님) 확인 + 미커버 + mutation 재현 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경(grounding eval 신호 영향 0). probe-first로 dependency-coupled 분기(agent-core groundedOnUntrustedOnly/untrustedOnlySentences)를 검증 후 안정적 assert(template text + claim, exact-truncation 회피). 남은 후보: citationPrecision/Recall 80-char 절단(향후 ADD).

## fire 40 · 2026-06-14 · skill v1.14.0 · 6effb6fb
meta: kind=prune(consolidate) · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1003→1002 (−1 통합, 유니크 케이스 2 이식) · netCoverage 0 (overlap 제거) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `web-action-tool` **통합**(8번째 mcp 쌍) — web_action execute-risk outbound 도구를 콜로케이트 src/(12케이스, SSRF×4·DNS-rebinding·method-validation 보안 풍부)·test/(5케이스)가 둘 다 실행. src/가 test/ 행동 동등-이상(reject-empty/needs-url·confirmed POST-uppercased·denied→reason) — 2개 빼고. test/ 유니크 2개(tool-calling 신뢰성: validateToolDefinitions-clean+additionalProperties:false+한국어 선택 키워드 "예약" · description "use when/do not read/payments")만 이식, test/ 삭제.
- **왜:** 같은 도구 두 파일 중복. src/가 보안(SSRF) 훨씬 강하나, test/의 tool-calling 신뢰성(스키마 clean·키워드·use-when/not — tool-calling.md #1 관심사)은 src에 없었음.
- **어떻게-증명(MUTATION-FIRST):** "예약" 키워드 제거 시 migrated case1 RED; description "do not use to read" 약화 시 migrated case2 RED — 각 자기 케이스만. ④b 독립 Opus judge가 삭제본 5 행동 전수 매핑(전부 equal-or-stronger, MISSING 없음 — needs-url/method-uppercase/denied 既커버 확인) + 2 mutation 재현 → **VERDICT: PASS**.
- **리스크:** 소스 무변경. 변경 −77L(test/ 삭제) +18L(이식 2케이스+`@muse/tools` import). @muse/tools는 mcp package.json에 이미 있음(test 파일은 vitest 컴파일이라 tsconfig refs 무관, pnpm check FULL GREEN). 남은 mcp 동명 쌍 6개.

## fire 41 · 2026-06-14 · skill v1.14.0 · ef3ca554
meta: kind=prune(consolidate) · pkg=@muse/mcp · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1005→1004 (−1 통합) · netCoverage +1 (draft-first 더 강해짐) − 6 중복(double-run) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** mcp 동명 쌍 `web-action`(performWebActionWithApproval, outbound-safety 코어) **통합**(9번째 mcp 쌍) — 콜로케이트 src/(14케이스: SSRF redirect·429 retry·timeout·redaction 풍부)·test/(7케이스)가 둘 다 같은 모듈 실행. src/가 test/ 7행동을 전수 동등-이상 커버, 단 하나 — test/ case1의 **draft-first**(승인 게이트가 정확한 action=summary를 본다, outbound-safety rule 1)만 src에 없었음. 그 한 assert만 src에 이식(이제 summary만이 아니라 request 전체를 toEqual로 검증 — 더 강함) 후 test/ 삭제.
- **왜:** 같은 모듈 두 파일 double-run. src/가 보안(SSRF·redirect·redaction·429) 훨씬 풍부하나, draft-first(게이트가 *전송 전 정확한 내용*을 사용자에게 보임 — outbound-safety의 1번 규칙)는 test/만 검증했음. 조용히 떨어뜨리면 마지막 보호선 손실.
- **어떻게-증명(MUTATION-FIRST):** (A) gate에 넘기는 summary를 "MUTANT"로 변형 → 이식한 draft-first 케이스만 RED(`expected 'MUTANT' to be 'Book a table, 7pm'`), 나머지 1853 green. (B) `redactSecretsInText` 우회 변형 → 생존 src "scrubs secrets" 케이스 RED(삭제본 case7이 덮던 redaction이 여전히 가드됨). ④b 독립 Opus judge가 삭제본 7 행동 전수 매핑(전부 equal-or-stronger, DROPPED 없음) + 두 mutation 재현(의도한 케이스만 적중) → **VERDICT: PASS**.
- **리스크:** 소스 무변경(grounding/eval 신호 영향 0). 변경 −97L(test/ 삭제) +13L(draft-first 이식+`WebActionRequest` import). draft-first는 outbound-safety 불변식이라 단순 동등이식이 아니라 더 강한 형태로 보존. anthropic-key redaction은 mcp.test.ts:9282에도 독립 커버 존재(judge 확인). 남은 mcp 동명 쌍 5개.

## fire 42 · 2026-06-14 · skill v1.14.0 · c45af7fb
meta: kind=add · pkg=@muse/tools · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1007 (케이스 +1, 파일수 불변) · netCoverage +1 branch (isFinite-false 분기) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `coerceToolArguments`→`coerceScalar`(tools-argument-validation.ts, tool-arg "repair")의 **`Number.isFinite(n)` 가드 분기** 커버 추가. 패턴은 통과하나 오버플로하는 숫자열(`"9".repeat(400)` — `/^-?\d+$/` 매치하지만 `Number()`가 ±Infinity, > MAX_VALUE)을 문자열 그대로 남김(비유한수로 강제하지 않음). integer/number/음수 3 케이스.
- **왜:** tool-calling 신뢰성(tool-calling.md #1 — 로컬 8B가 인자를 한 방에). 가드 없으면 거대 정수열이 Infinity로 강제돼 execute()에 비유한수가 도달(math/indexing/slice 깨짐) — Structured Reflection(arXiv:2509.18847) "lossy guess로 진짜 불일치를 가리지 말라"의 정확한 사례. 기존 coerce 테스트(339-374)는 작은 clean 값만 써 isFinite-false 분기 미커버.
- **어떻게-증명(MUTATION-FIRST ADD):** 가드 제거(`if (Number.isFinite(n)) return n;`→`return n;`) 시 새 케이스만 RED(`expected { count: Infinity } to deeply equal { count: "999…" }`, 218 green). 사전 node로 `"9".repeat(400)`가 양 패턴 매치 + Number→Infinity + isFinite false 확인(regex 거부 아님 — isFinite 분기 정확 타격). ④b 독립 Opus judge가 mutation 재현(오직 그 케이스) + 사전 미커버 + outcome-based 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. coerceScalar는 결정적 repair 헬퍼(tool 선택/스키마 경로 아님) → eval:tools 신호 무영향(LOCAL-OLLAMA, 미실행). KIND/pkg(add@tools)가 최근 mcp-prune 연속(40/41)에서 다양화. 남은 후보: coerceScalar boolean 대문자/혼합("True"→미강제) 경계, validateRequired null-vs-undefined.

## fire 43 · 2026-06-14 · skill v1.14.0 · dc435984
meta: kind=prune(consolidate) · pkg=@muse/autoconfigure · verdict=PASS · firesSinceDrill=0 (★JUDGE-DRILL 완료 리셋)
ratchet: testFiles 1008→1007 (−1 통합) · netCoverage 0 (subset 제거 + 더 richer 이식) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇(★JUDGE-DRILL fire):** 먼저 고의 inert ADD 주입(`coerceToolArguments`가 `toBeTypeOf("object")`+`toHaveProperty` 3개만 검증 — `{...args}` spread라 coercion 깨져도 항상 통과). 별개 Opus ④b judge가 no-op-coercion mutation 돌려 "planted만 green, 진짜 coerce 테스트는 RED" 확인 → **FAIL** 판정(inert/tautological). 롤백 후 진짜 슬라이스: autoconfigure 동명 쌍 `provider-utils` **통합** — test/(clampPositive만 5케이스, base-10 parseInt 핀닝 유니크)·src/(clampPositive 2 약한 케이스 + readCredentialsSync 4 + stringField 2)가 clampPositive를 double-run. test/의 richer 5를 src로 이식(단일 홈)하고 test/ 삭제.
- **왜:** ⑴ JUDGE-DRILL 하드-카운터(firesSinceDrill 8, 연속 allPASS 7→8 cadence) — maker≠judge 보상통제가 살아있음을 증명(judge가 inert를 실제로 잡나). ⑵ clampPositive 중복 실행 제거. src/가 readCredentialsSync/stringField 유니크라 src를 홈으로, test/의 유니크 base-10 핀닝을 이식해 보존.
- **어떻게-증명:** [드릴] no-op coercion(`const coerced = undefined`) 시 planted inert 케이스 green 유지(진짜 2 케이스만 RED) → judge가 독립 재현해 FAIL. [진짜] 통합 src 블록에 mutation 2개: parseInt radix 제거 → base-10 케이스 RED(이식된 유니크 커버가 src에서 live); 비양수 가드 제거 → 비양수 fallback 케이스 RED. ④b judge가 삭제본 6 행동 전수 매핑(base-10 verbatim 이식, DROPPED 없음) + 2 mutation 재현 + readCredentialsSync/stringField intact → **VERDICT: PASS**.
- **리스크:** 소스 무변경. 드릴은 커밋 안 됨(롤백). 통합으로 clampPositive 단일 홈(src), 11케이스 127ms. 남은 동명 쌍: agent-core/model/messaging은 대부분 complementary(양쪽 substantial, subset 아님 — council 66/50, correction-distiller 21/63). clean-subset prune vein 고갈 신호 — 다음은 ADD/FIX 우선.

## fire 44 · 2026-06-14 · skill v1.14.0 · 4cace6bf
meta: kind=add · pkg=@muse/recall · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1009 (케이스 +1, 파일수 불변) · netCoverage +1 branch (importance bump) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `rankEpisodeHits`(recall/select.ts, 에피소드 recall 랭킹)의 **importance bump 분기** 커버 추가. Generative Agents(arXiv:2304.03442) 점수 = cosine + importance + recency 가산 bump인데, 기존 3 테스트(cosine·topK=0·recency)는 importance-free 에피소드만 써 importance 항이 항상 0이라 미커버. 동일 cosine([1,0,0])·무타임스탬프 두 에피소드를 importance 1 vs 10로, 고importance를 입력 2번째에 배치.
- **왜:** grounding/recall 랭킹 경로(에피소드 회상이 cited recall의 근거). importance bump가 회귀하면 "중요한 과거 세션"이 동률 relevance에서 안 떠 사용자 이력 grounding이 약해짐. 3 가산 항 중 하나가 dead-to-coverage였음.
- **어떻게-증명(MUTATION-FIRST ADD):** importanceBump=0 변형 시 새 케이스만 RED(`expected 'trivial' to be 'important'` — bump 없으면 stable sort가 입력순 유지해 2번째 'important'가 안 올라옴, 8 green). cosine 동일+recency 0(무 endedAt)이라 importance가 유일 차별자 — 입력순/cosine confound 없음(2번째 배치로 stable-sort 방어). ④b 독립 Opus judge가 mutation 재현(오직 그 케이스) + 격리 검증(confound 없음, V8 stable sort) + 사전 미커버 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. rankEpisodeHits는 순수 랭킹 헬퍼(런타임 LLM grounding 게이트 아님) → eval:agent 신호 무영향(test-only). KIND/pkg(add@recall)가 fire 43(prune@autoconfigure)·41(prune@mcp)에서 다양화. 남은 select.ts 후보: episodeRecencyScore 미래-타임스탬프 클램프(Math.max(0)), formatContactBirthday 하한 경계(month<1/day<1).

## fire 45 · 2026-06-14 · skill v1.14.0 · 998603a5
meta: kind=add · pkg=@muse/agent-core · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1012 (케이스 +1, 파일수 불변) · netCoverage +1 branch (tie-break) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `worstUnsupportedSentence`(agent-core/sentence-groundedness.ts, grounding 진단)의 **동률 tie-break 분기** 커버. 동률 coverage에서 strict `<`가 FIRST 문장을 유지("ties resolve to earliest" 계약) — 진단 포인터가 문장 순서와 무관하게 결정적. 기존 3 케이스(all-supported→undefined·empty→undefined·서로 다른 coverage 0 vs 0.5)는 동률을 안 먹여 이 분기 미커버. 완전 fabricated 두 문장(둘 다 coverage 0) → earliest("Dragons") 반환 검증.
- **왜:** worstUnsupportedSentence는 un-groundable claim의 진단/연료 포인터(self-improvement fuel). tie-break가 회귀하면(< → <=) 같은 답변에서 가리키는 문장이 순서 따라 바뀌어 진단이 비결정적 — 재현 가능한 grounding 진단 계약.
- **어떻게-증명(MUTATION-FIRST ADD):** `<` → `<=` 변형 시 새 케이스만 RED(`expected 'Unicorns…' to contain 'Dragons'` — 동률에서 later 문장으로 교체됨, 12 green). 두 문장이 evidence("lions hunt animals africa")와 토큰 0 공유 → 둘 다 coverage 0 진짜 동률(report.unsupported===2 동시 assert). ④b 독립 Opus judge가 mutation 재현(오직 그 케이스) + tie 진위(둘 다 0) + 사전 미커버 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. worstUnsupportedSentence는 순수 진단 헬퍼(런타임 LLM 게이트 아님) → eval 신호 무영향. KIND/pkg(add@agent-core)가 새 패키지로 다양화 — 단 최근 3 = add/prune/add라 ADD 3회째(judge가 약하게 지적); 다음 fire는 prune/fix 우선. 남은 후보: groundToolArguments는 19케이스로 매우 풍부, sentence-groundedness reportSentenceGroundedness floor 경계는 커버됨.

## fire 46 · 2026-06-14 · skill v1.14.0 · c8ebc826
meta: kind=add · pkg=@muse/recall · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1015 (케이스 +1, 파일수 불변) · netCoverage +1 (formatContactBirthday 하한 가드 month<1/day<1) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `formatContactBirthday`(recall/select.ts, 연락처 생일 grounding)의 **하한 경계 가드** 커버. 기존 malformed 테스트는 "99-99"(상한: month>12 AND day>31)만 먹여 하한(month<1/day<1) 미커버. "00-15"→month 0→BIRTHDAY_MONTHS[-1]→빈 월(" 15"), "03-00"→"March 0" — grounding 블록에 쓰레기 날짜 렌더됨. 새 케이스가 00-15/2026-00-15/03-00 모두 undefined 검증.
- **왜:** grounding-integrity 플로어(소스에 fabricated/garbage 날짜 금지). 하한 가드 회귀 시 malformed 생일이 정상 날짜처럼 grounding 블록에 들어가 "X의 생일은 ?월 15일" 류 쓰레기 근거 생성. no-garbage-source 계약.
- **어떻게-증명(MUTATION-FIRST ADD):** 하한 둘 제거(`month<1 || ... || day<1 ||` → 상한만) 시 새 케이스만 RED(`expected ' 15' to be undefined`, 기존 "99-99"는 green 유지=하한 진짜 미커버), 262 green. ④b 독립 Opus judge가 두 서브분기(month<1·day<1) 각각 독립 격리 mutation + regex가 numeric 체크 도달 + 사전 미커버 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. ★다양성 주의: recall 2회 연속(44,46)·ADD 3회 연속(44,45,46) — ratchet(pkg,KIND≥6/8)은 recall-add 3/8로 미발동이나 judge가 집중 지적. **다음 fire는 반드시 다른 패키지+다른 KIND**(mcp/cli/messaging/shared 등 + prune 후보 재탐색 or fix). prune/fix vein은 fire45에서 고갈 확인 → ADD 위주 불가피하나 패키지 분산 필요.

## fire 47 · 2026-06-14 · skill v1.14.0 · d4848df9
meta: kind=add · pkg=@muse/memory · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1016 (케이스 +1, 파일수 불변) · netCoverage +1 (CJK 3개 서브레인지 버킷팅) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `computeApproximateTokens`(memory/token-estimator.ts, 트림 예산용 토큰 추정)의 **isCjkCodePoint 4개 레인지 중 비-Hangul 3개**(중국어 표의문자 U+4E00–9FFF·히라가나 U+3040–309F·가타카나 U+30A0–30FF) 버킷팅 커버. 기존 CJK 테스트는 Hangul(한/안녕/일이삼사오)만 써 나머지 3 레인지 미커버. CJK는 ~3자/2토큰 비율 floor((n*2+1)/3); 레인지 회귀 시 /3 "other" 버킷으로 떨어져 다국어 텍스트가 과소계수→트림 예산 초과. 中文字=2/ひらがな=3/カタカナ=3 검증.
- **왜:** 트림 예산 게이트(contract priority 트리밍)의 정확도. 누군가 isCjkCodePoint 리팩터로 한 레인지를 빠뜨리면 중국어/일본어 대화가 실제보다 작게 계수돼 트림이 컨텍스트를 넘기거나 잘못 예산. 다국어 토큰-예산 정확성 계약.
- **어떻게-증명(MUTATION-FIRST ADD):** 3개 레인지 각각 독립 제거 mutation → 해당 스크립트 assertion만 RED(중국어→`expected 1 to be 2`, 히라가나/가타카나→`expected 1 to be 3`; other 버킷으로 collapse), 기존 Hangul 케이스는 매번 green(426 pass). ④b 독립 Opus judge가 3 레인지 각각 격리 재현 + 산술 검증(other 버킷 값 다름) + 사전 미커버(Hangul만) 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. 테스트 문자열은 CJK 문자(raw control/zero-width 아님)→byte-hygiene 무관. ★다양성: ADD 4연속(44-47)이나 패키지는 memory(신규, 최근 미접촉)로 분산 — judge 수용하되 5연속 ADD면 prune/fix vein 재확인 권고. 이번 fire 광범위 스카웃(mcp weather·model local-only·shared crypto·memory message-importance/recall-promotion·messaging retry)으로 코드베이스 exhaustive 커버 재확인 — clean-subset prune·slow-test fix vein 고갈; 남은 가치는 미묘한 분기 ADD.

## fire 48 · 2026-06-14 · skill v1.14.0 · e4348500
meta: kind=prune(consolidate) · pkg=@muse/api · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1018→1017 (−1 통합) · netCoverage 0 (overlap 제거 + 유니크 케이스 이식·강화) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** apps/api 동명 쌍 `mcp-routes-shapers` **통합** — 콜로케이트 src/(9케이스: sendMcpError + 7개 shaper)·test/(3케이스: sendMcpError만)가 sendMcpError를 double-run. test/ 3 중 2개(409·Error-500-no-leak)는 src/가 이미 커버, 유니크 1개(NON-Error 던져진 값=raw string → generic 500, raw값 누출 안 함)만 src로 이식(원본보다 강화: `not.toContain("/secret/path")` 누출 assert 추가) 후 test/ 삭제. ★4연속 ADD 후 KIND 다양화(prune) + 새 패키지(apps/api, 루프 첫 접촉).
- **왜:** 같은 함수 두 파일 중복 실행. sendMcpError의 else-분기는 ANY non-McpRegistryError를 받는데(하드코딩 generic msg, .message 미접근), src/는 Error만 테스트해 non-Error throwable의 누출-안전이 미커버였음 — 보안(내부정보 네트워크 누출 방지) 계약의 빈틈.
- **어떻게-증명(MUTATION-FIRST consolidate):** else-분기를 non-Error만 누출(`message: error instanceof Error ? "MCP operation failed" : String(error)`)로 변형 시 이식한 non-Error 케이스만 RED(`message: "raw string with /secret/path"` 누출), Error-500 케이스는 green 유지 → 이식 케이스가 non-Error 경로의 유일 가드(Error 케이스와 비중복). ④b 독립 Opus judge가 삭제본 3 행동 전수 매핑(409·Error-500 생존, non-Error 이식·강화, DROPPED 없음) + mutation 격리(non-Error만 red) + 사전 미커버(src 원본은 Error만) 확인 → **VERDICT: PASS**.
- **리스크:** 소스 무변경. 누출-방지 보안 불변식 보존(강화). ★발견: 최근 머지가 새 동명 쌍 유입(apps/api 4개·mcp consented-action/email-send 등) — prune vein이 apps/api·신규 코드로 부분 재개통. 단 대부분 complementary(agent-core council 66/50 등); apps/api compat-parsers·mcp-routes 계열이 다음 prune 후보. 남은 apps/api 쌍: compat-parsers(11/8)·compat-run-aggregations(8/3)·mcp-routes-parsers(6/4).

## fire 49 · 2026-06-14 · skill v1.14.0 · 5246c6af
meta: kind=prune(consolidate) · pkg=@muse/api · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1019→1018 (−1 통합) · netCoverage +3 branch (5-30s·30s+·NaN을 single home으로 회수) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** apps/api 동명 쌍 `compat-run-aggregations` **통합**(2번째 apps/api 쌍) — 콜로케이트 src/(8케이스: latencyDistribution + 7 aggregation)·test/(3케이스: latencyDistribution만)가 double-run. ★단순 subset 아님: src/의 단일 latency 케이스는 0-1s·1-5s·missing만 커버, 삭제 대상 test/가 **5-30s·30s+ 4버킷 전부 + NaN(Invalid-Date 뺄셈→unknown) 분기**를 추가 커버 — 즉 그 3 분기는 double-run 파일에만 있었음. src/ 약한 케이스를 test/의 richer 3케이스(all-4-buckets·missing·NaN, src의 run() 헬퍼로)로 교체 후 test/ 삭제.
- **왜:** 같은 함수 double-run 제거 + 동시에 test/-only였던 3 분기(5-30s/30s+/NaN)를 single home으로 회수. 순수 삭제였으면 그 3 분기 커버 손실(특히 NaN→unknown은 관측성 대시보드가 Invalid-Date 런을 30s+로 오분류 안 하게 막는 가드).
- **어떻게-증명(MUTATION-FIRST consolidate):** (A) isFinite NaN 가드 제거 시 NaN 케이스 RED(unknown 3→0, 30s+로 샘); (B) `<30_000`→`<300_000` 시 all-4-buckets 케이스 RED(60s런이 30s+ 이탈); (C) `<5_000`→`<50_000` 시도 5-30s 경계 격리 확인. 각 분기 mutation-killing. ④b 독립 Opus judge가 삭제본 3 행동 전수 매핑(5-30s/30s+/NaN 모두 src에 present) + 각 mutation 격리 + 나머지 7 aggregation 테스트 무회귀 확인 → **VERDICT: PASS**.
- **리스크:** 소스 무변경. 케이스 net +2(1→3 latency), 파일 −1. dist 컴파일 테스트가 vitest에 잡혀 실패시 2건 표시(src+dist, 동일 테스트 — apps/api 기존 dist-test double-run 이슈, 본 슬라이스 무관). 남은 apps/api 쌍: compat-parsers(11/8)·mcp-routes-parsers(6/4) — 다음 prune 후보.

## fire 50 · 2026-06-14 · skill v1.14.0 · d9963a35
meta: kind=add · pkg=@muse/observability · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1020 (케이스 +1, 파일수 불변) · netCoverage +1 branch (stddev floor mean-scaling arm) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `PromptDriftDetector.evaluate`(observability/observability-prompt-drift.ts)의 **flat-baseline stddev floor의 mean-scaling arm** 커버. floor = `Math.max(mean*0.01, 1)`이라 baseline 분산 0일 때 effective σ가 baseline 크기에 비례(평균의 1%). 기존 flat 테스트는 mean=100(`max(100*0.01,1)=1`)이라 두 arm이 1로 degenerate → `mean*0.01` arm 미커버. 큰 flat baseline(mean 1000→floor 10) + +1.5% shift로 drift 없음 검증(1.5σ < 2σ).
- **왜:** 거짓 drift 알람 방지(정책/알림 correctness). floor가 평균에 비례 안 하면(bare-1) 자연스럽게 큰-but-안정적 프롬프트 길이가 작은 상대 변동에도 15σ로 false-alarm. floor가 1%로 스케일해야 large-magnitude 안정 baseline이 비례적으로 큰 shift에서만 알람.
- **어떻게-증명(MUTATION-FIRST ADD):** `mean*0.01` arm 제거(`Math.max(0,1)`=bare-1) 시 새 케이스만 RED(+1.5%가 15σ→input_length drift, σ=1), 기존 mean=100 케이스는 green 유지(degenerate boundary라 scaling arm 미커버 입증). 사전 node로 1.5σ vs 15σ 확인. ④b 독립 Opus judge가 mutation 격리(오직 새 케이스) + 비중복(mean=100 green) + floor 분기 도달(early-return/minSamples gate 아님) 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. KIND/pkg(add@observability)가 fires 48/49(apps/api prune)에서 다양화 — observability는 루프 첫 접촉(신규 패키지). prompt-drift는 src+test/ 두 테스트 파일이 같은 모듈 커버(다른 basename이라 동명쌍 아님; 향후 consolidate 후보일 수 있으나 상보적). 남은 observability 후보: budget-tracker month-rollover, slo-alert cooldown/min-sample.

## fire 51 · 2026-06-14 · skill v1.14.0 · fbf7c7db
meta: kind=prune(consolidate) · pkg=@muse/api · verdict=PASS · firesSinceDrill=0 (★JUDGE-DRILL 완료 리셋)
ratchet: testFiles 1023→1022 (−1 통합) · netCoverage +4 branch (whitespace-trim·extended-rejection·non-string·array-drop을 single home으로 회수) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇(★JUDGE-DRILL fire):** 먼저 고의 inert ADD 주입(observability drift 테스트에 `Array.isArray(anomalies)`+`length>=0`만 검증 — drift 로직 깨져도 항상 통과). 별개 Opus ④b judge가 broken-detection mutation 돌려 "planted만 green, 진짜 drift 9개 RED" 확인 → **FAIL** 판정(inert). 롤백 후 진짜 슬라이스: apps/api 동명 쌍 `compat-parsers` 통합(3번째 apps/api) — src/(readQueryInteger+coerceStringSet+9 parser)·test/(그 2개만)가 double-run. ★fire49처럼 test/가 더 richer: whitespace-trim·extended-rejection(5.9/1e3/1_000/Infinity/NaN/abc/space)·non-string·array-drop이 double-run 파일에만. src/ 약한 2케이스를 test/의 8 richer로 교체 후 test/ 삭제.
- **왜:** ⑴ JUDGE-DRILL 하드-카운터(8-gap: 43→51) — maker≠judge 보상통제 재검증(judge가 inert 잡나). ⑵ double-run 제거 + test/-only 4 분기를 single home으로 회수. 순수 삭제였으면 untrusted-input 정규화 경계(strict integer parse·non-string 거부)의 보안성 커버 손실.
- **어떻게-증명:** [드릴] broken-detection(threshold 무조건 undefined) 시 planted inert 케이스 green 유지(진짜 9개만 RED) → judge 독립 재현 FAIL. [진짜] (A) lenient parseInt 변형 시 extended-rejection 케이스 RED(`"20x" expected 20 to be 30`); (B) array string-filter 제거 시 array-drops-non-string RED(`item.trim is not a function`). ④b judge가 삭제본 전 행동 매핑(4 test/-only 모두 present) + 2 mutation 격리 + 나머지 9 parser 무회귀 확인 → **VERDICT: PASS**.
- **리스크:** 소스 무변경. 케이스 net +6(2→8), 파일 −1. apps/api 남은 동명 쌍: mcp-routes-parsers(complementary 확인 — test/는 parseMcpSecurityPolicyInput, src/는 다른 parser, 동일함수 아님 → prune 불가). apps/api prune vein 이제 거의 소진(3 consolidate 완료). 다음은 ADD 위주 복귀.

## fire 52 · 2026-06-14 · skill v1.14.0 · c249c6d2
meta: kind=add · pkg=@muse/messaging · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1024 (케이스 +1, 파일수 불변) · netCoverage +1 branch (default-case null/undefined 필터; 3-cap 공동검증) · fabrication 0 · pnpm check FULL GREEN + lint 0
- **무엇:** `summarizeToolDraft`(messaging/channel-approval-gate.ts, 채널 승인 프롬프트의 사람-읽는 draft 렌더)의 **default-case null/undefined 값 필터 + 3-entry cap** 커버. 기존 default 테스트는 비-object 2개만 써 (a)`.slice(0,3)` cap·(b)`v!==null&&v!==undefined` 필터 미실행. `{a:1,b:null,c:3,d:undefined,e:5,f:6}` → 정확히 `"a=1, c=3, e=5"`(b/d=null/undefined 드롭, f=cap 드롭) 검증.
- **왜:** 승인 게이트 UX(outbound-safety) — 사용자가 risky tool 승인/거부 판단하려 읽는 draft가 unbounded arg dump면 신호가 묻힘. null/undefined 필터 + 3-cap이 prompt를 signal-dense하게 유지. 정책/게이트 경로(contract priority).
- **어떻게-증명(MUTATION-FIRST ADD):** (A) `.slice(0,3)`→`.slice(0,10)` 시 RED(`f=6` 누출 → `"a=1, c=3, e=5, f=6"`); (B) null/undefined 필터 제거 시 RED(undefined `d` 누출). 둘 다 exact `toBe`로 격리. 기존 line-108 default 테스트는 두 mutation 모두 green 유지(미커버 입증). ④b 독립 Opus judge가 두 분기 격리 재현 + 비중복 + exact assertion 확인 → **VERDICT: PASS**.
- **리스크:** 테스트-only, 소스 무변경. ★judge 발견: 3-cap은 별도 `test/channel-approval-draft.test.ts`가 이미 커버(중복) — 단 **null/undefined 필터 분기는 이 테스트가 유일 가드**라 net-new 커버리지 진짜. KIND/pkg(add@messaging)가 첫 messaging 접촉으로 다양화(fires 49/51 apps/api prune·50 observability add에서). 향후: channel-approval-draft 두 테스트 파일(src+test/, 다른 basename) consolidate 후보일 수 있음.
