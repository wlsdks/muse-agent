---
title: Muse 용어집 (Glossary)
audience: [AI 에이전트, 개발자, 기획자]
purpose: Muse 전용 용어의 단일 정의 — 처음 보는 에이전트가 grep 없이 이해하도록
updated: 2026-07-30
related: [strategy/attunement.md, design/attunement-graph.md, SYSTEM-MAP.md, grounding-gate.md, feature-catalog/INDEX.md]
---

# Muse 용어집

Muse 문서·코드·커밋에서 반복되는 **Muse-고유 용어**의 정의. 일반 용어(RAG·embedding 등)는
제외하고, *Muse에서 특정 의미를 갖는* 것만 모았다. 각 항목 = 한 줄 정의 + 어디 사는지/포인터.
정확한 검증 증거는 [feature-catalog](feature-catalog/INDEX.md), 흐름은 [grounding-gate](grounding-gate.md).

## 1. 정체성 — Muse가 무엇인가

- **Attunement (조율)** — 나에 대한 정보만 외우는 것이 아니라, 내 삶에 잘 맞게 돕는 법을 배우는 제품 방향.
  언제 조용히 있고 어떤 도움이 잘 맞는지 결과를 보며 개선한다. 전체 흐름은 **roadmap**이다.
- **Shadow Muse (그림자 Muse)** — 실제로 방해하거나 행동하기 전에 `silent|digest|offer` 후보와
  근거, 제한된 반사실, 사용자의 실제 복귀를 기록해 타이밍을 배우는 **roadmap** 계층.
- **Continuity Capsule (이어가기 캡슐)** — 기존 Continuity Pack의 목표 제품 형태. 멈춘 지점,
  이후 변경점, 정확한 근거, 다음 단계, 준비된 작업, 예상 시간을 한 번에 보여준다(**roadmap**).
- **Policy Card (정책 카드)** — Muse가 이 사람과 협업하는 방식을 어떻게 바꾸려는지 근거·범위와
  함께 보여 주고 시험 적용·수정·거절·되돌리기를 제공하는 **roadmap** 표면.
- **Muse Attunement Graph (MAG)** — Muse 자체의 agent-native graph architecture와 향후
  독립 오픈소스 제품의 공식 명칭. 기존 개인 store를 대체하지 않고
  시간·관계·출처·변경·복귀·정책을 연결하며, 한 turn에 필요한 관계만 Working Graph로
  컴파일한다. 현재 라이브러리 코어는 **partial**이고 durable MAG Store와 standalone package
  gate는 **roadmap**이다.
- **MAG Engine** — MAG의 ontology, receipt projection, temporal/relationship indexes, bounded
  operators, completeness/abstention, Working Graph compiler를 합친 실행 계층.
- **MAG Store** — `node:sqlite`를 기본 물리 저장소로 선택한 Muse 내장 영속 계층. Muse 소유 append
  journal, 재시작 복구, 인덱스, migration, export/rebuild, physical forget을 제공할 **roadmap**
  기능이다. PostgreSQL은 optional Adapter이며 외부 Graph DB·Redis·MySQL은 필수가 아니다.
- **MAG Source Adapter** — 권위 source를 읽어 bounded observation과 exact identity를 만드는
  교체 가능한 Module. Markdown/Obsidian/Notion Adapter는 계획된 source 연결이고 MAG Store가
  아니다. 기존 Markdown notes/Notion provider가 곧 MAG round-trip Adapter가 완성됐다는 뜻은
  아니다.
- **Receipt (증거 영수증)** — 특정 시점의 source observation·결정·상호작용을 bounded immutable
  envelope와 content ID로 묶은 입력 증거. Receipt 자체가 Graph DB는 아니며 MAG가 검증된 receipt를
  Evidence Graph의 node/relation으로 투영한다.
- **Evidence Graph** — receipt와 권위 source에서 재생성 가능한 장기 사실·시간·출처·관계 계층.
- **Working Graph** — 한 agent 판단을 위해 Evidence Graph에서 token budget 안으로 컴파일한
  짧은 수명 계층. 전체 개인 그래프나 chain-of-thought가 아니다.
