# Muse Work — 흐름·보드·연속성을 "일" 단위로 묶기

> **Status: SHIPPING IN SLICES (2026-07-22).** 로컬 Work 스토어, CLI/API 동사,
> 결과 기록, 흐름 삭제 정리, 정확한 Personal Continuity 문맥 연결은 출하됐다.
> 전용 웹 Work 상세와 채팅 승격은 아직 로드맵이다.

## 왜

진안의 원래 지시: "이게 최종적인 형태는 work가 되어야 하고." 지금 Muse에는 일의
부품이 세 곳에 흩어져 있다 — **흐름**(반복 자동화, scheduler 잡의 그래프 뷰),
**보드**(muse board — 내구성 작업 큐와 승인), **연속성 스레드**(muse thread —
중단된 일을 근거와 함께 재개). 사용자 관점의 "하나의 일"(예: "생일 파티 준비",
"Q3 보고서")이 시스템에는 존재하지 않는다.

Work는 새 런타임이 아니라 **묶음(binding)이다**: 목표 한 줄 + 그 일에 속한
흐름들 + 보드 태스크들 + 연속성 스레드 + 결과 기록. Personal Continuity의
"thread → pack → outcome → adaptation" 루프에서 Work는 thread의 작업 특화
확장이며, 제품 경계가 아니라 하나의 모드다 (product-identity.md).

## 데이터 계약 (신규 저장소 1개)

```
~/.muse/works.json   (encrypted-file 관례 따름)
Work {
  id, name, goal,            // 사용자가 쓴 한 줄 목표
  flowIds: string[],         // scheduler 잡 id — 이 일을 위해 도는 자동화
  boardTaskIds: string[],    // muse board 태스크 id
  threadId?: string,         // 연속성 스레드 (있으면)
  status: "active" | "paused" | "done",
  outcomes: [{ atIso, note, kind: "used"|"adjusted"|"ignored" }],  // thread outcome과 동형
  createdAtIso, updatedAtIso
}
```

원칙: 참조만 저장한다(복사 금지). 흐름/태스크/스레드의 lifecycle은 각자의
스토어가 소유하고, Work 삭제는 참조만 끊는다. 두 스토어를 잇는 순간 모든
lifecycle op를 감사하라는 교훈(calendar↔reminder 링크)이 그대로 적용된다 —
잡 삭제 시 Work의 flowIds에서 정리하는 훅이 수용 기준에 들어가야 한다.

Work↔PersonalThread 관계를 바꾸는 제품 진입점은 두 파일을 정해진 순서로 잠그는
관계 코디네이터를 사용한다. Work 증거 링크, `Work.threadId`, 양쪽 삭제가 서로
모순되거나 dangling 상태를 만들려 하면 명시적 unlink/clear 전까지 실패한다.
Continuity 안의 Work는 문맥 전용이며 Work 고유의 `done`/`outcome` 권한을 가져오지 않는다.

## 표면

- **웹**: LNB "내 삶"에 "일" 항목(또는 연속성 뷰의 확장 — 구현 시점에 판단).
  Work 상세 = 목표 헤더 + 세 섹션(흐름 미니캔버스 링크 / 보드 태스크 체크리스트 /
  스레드 continue 버튼) + 결과 타임라인.
- **CLI**: `muse work list|show|start|link|outcome|done` — thread/board/scheduler의
  기존 동사와 대칭.
- **채팅**: "이거 계속 하자" → thread 생성과 동일한 승격 경로로 Work 제안
  (자동 생성이 아니라 제안 — 사용자가 확정).

## 안전 (변경 없음, 재확인)

- Work는 실행 권한을 새로 만들지 않는다. 흐름 실행은 scheduler의 기존 게이트,
  외부 발신은 기존 채널 승인 게이트(draft-first), 뱅킹은 영구 범위 밖.
- Work의 "done"은 자기보고가 아니라 outcome 기록으로 판정한다 (agent-testing의
  termination 원칙).

## 슬라이스 (각각 독립 출하 가능)

1. **W1 — 스토어 + CLI 골격**: works.json + `muse work list|start|link|show`,
   참조 무결성 테스트(없는 flowId 링크 거부), lifecycle 감사 훅.
2. **W2 — 웹 Work 뷰**: 읽기 전용 상세(세 섹션), LNB 배치 결정.
3. **W3 — outcome 루프**: `muse work outcome` + 다음 pack/브리핑에 반영
   (continuity outcome과 동형 처리).
4. **W4 — 채팅 승격 경로**: 제안-확정 플로우 (clarify-directive 재사용).

## 열린 질문 (구현 전 진안 결정)

- LNB 위치: "내 삶 > 일" 신설 vs 연속성 뷰 확장? (내비 큐레이션 원칙과 충돌 없게)
- Work당 흐름 수 상한/정리 정책 — 죽은 Work가 자동화를 계속 돌리는 상태를
  어떻게 보이게 할 것인가 (예: 자동 활동 예정 탭에 Work 배지).
