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
