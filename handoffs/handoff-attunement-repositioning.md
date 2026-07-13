---
title: Muse Attunement repositioning handoff
updated: 2026-07-13
---

# Muse Attunement repositioning

## 작업 헤더

- **작업 이름:** attunement-repositioning
- **한 줄 목표:** Muse를 한 사람의 일상과 업무를 함께 이어서 이해하고, 언제 어떻게 도울지
  점점 더 잘 맞추는 개인 AI로 설명한다.
- **현재 단계:** `DONE`
- **담당:** 오케스트레이터 `/root`

## 1. 계획

- **제품 정체성:** Attunement는 “나에 대한 사실을 많이 외운다”가 아니라 “내 삶에 잘 맞게
  돕는 법을 배운다”는 약속이다.
- **첫 증명점:** Personal Continuity. 사용자가 이어가고 싶은 미완료 주제를 고르면, Muse가
  명시적으로 연결된 항목만 모아 현재 맥락과 안전한 다음 한 단계를 준비한다. 업무 프로젝트,
  일정, 건강, 관계, 여행, 취미를 모두 담는다.
- **업무의 위치:** Work Resumption과 Muse Work는 Personal Continuity의 업무 특화 모드다.
  Muse 전체 정체성이 아니다.
- **관찰의 위치:** Observe는 제품의 시작점이 아니다. 기본 Continuity Pack이 유용하다고
  확인된 뒤, 사용자가 켰을 때만 리듬과 타이밍을 개선하는 선택 기능이다.
- **개발 순서:** 사용자 선택 thread → Continuity Pack → outcome → 제한된 adaptation.
  이후에만 Observe → rhythm evidence → friction candidate → better timing을 붙인다.
- **범위 밖:** 원시 키 입력·연속 화면 수집, 자동 심리 진단, 임의 desktop 조작, 미구현 기능을
  현재 기능처럼 쓰기, 금융·무승인 외부 행동.

## 2. 파일 범위

- **공개 진입점:** `README.md`, `README.ko.md`, `package.json`, GitHub repository description.
- **에이전트 계약:** `AGENTS.md`, `CLAUDE.md`.
- **canonical 문서:** `docs/strategy/attunement.md`, `docs/design/attunement.md`,
  `docs/goals/attunement-implementation-plan.md`.
- **정렬 문서:** `CHANGELOG.md`, `docs/README.md`, `docs/glossary.md`, `docs/SYSTEM-MAP.md`,
  `docs/FEATURES.md`, `docs/privacy-and-data.md`, `docs/grounding-gate.md`,
  `docs/strategy/differentiation.md`와 직접 관련 design/catalog 문서.
- **역사 기록:** 날짜가 붙은 과거 plan/review/loop 문서는 당시 증거로 보존하고 새 제품 주장으로
  취급하지 않는다.

## 3. 정직성 교정

독립 red-team 검토에서 다음을 찾아 수정했다.

- 미구현 Attunement를 현재 기능처럼 말하던 hero/metadata를 제품 목표형 문장으로 변경.
- cloud key가 있으면 cloud provider가 선택될 수 있는 실제 모델 선택 로직을 문서에 반영.
- 모든 대화가 인용되거나 `fabrication=0`이라는 보편 주장을 제거하고 fast-chat 갭을 명시.
- 첫 구현을 자동 관찰보다 사용자 호출형 vertical로 앞당김.
- thread와 artifact의 명시적 binding을 데이터 계약에 추가.
- remote `OLLAMA_BASE_URL` 가능성과 background review의 구현·기본 OFF 상태를 정정.
- Personal GUI atlas를 첫 계획에서 제거.
- 사용자 교정에 따라 Work Resumption 중심 설명을 Personal Continuity로 확장.

## 4. 수용 기준