- **Activation Subgraph** — 현재 thread, 변경점, 근거, 정책, 권한 경계만 token budget 안에 담아
  에이전트에 전달하는 짧은 수명 그래프. 전체 개인 그래프나 chain-of-thought가 아니다.
- **Observe (관찰 설정)** — 무엇을 수집하는지 보고, 멈추고, 확인하고, 지울 수 있게 하는 화면과
  명령(**roadmap**). 키 입력과 연속 화면 녹화는 기본 수집 대상이 아니다.
- **Personal Rhythm Model (개인 생활 리듬 모델)** — 앱에 머문 시간과 활동 전환처럼 최소한의 기록으로
  만든 생활·업무 흐름 요약(**roadmap**). 성격이나 심리를 진단하는 모델이 아니다.
- **Friction Discovery (반복 불편 발견)** — 일이 자주 끊기는 후보를 근거와 함께 보여주고, 사용자가
  “평소 흐름/탐색/막힘” 중 무엇인지 바로잡는 단계(**roadmap**).
- **Intervention outcome / adaptation (도움 결과와 개선)** — 도움을 썼는지·고쳤는지·거절했는지를
  기록해 다음 도움의 시점과 형태만 바꾸는 과정(**roadmap**). 권한이나 수집 범위는 넓히지 않는다.
- **Personal Continuity (삶의 맥락 이어주기)** — 사용자가 고른 미완료 주제의 관련 기억과 다음 한
  단계를 준비하는 첫 사용자 경험(**roadmap**). 업무·일정·생활 계획을 모두 담을 수 있다.
- **Muse Work / Work Resumption (업무 복귀)** — Personal Continuity를 업무에 특화해 쓰는 모드.
  Muse 전체가 업무 도우미라는 뜻도, 컴퓨터 전체를 자동 조작한다는 뜻도 아니다.
- **Local-first** — 개인 store와 로컬 모델 경로를 우선 지원하지만 provider-neutral 선택을 유지한다.
  “항상 로컬” 보장은 `MUSE_LOCAL_ONLY=true`를 사용한 명시적 자세에서만 주장한다.
- **MUSE_LOCAL_ONLY** — 클라우드 송출 fail-close 정책 플래그. 켜져 있으면 model-router가
  클라우드 provider 인스턴스화 *전에* `LocalOnlyViolationError`를 던진다. 음성/임베딩도 로컬로 강제.
- **Provider-neutral / model-agnostic** — `agent-core`는 vendor SDK를 직접 부르지 않고 Muse 소유의
  `ModelProvider` 추상화만 부른다. vendor 코드는 `packages/model/adapters/*` 가장자리에만 산다.
- **Grounding floor (그라운딩 플로어)** — 개인 근거를 사용하는 지원 경로에서 실제 source를
  확인하고, 약한 근거를 낮추며, 잘못된 인용을 거부하는 신뢰 바닥선. 모든 자유대화 문장을
  검증한다는 뜻은 아니다.
- **fabrication = 0 (배터리 지표)** — 특정 grounding 평가 배터리에서 근거 없는 출력이 0이어야
  한다는 release metric. 제품 전체와 모든 chat 문장에 대한 보편적 무환각 보장이 아니다.

## 2. 그라운딩 / 리콜 — 신뢰 바닥선

전체 흐름은 [grounding-gate.md](grounding-gate.md). 여기선 용어만.

- **Grounding gate (그라운딩 게이트)** — 답변+근거를 받아 결정적(모델 호출 없음)으로 3-way 판정을
  내리는 `verifyGrounding` (`packages/agent-core/src/knowledge-recall.ts`). Attunement가 개인에 대한
  가설을 지어내지 않게 하는 신뢰 바닥선.
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

- **Proactivity (능동성) / earned (획득)** — Muse가 먼저 말 거는 전달 substrate. "earned"는
  휴리스틱이 아니라 *fail-close 게이트*: ratchet으로 뒷받침된 자격을 통과해야만 능동 알림이 나간다.
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
