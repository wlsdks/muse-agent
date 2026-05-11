# Muse

A provider-neutral, JARVIS-style personal AI conductor. One coherent
reasoning loop, any LLM, any tool, any MCP server.

[한국어 README →](README.ko.md)

## What Muse is

Muse orchestrates an LLM-powered agent without locking you into a
single vendor. The same `agent-core` runtime drives the API server,
the CLI, and the React web UI — and you choose the model provider at
runtime, not at build time.

- **Model-neutral core.** OpenAI, Anthropic, Google Gemini, OpenRouter,
  Ollama, LM Studio, and any OpenAI-compatible endpoint live behind a
  single `ModelProvider` adapter. The runtime calls the abstraction,
  never a vendor SDK directly.
- **Tool & MCP first.** Tools are first-class — read, write, or
  execute — with explicit risk levels, approval gates, and
  deterministic loop limits. Eight built-in loopback servers
  (`muse.time`, `muse.text`, `muse.math`, `muse.json`, `muse.url`,
  `muse.crypto`, `muse.diff`, `muse.regex`) plus the personal trio
  (`muse.notes`, `muse.tasks`, `muse.calendar`) ship in-process;
  external servers connect over stdio / SSE / streamable-HTTP.
- **Personal-domain primitives.** Markdown notes, calendar events
  across 4 providers (Local file, Google Calendar, CalDAV, macOS
  Calendar.app), and a todo list — all stored locally by default,
  queryable by the agent, and editable from CLI / Web UI.
- **Multi-agent orchestration.** Sequential or parallel worker
  fan-out, an in-memory cross-agent message bus, per-run history
  with full conversation snapshots, and aggregate stats — all
  exposed over HTTP and SSE.
- **Deterministic safety.** Guards are fail-close, hooks are
  fail-open, and security lives in code (not in prompt instructions).
  Tool output is untrusted until sanitised. Risky local execution
  flows through a separate Rust runner (`crates/runner`).

## Architecture at a glance

```
apps/
  api/        Fastify API server (chat, agent specs, multi-agent, MCP,
              scheduler, calendar, tasks)
  cli/        terminal agent (commander + Ink TUI + setup wizards)
  web/        React UI (chat + tasks + calendar + settings)

packages/
  agent-core/         ReAct + Plan-Execute loops, guard pipeline,
                      hook registry, context transforms, model loop
  model/              ModelProvider interface + provider wire-format
                      adapters (OpenAI / Anthropic / Gemini / Ollama)
  tools/              tool registry, executor, sanitiser, approval path
  multi-agent/        SupervisorAgent, MultiAgentOrchestrator,
                      message bus, history
  mcp/                MCP transports + loopback servers (incl.
                      notes / tasks / calendar) + NotesProvider abstraction
  calendar/           CalendarProvider abstraction +
                      Local / Google / CalDAV / macOS adapters +
                      chmod-600 credential store
  policy/             input / output guards, approval policies,
                      adversarial red-team harness
  memory/             context trimming, conversation summaries,
                      user-memory store + auto-extraction hook
  observability/      tracing, latency / token-cost queries,
                      JARVIS snapshot
  runtime-state/      run history, hook traces, approval store
  db/                 Kysely schema + SQL migrations
  scheduler/          cron jobs + distributed locks
  ...

crates/
  runner/             Rust sandbox: shell / process / file execution
```

## Quick start

```bash
# Requirements: Node.js 24 LTS + pnpm 10
pnpm install
pnpm build
pnpm test

# Bring up the API with a real provider:
GEMINI_API_KEY=… MUSE_MODEL=gemini/gemini-2.0-flash MUSE_MODEL_PROVIDER_ID=gemini \
  pnpm --filter @muse/api dev

# Talk to it:
curl -X POST http://127.0.0.1:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What time is it? Use a tool."}'

# Or use the CLI:
node apps/cli/dist/index.js \
  --api-url http://127.0.0.1:3000 \
  chat "What time is it? Use a tool."

# Or open the Web UI:
pnpm --filter @muse/web dev   # http://localhost:5173
```

Native web search is enabled by default for OpenAI / Anthropic / Gemini.
Responses include `citations[]`; disable with `MUSE_WEB_SEARCH=off`.

## Personal-domain tools

The agent ships three personal-pivot loopback MCP servers, all
JSON/markdown file-backed by default:

- **`muse.notes.*`** — markdown notes inside `~/.muse/notes/` (or any
  directory you point `MUSE_NOTES_DIR` at, including an Obsidian
  vault). Tools: list / read / search / save / append.
- **`muse.tasks.*`** — todo list in `~/.muse/tasks.json`. Tools:
  add / list / complete / search.
- **`muse.calendar.*`** — provider-neutral calendar with 4 adapters
  (Local file → `~/.muse/calendar.json`, Google Calendar OAuth,
  CalDAV for iCloud / Fastmail / Proton, macOS Calendar.app).
  Tools: providers / list / add / update / delete.