1. README 첫 화면만 읽어도 Muse가 업무 전용이 아닌 일상+업무 개인 AI임을 이해한다.
2. Attunement, Personal Continuity, Work Resumption, Observe의 관계를 쉬운 말로 구분한다.
3. 현재 제공하는 토대와 roadmap을 섞지 않는다.
4. 첫 vertical은 사용자가 고른 daily-life 또는 work thread에서 end-to-end로 동작한다.
5. LLM은 연결 항목을 요약할 수 있지만, 어느 삶의 주제에 속하는지 추측하지 않는다.
6. Observe는 visible, pausable, inspectable, forgettable이고 기본 raw keystroke/continuous
   screen capture가 없다.
7. outcome이 다음 pack을 어떻게 바꾸는지 deterministic reducer와 golden/property test로
   증명한다. adaptation은 권한·수집·보존·수신자를 넓히지 않는다.
8. 계획은 의존성과 gate로만 표현하고 개발 기간을 약속하지 않는다.
9. English/Korean README, package metadata, GitHub description이 같은 제품 방향을 말한다.
10. 상대 링크, JSON, comment/prompt/capability gates, lint/build/test와 독립 평가를 통과한다.

## 5. 검증 기록

- 최종 문서 검증: relative links 23개, package JSON/description, EN/KO identity parity,
  canonical outcome taxonomy, `git diff --check` PASS.
- 저장소 규율: `pnpm lint`, `pnpm lint:comments`, `pnpm check:prompt-seam`,
  `pnpm check:capabilities` PASS.
- 변경 범위 테스트: `pnpm test:changed --uncommitted` PASS — autoconfigure 관련 380개.
- 독립 제품 평가: 6/6 PASS. 일상+업무 정체성, Personal Continuity의 위치,
  current/roadmap 정직성, 쉬운 설명, thread binding, outcome/permission invariant 모두 통과.
- GitHub description exact 확인: `Building a personal AI that learns how you live and work,
  then gets better at knowing when and how to help. Local-first, any model.`
- 전체 `pnpm check`: build와 전체 workspace test가 PASS. egress seam 4건은 최신의 genuine
  tool exposure authority·runtime approval·사용자 제공 URL을 fixture에 명시해 안전 policy를
  약화하지 않고 복구했다. doctor prompt-cache probe는 주입된 env/fetch를 사용하도록 고쳤고,
  주입 URL/fetch를 검증하는 regression test를 추가했다. ambient `NO_COLOR`에 흔들리던 ANSI
  golden test도 독립 환경을 명시해 안정화했다.

## 열린 질문

- 없음. 전체 gate가 green이며 다음 단계는 local `main` 병합과 Personal Continuity Slice A이다.

## 상태 로그

- 2026-07-13 · PLAN · Attunement와 Work Resumption 중심 초안 작성.
- 2026-07-13 · EVAL · outcome reducer와 adaptation 불변식 보완.
- 2026-07-13 · 사용자 교정 · 달력 기반 개발 계획 제거, 쉬운 설명 요구.
- 2026-07-13 · red-team · overclaim, provider/local, grounding, scope, binding drift 발견.
- 2026-07-13 · 사용자 교정 · Muse는 업무뿐 아니라 일상도 돕는 개인 AI여야 함.
- 2026-07-13 · BUILD · Personal Continuity를 첫 증명점으로 올리고 Work Resumption을 하위
  업무 모드로 재배치.
- 2026-07-13 · red-team · differentiation identity drift와 outcome taxonomy 불일치 발견,
  Personal Continuity 및 `used|adjusted|ignored|rejected`로 통일.
- 2026-07-13 · 독립 평가자 · EVAL · 최종 제품 기준 6/6 PASS, 치명 finding 없음.
- 2026-07-13 · 오케스트레이터 · BLOCKED · 최신 main의 기존 egress seam 4건과 doctor timeout
  1건 때문에 전체 completion gate 실패; 병합·새 branch 생성 보류.
- 2026-07-14 · 오케스트레이터 · BUILD/EVAL · fixture/runtime injection drift를 안전하게 복구.
  전체 `pnpm check`, lint, comments, prompt seam, capability gate PASS.
- 2026-07-14 · 오케스트레이터 · DONE · 문서 정체성 작업의 completion gate를 통과했고,
  Personal Continuity Slice A handoff로 인계.
