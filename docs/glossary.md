---
title: Muse 용어집 (Glossary)
audience: [AI 에이전트, 개발자, 기획자]
purpose: Muse 전용 용어의 단일 정의 — 처음 보는 에이전트가 grep 없이 이해하도록
updated: 2026-06-20
related: [SYSTEM-MAP.md, grounding-gate.md, feature-catalog/INDEX.md]
---

# Muse 용어집

Muse 문서·코드·커밋에서 반복되는 **Muse-고유 용어**의 정의. 일반 용어(RAG·embedding 등)는
제외하고, *Muse에서 특정 의미를 갖는* 것만 모았다. 각 항목 = 한 줄 정의 + 어디 사는지/포인터.
정확한 검증 증거는 [feature-catalog](feature-catalog/INDEX.md), 흐름은 [grounding-gate](grounding-gate.md).

## 1. 정체성 — Muse가 무엇인가

- **Local by construction (로컬-by-construction)** — Muse는 기본적으로 로컬 오픈소스 모델
  (gemma4:12b via Ollama)에서만 돈다. 클라우드 송출은 설정이 아니라 *코드로 거부*된다.
- **MUSE_LOCAL_ONLY** — 클라우드 송출 fail-close 정책 플래그. **기본 ON.** 켜져 있으면 model-router가
  클라우드 provider 인스턴스화 *전에* `LocalOnlyViolationError`를 던진다. 음성/임베딩도 로컬로 강제.
- **Provider-neutral / model-agnostic** — `agent-core`는 vendor SDK를 직접 부르지 않고 Muse 소유의
  `ModelProvider` 추상화만 부른다. vendor 코드는 `packages/model/adapters/*` 가장자리에만 산다.
- **Grounding floor (그라운딩 플로어)** — Muse의 *유지되는 바닥선*: 모든 표면(recall·proactivity·
  reflection·vision)이 grounding+citation 게이트 아래를 지나 **fabrication rate = 0**을 릴리스 게이트로
  강제한다. 이 floor를 약화하는 변경은 금지(IMMUTABLE-CORE).
- **fabrication = 0** — 근거 없는 주장은 *코드가* 드롭한다. 약한 근거는 "잘 모르겠다"로 격하. 이게
  CLAUDE.md 계약이자 `precheck:grounding` 릴리스 게이트의 불변식.

## 2. 그라운딩 / 리콜 — 핵심 엣지

전체 흐름은 [grounding-gate.md](grounding-gate.md). 여기선 용어만.

- **Grounding gate (그라운딩 게이트)** — 답변+근거를 받아 결정적(모델 호출 없음)으로 3-way 판정을
  내리는 `verifyGrounding` (`packages/agent-core/src/knowledge-recall.ts`). Muse의 핵심 엣지.
- **3-way 판정** — **grounded**(근거 충분) / **weak**(약하게만 지지 → "잘 모르겠다") / **ungrounded**
  (근거 없음·인용 위조·근거 초과 주장 → 드롭). fail-close 순서로 평가.
- **4-기준 루브릭** — 판정의 재료: `confidence`(검색 cosine 신뢰도, CRAG식) · `coverage`(답변 토큰이
  근거에 있는 비율, 바닥 0.5) · `answerability`(질문 토큰이 근거에 덮인 비율, 바닥 0.34) ·
  `citationValidity`(인용한 소스가 실제 검색된 것인지 — 위조 인용 1개면 ungrounded).
- **Citation / 인용 (receipt)** — 답변이 가리키는 *실제 소스*. 인용이 검색 결과로 resolve되지 않으면
  (위조) 게이트가 답을 드롭한다. 사용자에게 보이는 출처 영수증.
- **grounded ≠ true (그라운디드라고 참은 아니다)** — 게이트는 *주장↔소스 일치*를 검사하지 소스의
  진위는 아니다. 그래서 오염된 노트/에피소드/MCP가 "확신에 찬 그라운디드 거짓"이 될 수 있다 →
  `untrustedOnly` 표시가 `trusted:false`(외부 MCP/web)에만 기댄 답을 경고한다(알려진 한계, 방어 중).
