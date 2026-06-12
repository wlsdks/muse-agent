# loop-creator — CHANGELOG

스킬 + 번들된 `references/loop-engineering.md` 계약의 버전별 기록. 루프를 많이 돌린
뒤 이 이력 ↔ `docs/goals/loop-digest.md`의 fire 결과(각 항목에 `(skill vX.Y.Z)` 스탬프)를
대조해 무엇이 산출을 좋게/나쁘게 했는지 보고 개선한다.

> SemVer 느슨하게: **major**=설계 골격 변경, **minor**=새 가드/행동, **patch**=문구/리팩터.
> 변경 시 SKILL.md `version` 올리고 여기 한 항목 추가.

---

## 1.11.2 — 2026-06-13
**논문-근거 우선 라인에 테마-스코프 절**(진안 확인): capability/method/research 테마에선 논문-우선이
맞지만, hardening/correctness/security 테마에선 그 보안·correctness 작업 자체가 곧 가치 — "단순
버그픽스"로 깎아 deprioritize하지 않는다(프로토타입 오염·계약 위반 수정은 하드닝 루프의 최고 산출이었음).
모호함이 하드닝 루프로 하여금 자기 최고 산출을 건너뛰게 만드는 충돌을 제거. 함께: 진안이 추가한
"공개/오픈 논문만" 라인(arXiv/오픈액세스 한정, 자체 재구현, proprietary 복사 아님) 보존.

## 1.11.1 — 2026-06-13
생성-프롬프트 ②에 **논문-근거 우선(가능할 때)** 라인 추가(작업트리에 있던 미커밋 편집을 보존) —
강한-티어 scout가 WebSearch로 검증된 2024-2026 AI-agent 논문에서 *적용가능 메커니즘 + arXiv ID*를
스펙해 단순 correctness 버그픽스보다 논문-기반 capability 적용을 우선. standing 디렉티브
[[project_research_application]]와 일치하고 v1.11.0 평가의 "작은-버그 편향" 발견을 보완(가치-우선의 구체화).

## 1.11.0 — 2026-06-13
**라이브 평가發 5개 가드**(6 fire 실측 + Osmani/Cherny/Karpathy/Anthropic 2026-06 대조). 메커니즘은
최상급이나 "게이트의 가장자리" 3곳이 약했음 — 전부 프롬프트/계약 한 줄급으로 수정:
- **게이트가 최종 diff를 덮음**(§4.5-6, 생성프롬프트 ⑤): write-back/digest 後 staged diff에 lint+byte-hygiene
  재확인. fire-1이 NUL 바이트를 게이트-後-편집 구멍으로 흘렸고 fire-2가 잡은 *증명된 사고*를 닫음.
- **decompose-on-defer**(§4.5-7, ②): 큰 항목 defer 시 loop-sized로 쪼개 backlog 기록(Anthropic planner
  패턴) 또는 "진안 필요" 명시; 2회 defer면 escalate. 작은-버그 편향(defer 일방 ratchet)을 파이프라인으로.
- **RATCHET 지표**(§4.5-8, ⑤b): 매 fire digest에 스코어보드 델타 1줄, 알림은 추세(Karpathy immutable number).
- **stale-dist 복구 인코딩**(④): 만진 패키지 빌드-먼저 + check 실패 시 첫 진단은 clean-rebuild 재실행
  (2/6 fire에서 flake로 진단 사이클 낭비, 이미 MEMORY에 있던 교훈).
- **judge 실패-드릴 CADENCE**(§4.5-5): 1회→N fire(10)/버전bump마다 재드릴 + digest에 judge PASS-rate.
데이터 판정: 6 fire는 메커니즘 smoke test엔 충분, 스킬 판정엔 시기상조 — 계측 깔고 ~25–30 fire에 재평가.

## 1.10.0 — 2026-06-13
**계획 티어에 Fable 5**(진안 지시): 계획/설계/모호한 포크/적대적 검증(강한-reasoning 티어)은
**Fable 5(`model:"fable"`)를 가능할 때** 쓰고, 불가하면 **Opus 4.8(1M, `claude-opus-4-8[1m]`)**로
폴백. 개발/빌드는 Opus든 Sonnet이든 무관(정형은 여전히 Sonnet 위임이 토큰 절약). §1.5 + 생성
프롬프트 모델-티어링 라인 + §4 체크리스트 갱신.

## 1.9.0 — 2026-06-12
**이해 체크포인트를 "막는 STOP" → "비동기 non-blocking 알림"으로**(진안 지적 — 재검토 결과 내
설계가 연구보다 과하게 보수적이었음). 블로그/실천가(Cherny: 무한 자율+PR 비동기 머지)는 검토를
*루프 halt*가 아니라 *비동기 리뷰 표면*으로 처리. 이제 루프는 **절대 안 멈춤**: digest는 아무때나
읽는 비동기 로그, N fire마다 막지 않고 PushNotification 알림만 + 계속 진행. comprehension debt는
읽기 쉬운 digest로 처리하지 루프 정지로 처리하지 않음. (§3-2.)

## 1.8.1 — 2026-06-12
신호 scout 하드닝(loop fire 6): 빈-답(non-answer) ungrounded를 실패로 안 셈 — scout의 첫 실
발견이 dev 테스트 노이즈(빈 답)였음. `isFailureEvent`가 success===false는 먼저 카운트하고
ungrounded+빈답만 제외. 실데이터 재실행 1→0 클러스터. (코어 `run-log-analysis.ts`.)

## 1.8.0 — 2026-06-12
**신호 기반 gap-scout**(진안 지시 — 조사: 2026 주류는 신호-triage 발굴). 발굴(§1.3)을 3단
사다리로: (a) **신호 먼저** `scripts/scout-signals.mjs`가 `.muse/runs/` 실패 트레이스
(ungrounded/failed)를 빈도순 클러스터링 → 진짜 반복 실패가 일감, (b) 깨끗하면 코드 확장
gap-scout, (c) 둘 다 마르면 **정직 보고 후 멈춤(가짜 일감 금지)**. 결정적 코어
`apps/cli/src/run-log-analysis.ts`(`analyzeRunLogSignals`, 행동 단위테스트 8/8); 실데이터
1133 트레이스에서 실 실패 클러스터(browser-read ungrounded ×7) 발굴 증명. improve-muse (e)도
동일 사다리로 갱신.

## 1.7.0 — 2026-06-12
**§1을 "DECIDE THE WORK"로 재구성**(진안 지적): 스킬의 1번 작업 = *무엇을 할지 결정*하고,
모르면 *능동 발굴*. 결정 순서(기준선 회귀 → 테마+backlog top → **테마 없음/얇음/부재면
gap-scout를 *즉시* 돌려 발굴 후 backlog에 써넣고 진행**). 발굴을 "backlog 비었을 때만"이라는
조건부에서 **"모를 때의 1번 동작"으로 승격** — "할 게 없다"는 금지(모르면 멈추지 말고 스카웃).

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
