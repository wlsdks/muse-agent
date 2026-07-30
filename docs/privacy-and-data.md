---
title: 내 데이터는 어디 있나 — 프라이버시 요약
audience: [사용자, 기획자, 개발자, AI 에이전트]
purpose: "무엇이 어디에 저장되고, 무엇이 절대 밖으로 안 나가는가"를 한 곳에서
updated: 2026-07-13
related: [design/attunement.md, SYSTEM-MAP.md, FEATURES.md, strategy/differentiation.md, README.md]
---

# 내 데이터는 어디 있나 (프라이버시 요약)

Muse는 한 사용자의 개인 데이터와 작업 리듬을 다루므로, “무엇을 관찰하고 어디에 저장하며
어디로 보낼 수 있는가”가 제품 기능만큼 중요합니다. 현재 개인 store는 기본적으로 파일 기반이고
모델 provider는 사용자가 선택합니다. 강한 온디바이스 경계가 필요하면
`MUSE_LOCAL_ONLY=true`가 fail-close합니다.

자세한 동작은 [기능 구조 지도](SYSTEM-MAP.md)와 [기능 정의서](FEATURES.md)를, "왜 이렇게
설계했나"는 [차별점 문서](strategy/differentiation.md)를 보세요.

## 내 데이터는 어디 저장되나

- **개인 store는 내 기기/계정에.** 메모·할일·일정·알림·연락처·기억·과거 대화 요약·들여온 자료는
  기본적으로 **내 컴퓨터의 내 파일**에 저장됩니다. 공용 클라우드 계정도, 다른 사용자와 공유되는
  작업공간도 없습니다(1인용 — 멀티테넌트·RBAC 없음).
- **Personal Continuity도 로컬에.** 사용자가 만든 life/work thread, 연결한 local task/note ID,
  delivery·outcome·reset receipt는 기본 `~/.muse/attunement.json`에 owner-only (`0600`) 원자 저장됩니다.
  이 slice는 원문 note를 복사하지 않고 ID만 저장하며, 모델 호출이나 자동 자료 수집도 하지 않습니다.
- **검색용 의미 인덱스(임베딩)는 기본 loopback endpoint를 사용합니다.** 하지만
  `MUSE_LOCAL_ONLY`가 꺼진 상태에서 `OLLAMA_BASE_URL`을 원격 주소로 바꾸면 인덱싱할 개인 텍스트가
  그 주소로 전송될 수 있습니다. 강한 온디바이스 보장이 필요하면 `MUSE_LOCAL_ONLY=true`가 원격
  endpoint를 거부하도록 해야 합니다.
- **디스크 암호화는 기본 평문 + 선택적 켜기(opt-in).** 내 기기에 저장된다는 것이 곧 암호화는
  아닙니다. 기본값은 평문이며, 일부 스토어(user-memory·episodes·action-log·contacts·playbook)는
  `… encrypt` 명령으로 켤 수 있습니다(예: `muse memory encrypt`, `muse actions encrypt`; 강한
  키를 위해 `MUSE_MEMORY_KEY` 먼저 설정). tasks·reminders·notes는 아직 암호화 대상이 아닙니다.
  `muse privacy`는 지원되는 encrypted store의 상태를 보여주지만 browsing/activity/proactive history,
  run log, checkpoint까지 포괄하는 전체 데이터 inventory는 아직 아닙니다. 디스크 자체 암호화
  (FileVault 등)는 OS 차원에서 별도로 권장합니다.

## 무엇이 절대 밖으로 안 나가나 (명시적 로컬-온리 자세)

- **클라우드 AI/음성으로의 유출 차단.** `MUSE_LOCAL_ONLY=true`에서는 어떤 내용도 클라우드 LLM이나
  클라우드 음성 서비스로 나가지 못합니다. 클라우드 모델을 쓰려 하면 조용히 비활성화되는 게 아니라
  **런타임이 시끄럽게 거부**합니다.
- **마이크 소리도 로컬에서만.** 음성 인식·합성은 로컬 엔진만 등록되어, 클라우드 음성 키가 있어도
  마이크 오디오가 외부로 새지 않습니다.
- **이미지도 마찬가지.** 이미지 이해는 로컬에서 처리되며, 클라우드로 이미지가 나가는 경로는
  로컬-온리 게이트가 함께 막습니다.
- **원격 호스트도 "유출"로 간주.** 내 기기가 아닌 다른 서버에 있는 모델은 — 같은 오픈소스 모델이라도
  — 외부 유출로 보고 거부합니다.