- **Recall (리콜)** — 노트·에피소드 인덱스를 가로지르는 시맨틱 검색(`muse recall`). `--expand`(1-hop
  wiki-link GraphRAG), `--adaptive`(한계가치 정지 규칙).
- **Knowledge corpus** — 질문마다 노트+할일+캘린더+연락처+메일+리마인더+에피소드+메모리를 하나의
  랭크된 corpus로 융합(`assembleKnowledgeCorpus`). 각 청크는 소스-태그(`task/<id>` 등). opt-in.

## 3. 기억 — 장·단기

- **User memory (유저 메모리)** — 영속 개인 모델(`~/.muse/user-memory.json`): 사실 vs 선호 별도
  네임스페이스. 매 채팅 턴 LLM 훅이 자동 추출(**기본 ON**), 모델-발명 값은 `dropModelAssertedValues`로 제거.
- **Typed user model** — 플랫 메모리보다 풍부한 타입 슬롯(선호·일정·veto·목표). *추론된* 슬롯은
  confidence + half-life(기본 30일) 감쇠; *단언된*(유저가 직접 친) 슬롯과 veto는 절대 감쇠-드롭 안 됨.
- **Episode / episodic memory (에피소드)** — 지난 세션 요약. REPL 종료 시 자동 기록되나
  `MUSE_EPISODIC_MEMORY_ENABLED` **기본 OFF**(reflection/themes/dreaming의 substrate).
- **Reflection (리플렉션)** — 에피소드들을 가로질러 LLM이 합성한 상위 인사이트. 각 인사이트는 *근거
  에피소드 id를 인용*하고 **RGV 재검증**(인용된 에피소드 텍스트에 맞는지 1-shot 판정)으로 confabulation 드롭.
- **Dreaming (드리밍)** — recall-유용성 승급(`memory promote`): 자주+최근 쓰인 메모리를 always-on 페르소나로.
- **Sleep consolidation (수면 통합)** — `memory consolidate`: salient 메모리 승급 + 사라지는 것 격하,
  **절대 삭제 안 함**.

## 4. 자기개선 — 세 번째 기둥

(자기학습 distill/author는 **기본 OFF** — `muse learned`가 켜는 env를 안내.)

- **Whetstone (숫돌)** — README 원칙 3. Muse가 *못 답한·실제로 안 한* 것을 기록하는 약점 원장
  (`weakness ledger`, `~/.muse/weaknesses.json`). `muse doctor --weaknesses`로 확인(실데이터 동작 확인됨).
- **Weakness ledger (약점 원장)** — Whetstone의 저장소. monitor→detect→classify→remediate 4단계의 입력.
- **Playbook (플레이북)** — 과거 피드백에서 배운 *전략* 메모리. 보상 = `reinforcements − decays`. **비대칭
  신용**: DECAY는 reinforce보다 더 강한 cue↔strategy 일치(0.62)를 요구(그라운디드/수동 전략의 잘못된 감쇠가 더 비쌈).
- **Correction-decay (교정 감쇠, SUBTRACTIVE)** — 교정이 저장된 전략을 *진짜 모순*할 때만(LLM polarity
  게이트 `classifyCorrectionContradiction`) 그 주입된 전략을 감쇠. 확인 못 하면 아무것도 안 함(보수적).
- **Skill authoring (스킬 저작)** — 마지막 채팅의 절차적 교정에서 재사용 스킬을 distill. 저작된 스킬은
  **실행-게이트**(사람이 승급 전엔 실행 불가) + 모든 body가 `scanSkillBodyForRisks`(인젝션·위험쉘·시크릿) 통과,
  걸리면 **격리**(OpenClaw 패턴, MIT, 결정론 재구현).
- **RGV (Rubric-Gated grounding Verifier)** — 단일 cosine을 넘어 4-기준 루브릭으로 진화한 grounding 검증자.
  reflection·답변 검증에 재사용.

## 5. 능동성 · 아웃바운드 안전

