# Muse

> **세상이 아니라, 너를 학습한다.** — *Learns you, not the world.*
>
> *매일 너를 조금 더 깊이 학습하고, 오직 네 기기에만 살고, 네가 말하는 순간 잊는다.*

대부분의 AI는 온 세상을 학습한다 — 그리고 너를, 모두를 위해. Muse는 **너를**, **너를
위해** 학습한다: ChatGPT엔 절대 못 붙여넣을 네 메모·파일에서 네가 누구인지 모델을 만들고,
너에게 먹히는 걸 강화하고, **네가 교정하는 순간 잊는다**. 그 '너 모델'은 네 기기를 절대
안 떠나고(클라우드 유출은 약속이 아니라 **코드로 막아뒀다**), 모든 주장은 출처를 인용한다 —
근거 약하면 "잘 모르겠어". 깊이 알수록, 더 네 것이 된다.

## Muse가 뭔가 — 다섯 가지 원칙

이 다섯 개만 읽으면 어떤 에이전트인지 바로 안다.

1. **너를 학습한다 — _세상이 아니라._**
   Muse는 *네가* 누구인지에 대한 모델을 만든다 — 네 사실·선호·목표, 그리고 절대
   제안하면 안 되는 것들을, 네가 말하고 교정한 것에서. 너에게 먹히는 전략을 강화하고
   (**Playbook**), 자기 약점을 갈아내고(**Whetstone**), 쌓기만 하는 여느 "기억"과 달리
   **네가 교정하는 순간 잊는다**. 가중치 변경 없이 매일 *너에 대해* 날카로워지는 고정된
   로컬 뇌. (`muse memory`, `muse doctor --weaknesses`)

2. **네 것이다 — _그 '너 모델'은 절대 안 나간다._**
   전부 로컬 오픈소스 모델(기본 Ollama gemma4:12b — 멀티모달+그라운딩 강함)에서 돌고, 그
   '너 모델'은 네 기기에만 남는다. 클라우드 유출은 **코드로 거부**된다(`MUSE_LOCAL_ONLY`
   기본 ON) — 명시적으로 끄지 않는 한 클라우드 프로바이더로는 시작도 안 한다. 깊이 알수록
   그게 더 중요해진다.

3. **정직하다 — _너를 지어내지 않는다._**
   모든 답·알림·통찰이 실제 출처를 인용하고, 근거 약하면 "잘 모르겠어", 근거 없는 주장은
   **코드가 드롭**한다(회상·proactivity·반성·chat 전부). fabrication=0이 릴리스 게이트 —
   그래서 깊어지는 '너 모델'이 절대 더 위험해지지 않는다.

4. **자연의 메커니즘을 증류한다 — _교차분야 moat._**
   **생물학·생태학·신경과학** 등 공개 논문에서 진짜 메커니즘을 뽑아 결정적·라이브검증
   기능으로 만든다: 최적 먹이찾기 → 적응적 회상 깊이, 개미 스티그머지 → 증발하는 노트
   관계 그래프, 알로스타시스 → 반복 필요 예측, 다양성 지수 → 한쪽으로 쏠린 코퍼스 탐지.
   기능은 베껴도, *fabrication-zero에 묶인 연구-증류 규율*은 베끼기 어렵다.

5. **네 것 — _draft-first, 절대 자율 전송 안 함._**
   네 실제 도구(캘린더·노트·할일·리마인더·웹)로 행동하되, 타인에게 보내거나 행동하는
   건 draft-first + 네 명시적 확인 필수. 금융·송금은 영구 범위 밖.

원칙 1이 *Muse가 무엇인지*(너를 학습), 원칙 2–3이 *그걸 왜 믿어도 되는지*(학습은 네
것이고 정직하다), 원칙 4가 *어떻게* 계속 베낄 수 없는 능력을 얻는지.

### 자연에서 빌려온 것 (원칙 4의 실제)

