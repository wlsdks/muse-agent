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