- **Proactivity (능동성) / earned (획득)** — Muse가 먼저 말 거는 것. "earned"는 휴리스틱이 아니라
  *fail-close 게이트*: ratchet으로 뒷받침된 자격을 통과해야만 능동 알림이 나간다(north star).
- **Daemon (데몬)** — idle일 때 reflection(dreaming)·check-in·followup을 도는 백그라운드 프로세스(opt-in).
- **Objectives (목표) / consent (동의) / scope (스코프)** — 사용자 위임 standing 목표. 제3자에게 행동하려면
  *기록된 scoped consent*가 필요(`performConsentedAction`); 없거나 scope 불일치면 fail-close.
- **Outbound safety (아웃바운드 안전)** — 제3자에게 보내는/행동하는 모든 것의 fail-close 계약. 자세히는
  [outbound-safety.md](../.claude/rules/outbound-safety.md).
- **Draft-first (초안 우선)** — 생성된 내용은 *사용자가 그 내용을 명시 확인*하기 전엔 절대 제3자에게 안 나감.
  자율 전송 없음. 은행/송금은 영구 범위 밖.
- **Action log / hash-chain (행동 로그·해시체인)** — 모든 자율 행동(보낸 것 OR 거부한 것)이 근거와 함께
  append되는 변조-탐지 체인. undo/veto/learned-avoidance 대상.
- **fail-close vs fail-open** — **Guard는 fail-close**(불확실하면 거부). **Hook은 fail-open**(보조 기능은
  실패해도 흐름 안 막음). 보안은 결정적 코드지 프롬프트 부탁이 아니다.

## 6. 런타임 · 아키텍처

- **agent-core** — 모델-불가지 코어 런타임. CLI·서버가 *같은* `agent-core`를 공유(행동 분기 없음).
- **ModelProvider** — Muse 소유 모델 추상화 인터페이스(capabilities: streaming·toolCalling·vision·…).
  각 provider(OpenAI·Anthropic·Ollama…)가 이걸 어댑트. 네이티브 tool-calling 없으면 텍스트 프로토콜로 폴백.
- **runner** — 위험한 로컬 실행이 거치는 Rust 별도 프로세스(`crates/runner`).
- **MCP loopback** — 로컬-only MCP 서버(notes·fetch·fs·search 등, `McpManager` 관리). 외부 MCP는 allowlist 통과 필요.
- **Tool risk level / approval gate** — 도구는 read/write/execute로 분류. 상태변경은 fail-close 승인 게이트
  (`createChannelApprovalGate`/`toolApprovalGate`)를 거친다.
- **Council / orchestration modes** — 멀티에이전트 오케스트레이션. `sequential`/`parallel`/`race`. **race는
  2026-06 보류**(단일 로컬 GPU에선 "먼저 끝난 답 채택"이 허구 — Ollama가 worker를 직렬화) → sequential로 폴백.
- **Model tiering (모델 티어링)** — *개발 루프를 모는 에이전트*의 비용 레버(정형=Sonnet, scout/judge=Opus).
  Muse 제품 런타임 모델(gemma4)과는 무관 — 그건 고정.

## 7. 검증 게이트

- **self-eval** — 결정적 게이트(lint·capabilities-drift·테스트수 등)를 하나의 스코어보드로 집계. 회귀 시 fail-close.
- **eval:\*** — 에이전트-레벨 라이브 배터리(`eval:tools`·`eval:agent`·`eval:self-improving`·`eval:adversarial`…).
  대부분 로컬 Ollama 필요, 없으면 skip(=pass 아님).
- **smoke:broad / smoke:live** — broad=진단 provider HTTP 스윕(키 불필요) · live=실제 LLM 라운드트립
  (**로컬 Ollama만**, gemma4).
- **precheck:grounding** — fabrication-critical 배터리의 pre-push 트립와이어(grounding ratchet).
- **pass^k** — 확률적 에이전트 신뢰도: 한 케이스를 k번 돌려 *전부* PASS여야 통과(한 번 green ≠ 증명).