생물학/생명과학의 진짜 결과를 라이브검증 기능으로 증류한 사례 (전 분야 20개 메커니즘
전체 카탈로그: [`docs/strategy/differentiation.md`](docs/strategy/differentiation.md)):

| 분야 | 메커니즘 (논문) | Muse 기능 |
| --- | --- | --- |
| 생태학 | 최적 먹이찾기 / 한계가치정리 (Charnov 1976) | `muse recall --adaptive` — 근거가 얼마나 충분한지로 반환 소스 수를 적응적으로 결정 |
| 생물다양성 | Shannon·Simpson 다양성 지수 (1948/1949) | `muse diversity` — 어떤 범주가 한쪽으로 쏠렸나 다양한가 |
| 집단행동/생물 | 스티그머지 / 개미 페로몬 길 (Grassé 1959) | `muse notes trails`/`hubs` — 증발하는 공동-회상 관계 그래프 |
| 생리학/신경 | 알로스타시스(예측적 항상성) (Sterling 2012) | `muse pattern upcoming` — 반복되는 필요를 슬롯 전에 예측 |
| 생태학/네트워크 | 핵심종·중개중심성 (Paine 1966; Freeman 1977) | `muse notes bridges` — 분리된 주제군을 잇는 노트(교차통찰의 자리) |
| 네트워크 과학 | k-shell 영향력 확산자 (Kitsak 2010) | `muse notes hubs` — 노트의 하중을 지탱하는 핵심부(차수가 아닌 깊이) |

깊이: [차별점](docs/strategy/differentiation.md) · [검증된 기능 카탈로그](docs/feature-catalog/INDEX.md) ·
[프런티어 리서치](docs/strategy/frontier-research-2026-06.md).

**빠른 시작:** `muse onboard` 가 설치 직후부터 첫 인용 답변까지 **다음 한
명령씩** 안내한다 (노트 폴더를 가리키거나, ChatGPT/Claude export·`.mbox`를
`muse ingest` 한 뒤 `muse ask --notes-only "…"`).

## 차별점: Muse는 근거를 보여준다 — 모든 것에 대해

로컬 구동은 *기본값*이지 핵심이 아니다. Muse를 써야 하는 *기능적* 이유는
이것이다: **모든 답변, 모든 능동 알림, 그리고 너에 대해 형성하는 모든 통찰이
실제 출처를 인용하고 — 결정론적 게이트가 "확신에 찬 오답"을 코드로 불가능하게
만든다.** 약한 근거는 추측이 아니라 "잘 모르겠어"가 되고, 실제로 가진 것을 댈
수 없는 인용은 지어내는 대신 버려진다.

hermes는 자기발전하지만 지어낼 수 있고, openclaw는 dreaming하지만 그 꿈은
grounded 아니다. **Muse만 — 능동적이고 자기학습하면서도 단 한 글자도
지어내지 않고, 모든 걸 검증 가능하다** — 그리고 이를 계속 측정한다(fabrication
rate = 0이 릴리스 게이트). 같은 grounding 게이트가 회상·능동성·reflection을
관장하며, Muse가 얻는 모든 표면이 여기 꽂힌다.
전체 근거: [`docs/strategy/differentiation.md`](docs/strategy/differentiation.md).

[English README →](README.md)

## Muse가 무엇인가

Muse는 **진짜 네 것인** AI 비서다. ChatGPT엔 절대 못 붙여넣을 노트·
파일·메일을 가리키면, **네 자신의** 자료에서 정확한 구절을 인용해
답한다. 신뢰를 얻는 핵심은 *확신이 없을 때* 하는 행동이다 — 모델의
추측이 아니라 결정론적 신뢰도 게이트가 약한 매칭을 "검증 후 사용"으로
표시하고, 지어내는 대신 "일치하는 구절 없음"이라고 말한다. 오직 너만
학습하고 시간이 지날수록 더 *너*가 되며, 캘린더·노트·태스크·메시징·웹
등 실제 도구로 행동하되 — 언제나 draft-first, 자율 전송은 없다.

