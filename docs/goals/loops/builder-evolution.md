# builder-evolution loop journal

> 테마: Builder/자동화 트랙 지속 개선 + 사용자 체감 기능 갭 발굴. cron `55ad6e29`(세션, 매시 :23),
> Tier2+(진안 2026-07-18 명시 승인: green일 때만 origin/main push). 중단: CronDelete 55ad6e29.

## fire 1 · 2026-07-18 · skill v2.1.1 · <commit>
meta: value-class=reliability · pkg=@muse/cli · kind=reliability · verdict=PASS · firesSinceDrill=1
ratchet: serve-core tests 22->45 · fabrication 0 · self-eval green(envInventory 등록시 수리 0ff19cd3c)
- 무엇: muse serve 수퍼비전 — 자식 예상외 사망시 지수백오프 재기동(1s..30s, 10분창 5회 서킷브레이크, 60s 생존시 리셋), 시그널이 sleep 갭에 와도 재기동 중단+클린 종료. 순수 policy(nextRestartDecision) 주입시계로 완전 유닛테스트.
- 왜: 2026-07-17/18 라이브에서 3회 문 실결함 — 자식 죽어도 수퍼바이저가 포트 빈 채 대기(좀비 클래스의 뿌리 절반).
- 리뷰지점: exit 0(정상 종료)은 재기동 안 함(restart: on-failure 의미론) — admin/shutdown 우회 방지.
- 리스크: give-up 후 수퍼바이저 종료 코드 = 마지막 자식 코드; launchd/systemd 래핑시 이중 재기동 가능성(외부 수퍼바이저와 조합 시 관찰 필요).
- 라이브: kill -9 자식 -> 1s 재기동 실측(새 pid, health 재서빙, 정직 로그) · TERM -> 자식 포함 클린 종료 · 고아 0.
