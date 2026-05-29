# Muse

> **다 털어놔도 되는 AI.**

네 메모와 파일에서 출처까지 인용해 답하고, 모르면 지어내지 않고
"잘 모르겠어"라고 말한다. 전부 네 기기 안에서만 돌아가고, 한 글자도
밖으로 안 나간다 — 약속이 아니라 코드로 막아뒀다.

**빠른 시작:** `muse onboard` 가 설치 직후부터 첫 인용 답변까지 **다음 한
명령씩** 안내한다 (노트 폴더를 가리키거나, ChatGPT/Claude export·`.mbox`를
`muse ingest` 한 뒤 `muse ask --notes-only "…"`).

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
모델(Ollama의 qwen3:8b, 또는 네가 로컬에서 띄운 HuggingFace 가중치)을
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
                      Local / Google / CalDAV / macOS 어댑터 +
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
# 요구사항: Node.js 24 LTS + pnpm 10
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
muse setup calendar   # Local / Google / CalDAV / macOS multi-select
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
pnpm check                                      # 모든 workspace의 build + test (~789 tests)
pnpm smoke:broad                                # 42개 HTTP 엔드포인트, diagnostic provider
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
| `MUSE_CALENDAR_PROVIDERS` | `local` | 콤마 리스트: `local,gcal,caldav,macos` |
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