그리고 **전부 네 기기 안에서** 돈다. 기본값으로 Muse는 로컬 오픈소스
모델(기본 Ollama gemma4:12b, 또는 네가 로컬에서 띄운 HuggingFace 가중치)을
쓰고 **클라우드 egress를 코드로 거부한다** — `MUSE_LOCAL_ONLY`가 기본
ON이라, 명시적으로 옵트아웃(해서 보장을 포기)하지 않는 한 런타임은
클라우드 provider를 상대로 *부팅조차 하지 않는다.* 남의 클라우드 위의
네 에이전트가 아니라, 진짜 네 것. 동일 런타임이 CLI·API·웹 UI를
구동하고 — 벤더 중립 코어는 옵트아웃 시 어떤 provider든 닿을 수 있지만,
**로컬이 기본이자 지켜내는 자세**다. 내부 구조:

- **벤더 중립 코어.** OpenAI, Anthropic, Google Gemini, OpenRouter,
  Ollama, LM Studio, 그리고 OpenAI-compatible 엔드포인트가 모두
  하나의 `ModelProvider` 어댑터 뒤에 위치한다. 런타임은 추상화만
  호출하고, 벤더 SDK를 직접 부르지 않는다.
- **Tool & MCP 우선.** 도구는 1급 시민이며 read / write / execute
  세 가지 위험 등급을 갖는다. 8개의 빌트인 loopback 서버
  (`muse.time`, `muse.text`, `muse.math`, `muse.json`, `muse.url`,
  `muse.crypto`, `muse.diff`, `muse.regex`)와 개인용 trio
  (`muse.notes`, `muse.tasks`, `muse.calendar`)가 인-프로세스로
  탑재되어 있고, 외부 서버는 stdio / SSE / streamable-HTTP
  트랜스포트로 연결한다.
- **개인 도메인 프리미티브.** 마크다운 노트, 4개 공급자 (로컬
  파일 / Google Calendar / CalDAV / macOS Calendar.app)에 걸친
  캘린더 이벤트, todo 리스트 — 기본적으로 모두 로컬에 저장되며
  에이전트가 질의 가능하고 CLI / Web UI에서도 편집 가능하다.
- **멀티 에이전트 오케스트레이션.** Sequential / parallel worker
  fan-out, 인메모리 cross-agent 메시지 버스, 전체 conversation
  스냅샷이 포함된 per-run 히스토리, 집계 통계 — 모두 HTTP와
  SSE로 노출된다.
- **결정론적 안전성.** Guard는 fail-close, hook은 fail-open이며
  보안 로직은 코드에만 존재한다 (프롬프트 지시가 아니다). 도구
  출력은 sanitise 전까지 신뢰하지 않는다. 위험한 로컬 실행은 별도
  Rust 러너 프로세스 (`crates/runner`)를 통해서만 수행한다.

## 아키텍처 개요

```
apps/
  api/        Fastify API 서버 (chat, agent specs, multi-agent, MCP,
              scheduler, calendar, tasks)
  cli/        터미널 에이전트 (commander + Ink TUI + setup wizard)
  web/        React UI (chat + tasks + calendar + settings)

packages/
  agent-core/         ReAct + Plan-Execute 루프, guard 파이프라인,
                      hook 레지스트리, context transforms, model loop
  model/              ModelProvider 인터페이스와 공급자 wire-format
                      어댑터 (OpenAI / Anthropic / Gemini / OpenRouter /
                      Ollama + OpenAI-호환 프리셋: Groq / DeepSeek /
                      Together / Mistral / Moonshot / Cerebras)
  tools/              tool 레지스트리, executor, sanitiser, 승인 경로
  multi-agent/        SupervisorAgent, MultiAgentOrchestrator,
                      메시지 버스, 히스토리
  mcp/                MCP 트랜스포트와 loopback 서버들 (notes /
                      tasks / calendar 포함) + NotesProvider 추상화
  calendar/           CalendarProvider 추상화 +
                      Local / Local-ICS / Google / CalDAV / macOS 어댑터 +
                      chmod-600 자격증명 저장소
  policy/             input / output guard, 승인 정책,
                      adversarial red-team
  memory/             컨텍스트 트리밍, 대화 요약, user-memory
                      저장소 + 자동 추출 hook
  observability/      tracing, latency / token-cost 쿼리,
                      JARVIS 스냅샷
  runtime-state/      run history, hook trace, approval 저장소
  db/                 Kysely 스키마 + SQL 마이그레이션
  scheduler/          cron 잡 + 분산 락
  ...

crates/
  runner/             Rust 샌드박스: shell / process / file 실행
```