Set up calendar providers interactively:

```bash
muse setup calendar   # multi-select Local / Google / CalDAV / macOS
                      # OAuth + app-password flows; chmod-600 credentials
```

Or via env vars (`MUSE_CALENDAR_PROVIDERS=local,gcal`,
`MUSE_GCAL_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`,
`MUSE_CALDAV_URL`/`USERNAME`/`APP_PASSWORD`,
`MUSE_MACOS_CALENDAR_NAME`).

### Provider live-verification status

| Provider | Status | What's verified |
| --- | --- | --- |
| `muse.notes` (LocalDir) | `live` | smoke:live `muse.notes.search` exercises Gemini → fs grep |
| `muse.tasks` (Local) | `live` | smoke:live `muse.tasks.add` + unit lifecycle (add/list/complete/search) |
| `muse.calendar` Local | `live` | smoke:live `muse.calendar.add` + 20 unit tests |
| `muse.calendar` Google | `scaffold` | OAuth refresh-token flow + REST v3; needs user-issued OAuth client to exercise live |
| `muse.calendar` CalDAV | `scaffold` | REPORT/PUT/DELETE iCalendar; needs iCloud / Fastmail / Proton app-password to exercise live |
| `muse.calendar` macOS | `scaffold` | osascript wrapper; first call triggers system permission prompt |
| `NotesProvider` Apple | `stub` | Interface defined; throws NOT_IMPLEMENTED until osascript adapter lands |
| `NotesProvider` Notion | `stub` | Interface defined; throws NOT_IMPLEMENTED until api.notion.com adapter lands |

## Verification

Tests are the only form of verification. The repo ships these gates:

```bash
pnpm check                                      # build + test for every workspace (~789 tests)
pnpm smoke:broad                                # 42 HTTP endpoints, diagnostic provider
pnpm smoke:live                                 # 12 HTTP endpoints, real LLM (auto-skips without key)
```

`smoke:live` runs against the first available `*_API_KEY`
(`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and
asserts the model→tool→model loop end-to-end across direct chat,
streaming SSE, plan-execute, input guards, multi-agent
orchestration, `muse.notes.search`, `muse.tasks.add`, and
`muse.calendar.add`.

## Provider configuration

Pick a model at runtime via env:

| Env | Example | Notes |
| --- | --- | --- |
| `MUSE_MODEL` | `gemini/gemini-2.0-flash` | `<providerId>/<modelId>` form |
| `MUSE_MODEL_PROVIDER_ID` | `gemini` | optional override; inferred from prefix |
| `MUSE_MODEL_API_KEY` | `…` | per-provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) also work |
| `MUSE_MODEL_BASE_URL` | `http://localhost:11434/v1` | overrides for OpenAI-compatible endpoints (Ollama, LM Studio, custom) |

Personal-domain toggles:

| Env | Default | Effect |
| --- | --- | --- |
| `MUSE_NOTES_DIR` | `~/.muse/notes` | Markdown notes directory (point at Obsidian vault to query it) |
| `MUSE_NOTES_ENABLED` | `true` | Disable `muse.notes.*` tools |
| `MUSE_TASKS_FILE` | `~/.muse/tasks.json` | Todo list file |
| `MUSE_TASKS_ENABLED` | `true` | Disable `muse.tasks.*` tools |
| `MUSE_CALENDAR_FILE` | `~/.muse/calendar.json` | Local calendar provider file |
| `MUSE_CALENDAR_PROVIDERS` | `local` | Comma list: `local,gcal,caldav,macos` |
| `MUSE_CREDENTIALS_FILE` | `~/.muse/credentials.json` | chmod-600 OAuth / app-password store |
| `MUSE_USER_MEMORY_AUTO_EXTRACT` | `false` | LLM auto-extracts facts/preferences after each turn |

## Contributing

This repo follows a lean-contract style for Claude Code
collaboration. Start here:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, verification
  gates, commit / lint / test discipline.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor
  Covenant 2.1.
- [`SECURITY.md`](SECURITY.md) — private-disclosure flow for
  vulnerabilities.
- [`CLAUDE.md`](CLAUDE.md) — the contract every Claude Code agent
  reads first (under 100 lines, points at the rule files below).
- [`AGENTS.md`](AGENTS.md) — cross-agent product brief.
- [`.claude/rules/`](.claude/rules/) — domain-specific rules
  (architecture, testing, commits, code style, …).
- [`.claude/commands/`](.claude/commands/) — reusable slash commands.
- [`.claude/agents/`](.claude/agents/) — subagent definitions.
- [`CHANGELOG.md`](CHANGELOG.md) — running development log
  (Keep a Changelog format).

Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`,
`docs:`, `chore:`). Commits and PR descriptions are written in
English so multi-locale contributors and tooling stay aligned.

## License

[MIT](LICENSE). The runtime, adapters, and tooling are open
source. Contributions are accepted under the same terms — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the flow.