- **Home Assistant도 원격 경로를 닫습니다.** `MUSE_LOCAL_ONLY=true`이면 표준 Home Assistant 읽기·제어·
  감시 경로는 원격 URL을 토큰을 읽기 전에 거부합니다. `http://127.0.0.0/8[:port]` 또는
  `http://[::1][:port]`의 루트 엔드포인트만 허용되고, 리다이렉트도 따라가지 않습니다. 이는 Home
  Assistant 통합에 대한 범위 제한이며, Muse 또는 컴퓨터 전체의 모든 네트워크 송신을 감사·차단한다는
  주장은 아닙니다.
- **이 자세에서는 로컬 모델로 시작.** `MUSE_LOCAL_ONLY=true`이면 컴퓨터에 있는 클라우드 키가
  기본 모델을 가로채지 않습니다. 이 플래그가 꺼져 있으면 발견된 클라우드 키가 모델을 선택할 수
  있습니다.
- **다른 Muse와 연결돼도(스웜) 개인 데이터는 안 나감.** 여러 Muse를 또래로 연결하면(기본 꺼짐,
  명시적으로 켜야 함) **배운 노하우(예: 스킬)만** 오갑니다. 노트·기억·과거 대화·연락처 같은 개인
  데이터는 애초에 보낼 수 있는 종류가 아니고, 내보내는 노하우조차 시크릿이 가려진 채 나갑니다.
  받은 노하우도 사람이 승격하기 전까지 비활성으로 격리됩니다.

이 판단은 모델의 "선의"가 아니라 **고정된 규칙 코드**로 동작합니다. 건강검진 명령(`muse doctor`)이
현재 자세를 보고합니다.

## 클라우드 provider를 쓰는 경우

Muse는 provider-neutral이므로 클라우드 모델도 선택할 수 있습니다. 이 경우 선택한 provider의
요청 경계와 정책이 적용됩니다. 온디바이스 보장이 필요한 사용자는 `MUSE_LOCAL_ONLY=true`를 켜야
하며, 이 자세에서는 cloud provider가 런타임에 생성되기 전에 거부됩니다.

## Muse Observe 데이터 경계 (O1 collection available)

Observe O1은 사용자가 고른 정확한 PersonalThread 하나에 대해 앱 **카테고리**, 시각, 지속시간만
로컬에 수집하는 opt-in 표면입니다. `consent/start/status/inspect/pause/resume/forget`을 제공하며 raw 앱
식별자는 명시적인 owner-only map 조회 뒤 폐기합니다. O1은 desktop work rhythm, friction, hypothesis,
intervention outcome, notice, action을 만들지 않습니다. 향후 Personal Rhythm/타이밍 단계는 다음 다섯
속성을 계속 릴리스 gate로 삼습니다.

1. **Owner-controlled placement** — 현재는 owner-only local store와 source별 TTL을 사용한다.
   외부 provider 경로는 별도 opt-in이며 observation data가 cloud model context에 자동 포함되지 않는다.
2. **Visible** — 활성 source, 수집 field, retention, 마지막 읽기, 파생 가설을 한곳에서 보여준다.
3. **Pausable** — pause는 다음 tick까지 OS 읽기를 멈추고, disabled 상태의 source polling은 0회다.
4. **Inspectable** — 모든 리듬·마찰 가설이 redacted evidence ID와 rule version으로 돌아간다.
5. **Forgettable** — event·기간·source·전체 단위 삭제가 가능하고 파생 state도 함께 재구축한다.

기본 저장 대상은 app-session transition과 duration 같은 최소 metadata다. **raw keystroke, continuous
screen capture, clipboard content, selected text, window title의 지속 저장은 기본 프로필에서 금지**한다.
Browser history는 현재처럼 별도 명시적 opt-in source이며 O1 collector와 결합되지 않습니다. 브라우저
관찰을 향후 Observe에 추가하려면 private-window exclusion과 source별 제어를 별도로 통과해야 합니다.
상세 계약은 [Attunement 설계](design/attunement.md).

## 프라이버시-등급 라우팅 — 개인정보 없는 요청만 선택적으로 클라우드로 (opt-in, 기본 꺼짐)