## 빠른 시작

```bash
# 요구사항: Node.js >= 22.12 (24 LTS 권장) + pnpm 10
pnpm install
pnpm build
pnpm test

# 실제 공급자로 API 띄우기:
GEMINI_API_KEY=… MUSE_MODEL=gemini/gemini-2.0-flash MUSE_MODEL_PROVIDER_ID=gemini \
  pnpm --filter @muse/api dev

# 호출:
curl -X POST http://127.0.0.1:3030/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"몇 시야? 도구 써."}'

# CLI로 호출:
node apps/cli/dist/index.js \
  --api-url http://127.0.0.1:3030 \
  chat "몇 시야? 도구 써."

# Web UI:
pnpm --filter @muse/web dev   # http://localhost:5173
```

OpenAI / Anthropic / Gemini는 네이티브 웹 검색이 기본 활성. 응답에
`citations[]`가 포함되고, `MUSE_WEB_SEARCH=off`로 끌 수 있다.

## 개인 도메인 도구

에이전트는 personal-pivot loopback MCP 서버 3종을 탑재한다.
기본은 모두 JSON / 마크다운 파일 기반:

- **`muse.notes.*`** — `~/.muse/notes/` 디렉토리(또는
  `MUSE_NOTES_DIR`이 가리키는 곳, Obsidian vault도 가능)의 마크다운
  노트. 도구: list / read / search / save / append.
- **`muse.tasks.*`** — `~/.muse/tasks.json`의 todo 리스트. 도구:
  add / list / complete / search.
- **`muse.calendar.*`** — 4개 어댑터를 가진 공급자 중립 캘린더
  (Local 파일 → `~/.muse/calendar.json`, Google Calendar OAuth,
  iCloud / Fastmail / Proton용 CalDAV, macOS Calendar.app).
  도구: providers / list / add / update / delete.

캘린더 공급자 인터랙티브 셋업:

```bash
muse setup calendar   # Local / Local-ICS / Google / CalDAV / macOS multi-select
                      # OAuth + app-password 플로우; chmod-600 자격증명
```

또는 환경변수로 (`MUSE_CALENDAR_PROVIDERS=local,gcal`,
`MUSE_GCAL_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`,
`MUSE_CALDAV_URL`/`USERNAME`/`APP_PASSWORD`,
`MUSE_MACOS_CALENDAR_NAME`).

### 공급자 라이브 검증 상태

| Provider | 상태 | 검증 범위 |
| --- | --- | --- |
| `muse.notes` (LocalDir) | `live` | smoke:live `muse.notes.search` Gemini → fs grep |
| `muse.tasks` (Local) | `live` | smoke:live `muse.tasks.add` + unit 라이프사이클 (add/list/complete/search) |
| `muse.calendar` Local | `live` | smoke:live `muse.calendar.add` + 20개 unit 테스트 |
| `muse.calendar` Google | `scaffold` | OAuth refresh-token 플로우 + REST v3; 사용자 발급 OAuth client로 라이브 검증 가능 |
| `muse.calendar` CalDAV | `scaffold` | REPORT/PUT/DELETE iCalendar; iCloud / Fastmail / Proton 앱 비번 필요 |
| `muse.calendar` macOS | `scaffold` | osascript 래퍼; 첫 호출 시 시스템 권한 prompt |
| `NotesProvider` Apple | `stub` | 인터페이스만 정의. osascript 어댑터 구현되면 라이브 |
| `NotesProvider` Notion | `stub` | 인터페이스만 정의. api.notion.com 어댑터 구현되면 라이브 |

