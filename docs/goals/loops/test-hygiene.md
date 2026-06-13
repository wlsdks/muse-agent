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
