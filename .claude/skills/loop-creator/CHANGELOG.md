# loop-creator — CHANGELOG

스킬 + 번들된 `references/loop-engineering.md` 계약의 버전별 기록. 루프를 많이 돌린
뒤 이 이력 ↔ `docs/goals/loop-digest.md`의 fire 결과(각 항목에 `(skill vX.Y.Z)` 스탬프)를
대조해 무엇이 산출을 좋게/나쁘게 했는지 보고 개선한다.

> SemVer 느슨하게: **major**=설계 골격 변경, **minor**=새 가드/행동, **patch**=문구/리팩터.
> 변경 시 SKILL.md `version` 올리고 여기 한 항목 추가.

---

## 1.6.1 — 2026-06-12
ORIENT에 **backlog.md 부재 처리** 추가(진안 질문). backlog는 스킬이 *읽는* 기존 repo
아티팩트지 만드는 게 아님을 명시하되, 파일이 없으면(fresh repo / doc-reset) 최소 스켈레톤
생성 + gap-scout 시드 = "비면"과 동일 처리. "파일 없음 ≠ 일감 없음" — 멈추지 않는다.

## 1.6.0 — 2026-06-12 (`8895dae0`)
라이브 dogfood 평가(fire 1–2)에서 드러난 4개 약점을 가드로(계약 §4.5):
- **가치 우선** 슬라이스 선택(검증 쉬운 것 아님; defer는 digest에 사유 명시).
- **다양성**(같은 KIND 3 fire 반복 금지).
- **행동 acceptance**(선언/config-only 테스트 금지 → 게이팅 검증자가 FAIL).
- **토큰 효율**(동종 변경 배칭 + 리스크-비례 검증 깊이).
- **실패 드릴**: 고의 inert 슬라이스로 게이팅 검증자 FAIL→롤백 경로를 *실증*(가정 아님).

## 1.5.1 — 2026-06-12 (`1a7ac13e`)
단일 소비자 계약 `loop-engineering.md`를 harness/에서 스킬 `references/`로 이동(결합도
질문 반영). 스킬이 자기 계약을 번들로 들고 다님. "Muse-native 스킬"임을 정직히 명시.

## 1.5.0 — 2026-06-12 (`623c264e`)
블로그 비교 격차 3개를 닫음:
- **자율성 티어**(Tier1 로컬커밋 / Tier2 브랜치+draft PR, 하드 floor 불변).
- **게이팅 검증자**(별개 강한-티어 Opus judge가 커밋을 GATE, FAIL=롤백).
- **이해 체크포인트**(매 fire 다이제스트 + 3 fire마다 리뷰 관문).

## 1.4.0 — 2026-06-12 (`9c03fcbb`)
ORIENT에 **연료 체크**(테마 열린 항목 ≤2면 경고+넓은 테마 제안) — 라이브 검증에서 발견.

## 1.3.0 — 2026-06-12 (`024ff5ef`)
독립 적대 리뷰로 하드닝: red-baseline 가드(self-eval non-zero면 등록 중단), 동시 main-루프
경고, 예산 캡을 생성 프롬프트에, 중복 테마 cron CronList 체크, 'Done' 독립 판정,
워크드 예시 번호 정렬, /loop 세션-id·즉시 첫-fire 명확화.

## 1.2.0 — 2026-06-12 (`07cf8ead`)
2026-06 출처(Steinberger·Cherny·Osmani 등) 정식 반영 + 완성형으로: **등록 전 자가검증
게이트**(체크리스트 PASS/FAIL), 워크드 예시, 계보 포인터.

## 1.1.0 — 2026-06-12 (`edd505c2`)
**모델 티어링**(정형=Sonnet, 설계·검증=Opus, judge=worker보다 강한 티어) — 토큰 절약 레버.

## 1.0.0 — 2026-06-12 (`99c749f2`)
초판: Addy Osmani "Loop Engineering"을 Muse 계약으로 증류(`loop-engineering.md` — 6
프리미티브·검증가능 정지조건·maker≠judge·3대 실패모드) + 생성형 `loop-creator` 스킬
(테마→계약 채움→프롬프트 생성→cron 등록).