## 검증

테스트만이 검증의 유일한 방식이다. 저장소는 다음 게이트를
제공한다:

```bash
pnpm check                                      # 모든 workspace의 build + test (27개 패키지, 수천 개 테스트)
pnpm smoke:broad                                # 51개 HTTP 검사, diagnostic provider
pnpm smoke:live                                 # 12개 HTTP 엔드포인트, 실 LLM (키 없으면 자동 skip)
```

`smoke:live`는 사용 가능한 첫 번째 `*_API_KEY` (`GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)로 실행되며, 직접 chat,
스트리밍 SSE, plan-execute, input guard, multi-agent
오케스트레이션, `muse.notes.search`, `muse.tasks.add`,
`muse.calendar.add`까지 model→tool→model 루프를 end-to-end로
검증한다.

## 공급자 설정

런타임에 환경변수로 모델을 고른다:

| 환경변수 | 예시 | 비고 |
| --- | --- | --- |
| `MUSE_MODEL` | `gemini/gemini-2.0-flash` | `<providerId>/<modelId>` 형식 |
| `MUSE_MODEL_PROVIDER_ID` | `gemini` | 옵션; prefix에서 추론됨 |
| `MUSE_MODEL_API_KEY` | `…` | 공급자별 환경변수 (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`)도 동작 |
| `MUSE_MODEL_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible 엔드포인트 오버라이드 (Ollama, LM Studio, custom) |

개인 도메인 토글:

| 환경변수 | 기본값 | 효과 |
| --- | --- | --- |
| `MUSE_NOTES_DIR` | `~/.muse/notes` | 마크다운 노트 디렉토리 (Obsidian vault도 가능) |
| `MUSE_NOTES_ENABLED` | `true` | `muse.notes.*` 도구 비활성화 |
| `MUSE_TASKS_FILE` | `~/.muse/tasks.json` | Todo 리스트 파일 |
| `MUSE_TASKS_ENABLED` | `true` | `muse.tasks.*` 도구 비활성화 |
| `MUSE_CALENDAR_FILE` | `~/.muse/calendar.json` | 로컬 캘린더 공급자 파일 |
| `MUSE_CALENDAR_PROVIDERS` | `local` | 콤마 리스트: `local,ics,gcal,caldav,macos` (`ics`는 `~/.muse/calendar.ics` 있으면 자동 추가) |
| `MUSE_CREDENTIALS_FILE` | `~/.muse/credentials.json` | chmod-600 OAuth / app-password 저장소 |
| `MUSE_USER_MEMORY_AUTO_EXTRACT` | `true` | 매 턴 후 LLM이 사실/선호 자동 추출 — 매 턴 추가 호출이 부담될 땐 `false`로 끄세요 |

## 기여

이 저장소는 Claude Code 협업을 위해 lean-contract 스타일을 따른다:

- [`CLAUDE.md`](CLAUDE.md) — 모든 Claude Code 에이전트가 가장 먼저 읽는 계약 파일.
- [`AGENTS.md`](AGENTS.md) — cross-agent 제품 브리프.
- [`.claude/rules/`](.claude/rules/) — 도메인별 규칙 (architecture, testing, commits, …).
- [`.claude/commands/`](.claude/commands/) — 재사용 가능한 슬래시 명령.
- [`.claude/agents/`](.claude/agents/) — 서브에이전트 정의.
- [`CHANGELOG.md`](CHANGELOG.md) — 진행 중인 개발 로그 (Keep a Changelog 형식).

Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
`chore:`)을 사용하며, 모든 커밋과 PR 설명은 영어로 작성한다.

## 라이선스

미정. 런타임, 어댑터, 툴링 모두 오픈소스를 지향한다.