전면 클라우드 전환("로컬-온리 끄기")과 완전 로컬 사이의 중간 지점: 채팅 턴 단위로 **개인
정보가 전혀 실리지 않는** 요청만 골라 더 강한 클라우드 모델로 보내고, 조금이라도 개인적인
신호가 있으면 무조건 로컬에 남기는 기능입니다. 기본은 꺼짐 — 아래 두 환경변수를 모두 켜야
동작합니다.

- **켜는 법**: `MUSE_PRIVACY_ROUTING=true` + `MUSE_CLOUD_MODEL=<provider/model>` (예:
  `gemini/gemini-2.5-flash`).
- **로컬에 남기는 기준(하나라도 해당하면 무조건 로컬, 판단은 결정론적 코드)**: 이번 턴에
  기억(페르소나)이나 노트/일화 검색 결과가 실제로 프롬프트에 실렸을 때, 메시지에 PII가
  탐지됐을 때, 소유격 표현("내 …", "my …")이 있을 때, 기억된 사실의 값(예: 저장된 사람 이름)이
  메시지에 언급됐을 때. 판단 로직은 `packages/policy/src/privacy-routing.ts`
  (`resolvePrivacyRoutedModel`)에 있고, 애매하면 항상 로컬로 fail-close합니다.
- **클라우드로 보내는 턴이 실제로 무엇을 실어 나르는가**: 원문 메시지 + 답변 언어 지시 +
  현재 시각 한 줄뿐입니다. 페르소나·기억·검색된 노트/일화·이전 대화 기록은 **애초에 그 요청을
  만드는 함수(`buildCloudTurnRequest`)가 받는 인자에 없어서** 구조적으로 실릴 수 없습니다.
- **`MUSE_LOCAL_ONLY=true`가 항상 이깁니다.** 프라이버시 라우팅이 켜져 있어도 로컬-온리가
  켜져 있으면 클라우드 모델은 시도조차 되지 않습니다(정책 계층 + 모델 라우터 게이트, 이중 방어).
- **클라우드 모델 준비가 안 됐으면(키 없음, 네트워크 오류) 조용히 로컬로 대체**됩니다 — 사용자
  화면에 에러가 뜨지 않습니다.
- **눈에 보이게 표시**: 클라우드로 나간 답변에는 `☁️ cloud (context-free) — <model>`(한국어는
  `☁️ 클라우드 (개인 정보 없음) — <model>`) 표시가 붙습니다. 로컬로 처리된 턴은 평소와 똑같이
  아무 표시도 없습니다. `muse doctor`의 `privacy routing` 항목에서 현재 자세(꺼짐 / 켜짐+모델 /
  로컬-온리로 강제 로컬)를 확인할 수 있습니다.
- **현재 범위**: 이 슬라이스는 `muse chat` 단일 턴 경로(`runLocalChat` — CLI `muse chat --local` +
  상태 TUI)에 배선되어 있습니다. 대화형 Ink 채팅(`muse` 기본 실행)은 아직 이 라우팅을 적용하지
  않습니다(페르소나/검색 조립이 렌더 컴포넌트 안에서 일어나 이번 슬라이스로는 안전하게 분리하기
  어려웠습니다) — 오늘 실행되는 `muse` 대화형 세션은 이 옵션을 켜도 항상 로컬로 남습니다.

## 남에게 보내는 행동 (밖으로 나갈 때)

내 데이터를 "읽는" 것과 달리, **남에게 무언가를 보내는 행동**(이메일·메시지·폼 제출 등)은 별도의
안전장치를 거칩니다:

- **초안 먼저, 자동 전송 절대 금지** — 사람이 그 내용 그대로 확인해야만 나갑니다.
- **막힘 우선** — 거부·시간초과·확인 전달 실패 어느 경우든 전송되지 않습니다.
- **모든 행동 기록 + 되돌리기** — 보냈든 거부했든 기록되고 되돌릴 수 있습니다.

## 영구히 안 하는 것

- **은행·결제·송금 없음.** 계좌를 연결하지도, 돈을 옮기지도 않습니다(되돌릴 수 없는 위험이라
  제품의 영구 경계).
- **클라우드 기억 저장소 없음 / 자율 외부 전송 없음.**

---

*요약: 개인 store는 현재 파일 기반이 기본이고 모델 provider와 배포 방식은 사용자가 고릅니다.
`MUSE_LOCAL_ONLY=true`는 cloud egress를 fail-close하며, 향후 Observe는
visible·pausable·inspectable·forgettable하지 않으면 출시하지 않습니다. 남에게 가는 행동은 언제나
내 확인을 거칩니다.*
