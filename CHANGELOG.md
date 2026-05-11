# Changelog

All notable changes to Muse are recorded here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is in
continuous iteration on `main`; once a tagged release exists, sections will
move from `Unreleased` to dated/versioned headings.

## [Unreleased]

### Added

- **Native server-side `web_search`** is now default-on across OpenAI /
  Anthropic / Gemini. The agent surfaces normalized `citations[]` on every
  response. Set `MUSE_WEB_SEARCH=off` (env) or `webSearch.enabled=false`
  (runtime-settings) to disable.

  - **Breaking**: the OpenAI adapter migrated from Chat Completions to
    the Responses API (`/v1/responses`). The OpenAI-compatible path
    (`/v1/chat/completions`) used by Ollama / OpenRouter / LM Studio is
    unchanged.
  - **Gemini limitation**: Gemini's `generateContent` API rejects
    requests that mix the built-in `googleSearch` tool with function
    declarations. When Muse auto-registers ambient tools (notes / tasks
    / calendar / messaging / reminders / mcp loopback), function tools
    win and grounding is skipped. To use grounding on Gemini, issue
    requests with no function tools (e.g. set `MUSE_TOOLS_ENABLED=false`
    or pass an empty tool registry).
  - CLI: `muse chat ... --no-web-search` opts out per request.
  - API: `POST /api/chat` accepts `metadata.tools.web_search: false`;
    response body includes `citations[]`; stream emits
    `event: tool_call` (`phase: started|finished`) and
    `event: citations` SSE events.
  - Web UI: assistant messages render citation chips; setup panel has a
    `webSearch.enabled` toggle.

- **`muse calendar events --local`** and **`muse calendar providers
  --local`** complete the `--local` trio. The CLI instantiates
  `LocalCalendarProvider` against `~/.muse/calendar.json` directly.
  OAuth (Google) and CalDAV stay API-only. `muse today --local`
  now also surfaces local-file events instead of skipping calendar.
- **`muse today --brief [--model <id>]`** — JARVIS-style natural
  language summary. Composes the structured briefing, feeds it
  to the configured model with a short system prompt, prints 2-3
  sentences leading with the most time-sensitive item. Works in
  both remote and `--local` mode.
- **`muse setup` (no args)** — configuration health-check across
  model key, MCP entries, calendar credentials, notes/tasks state,
  voice key. Pure read-only inspection, no API needed.
- **`muse today --brief --speak [--audio-voice <name>] [--audio-format <type>]`** —
  pipes the JARVIS brief through the configured TTS provider and
  plays through afplay/aplay. Falls back to a friendly stderr hint
  when no voice provider is configured. Shared playback helper
  (`voice-playback.ts`) ready for any future "speak this" surface.
- **`muse.reminders.{add, due, clear}` MCP loopback** — agent
  surface for the reminder store. The LLM can now schedule its
  own reminders ("내일 6시에 우유 사라고 알려줘" → `add` with
  parsed dueAt), check what the user should see right now (`due`
  status filter for overdue+now-or-earlier pending), and remove
  one by id (`clear`). Always-on at `~/.muse/reminders.json`
  (catalog total: 11 → 12); the file self-creates on first write.
- **`muse remind` — passive personal reminders + `muse today` integration**.
  `muse remind <when> <text...>` adds an entry to
  `~/.muse/reminders.json` (or `MUSE_REMINDERS_FILE`). `<when>`
  accepts the same grammar as task `--due` (ISO-8601 or relative
  phrase, e.g. "tomorrow at 6pm"). `muse today` (both API and
  CLI `--local`) now surfaces overdue + within-lookahead pending
  reminders so the morning briefing is your reminder check-in.
  Active firing through messaging (`muse remind --send-now`) is a
  follow-up — this iter is read-only at fire time. Companion REST
  surface: `GET/POST/DELETE /api/reminders` with `?status=pending|fired|all|due`.
- **`muse setup messaging` interactive wizard** — `@clack/prompts`
  multiselect of Telegram / Discord / Slack / LINE, masked password
  prompt per token, persists to `~/.muse/messaging.json`
  (chmod 600 via `FileMessagingCredentialStore`). Existing tokens
  shown masked with a replace-or-keep confirm. KakaoTalk skipped
  on purpose. `buildMessagingRegistry(env)` now reads both env
  tokens and the credentials file (env wins on conflict), so
  setup-once-then-use works without re-exporting on every shell.
  `muse setup` status surfaces per-provider source ("telegram
  (file)", "discord (env)") for instant diagnosis.
- **`muse.messaging.{providers, send}` MCP loopback tool** — Phase 3
  of the messenger plan. Once any provider env token is set, the
  agent runtime auto-registers a loopback MCP server so the LLM can
  itself send Telegram / Discord / Slack / LINE messages
  ("remind me on Telegram when the deploy finishes"). Send is
  marked `risk: "write"` for the policy layer; structured errors
  (`PROVIDER_NOT_FOUND`, validation, upstream failures) come back
  as `{ error, providerErrorCode, upstreamStatus? }`. Catalog entry
  is opt-in (requires one of the four env tokens).
- **`@muse/messaging` package + `muse messaging {providers, send}` CLI**
  — Phase 1 (outbound) of the Telegram / Discord / Slack / LINE
  integration. Provider-neutral contract mirrors `@muse/calendar`
  (`MessagingProvider` / `MessagingProviderRegistry` /
  `FileMessagingCredentialStore`); each platform is a thin REST
  wrapper around its sendMessage equivalent. Opt-in via env tokens
  (`MUSE_TELEGRAM_BOT_TOKEN` / `MUSE_DISCORD_BOT_TOKEN` /
  `MUSE_SLACK_BOT_TOKEN` / `MUSE_LINE_CHANNEL_ACCESS_TOKEN`).
  KakaoTalk skipped on purpose — Kakao restricts general bots to
  verified business channels. Phase 2 (inbound: polling /
  Socket Mode / webhook) tracked in `docs/design/messaging.md`.

### Removed

- `muse memory --user <id>` flag — Muse is single-user, the CLI
  hard-codes `me`. Multi-tenant residue from the Reactor migration.

### Fixed

- **Gemini parallel-tool 400** — when the model issued N parallel
  tool calls (e.g. `muse.tasks.list` + `muse.calendar.list` +
  `muse.notes.list` for "what's on my plate today?"), the wire
  request emitted N separate `role:"function"` messages. Gemini
  requires one `role:"function"` turn with N functionResponse
  parts and 400'd with "the number of function response parts is
  equal to the number of function call parts of the function call
  turn". `toGeminiRequest` now coalesces consecutive tool messages
  into a single turn. Live dogfood: `muse chat "What's on my plate
  today? Check tasks, calendar events, and recent notes."` now
  succeeds where it previously failed 100%.
- **`today` recent-notes ignored subdirectories** — Obsidian-style
  vaults (`dogfood/2026-05-10.md`) never surfaced. The walker is
  now recursive (depth cap 8).
- **Raw stack traces from CLI when API is down** — `apiRequest` now
  translates `ECONNREFUSED` / `ENOTFOUND` to a one-line hint and
  the entrypoint catches uncaught failures so users see
  `muse: <message>` exit 1 instead of an undici stack.

### Changed

- **CLI personal-domain commands print human-readable output by
  default**; pass `--json` to opt back into the raw API response
  for scripting. Affected: `tasks list/add/complete/delete/providers`,
  `notes list/read/search/save/append/providers`, `calendar
  events/providers`, `memory show/set`. `today` already worked this
  way and was the model for the rest. `notes read` now prints the
  file content directly (no more JSON envelope) so the obvious
  pipe `muse notes read foo.md | less` works without `jq`.

### Added

- **`--local` mode for `muse tasks`, `muse notes`, `muse today`** —
  the CLI no longer requires a running API server for personal
  data. `--local` reads/writes `~/.muse/tasks.json` and
  `~/.muse/notes/` directly via the same engine the API uses
  (`@muse/mcp` shared store + `createNotesMcpServer` in-process),
  so on-disk state stays byte-identical between modes. Calendar
  is still served through the API in this iter — its registry
  needs OAuth/CalDAV boot. Three new CLI vitest cases cover
  tasks/notes/today round-trips with `fetch` rigged to throw
  (proves no API hop). Dogfood: `node muse tasks list --local`
  works with the API server stopped.
- **`muse tasks add --due <when>`** — CLI surface caught up to the
  MCP tool. Accepts ISO-8601 or relative phrases ("tomorrow at
  6pm", "in 3 hours", "next Monday"); `POST /api/tasks` parses
  both via the same resolver re-exported from `@muse/mcp`.

### Refactored

- Personal task on-disk shape, atomic writes, status filter, and
  dueAt parsing moved to `@muse/mcp/personal-tasks-store`. The MCP
  loopback tool, the Fastify REST routes, and the CLI's `--local`
  mode now share one implementation; previously the API duplicated
  parsing inline.

### Added

- **`muse listen` CLI** — Voice Phase C from `docs/design/voice-mode.md`.
  Push-to-talk loop: press Enter to start recording, again to stop;
  CLI captures via `sox` (`rec -r 16000 -c 1 -t wav -`), transcribes
  through the configured `SpeechToTextProvider`, sends transcript to
  `/api/chat`, synthesizes the reply via `TextToSpeechProvider`,
  plays through `afplay` (macOS) / `aplay` (Linux). Flags:
  `--lang ko|en` (STT hint), `--voice <name>` (TTS voice id),
  `--format mp3|wav|opus|aac|flac`. Sox / player shells injected via
  `ListenShells` so tests run without audio hardware. Missing sox
  exits 1 with `brew install sox` / `apt install sox` hint; missing
  voice providers (no `OPENAI_API_KEY` / `MUSE_VOICE_OPENAI_API_KEY`)
  exits 1 with the env-var hint. Phase F (wake-word ambient mode +
  local Whisper.cpp / Piper) stays deferred until real
  latency/cost data justifies.
- `muse.tasks.add` (`dueAt`) and `muse.calendar.add`
  (`startsAtIso` / `endsAtIso`) accept relative-time phrases
  in addition to ISO-8601: `tomorrow`, `tomorrow at 6pm`,
  `today at 14:30`, `in 3 hours`, `in 2 days`, `next Monday`,
  `next Monday at 9am`, plus `noon` / `midnight` time suffixes.
  Resolved server-side against the local clock — no more relying
  on the LLM to chain `time_now` + `time_add` correctly.

### Added (round 190)

- **`muse.tasks.add` accepts `dueAt`**. Real bug surfaced via
  dogfood: when a user said "Add a task: 우유 사기 — due
  tomorrow", the LLM responded with "I cannot set a due date" and
  asked to proceed without one — the tool's input schema only
  accepted `title` / `notes` / `tags`. Adds optional
  `dueAt: string` (ISO-8601) to the schema; invalid timestamps are
  rejected with `dueAt must be a valid ISO-8601 timestamp`. The
  field round-trips through the on-disk JSON
  (`PersistedTask.dueAt`) and surfaces in `list` / `search` /
  `complete` responses. Back-compat: legacy entries without
  `dueAt` still parse (the type guard's new branch only rejects
  when `dueAt` is present and non-string). 3 new vitest cases
  (mcp 118 → 121): valid ISO timestamp round-trips through add →
  list → search; invalid timestamp errors with a clear message;
  legacy pre-`dueAt` entry still loads. **Live dogfood verified**:
  real Gemini call with the same Korean prompt that failed before
  ("Add a task: 우유 사기 due 2026-05-15T18:00:00Z") now invokes
  `muse.tasks.add` with both fields, the task persists with
  `dueAt: "2026-05-15T18:00:00.000Z"`, and `GET /api/tasks` shows
  it. Caveat: `dueAt` is currently a free-form ISO timestamp the
  LLM emits; natural-language relative dates ("tomorrow", "next
  Monday") still need the LLM to compose `time_now` + `time_add`
  / `next_weekday` first. The tool composition works (round 179
  shipped those time tools) but the prompt-engineering nudge
  isn't there yet — future iter.

### Added (round 189)

- **`muse mcp config-add` CLI** — flag-driven (non-interactive,
  scriptable) entry adder for `~/.muse/mcp.json`. Round 175's
  `config-show` and round 182's `config-doctor` covered inspection;
  this command closes the editing loop without hand-editing the
  JSON. Supports stdio entries (`--command` / `--arg` repeatable
  / `--cwd` / `--env KEY=VALUE` repeatable) and remote entries
  (`--url` / `--transport streamable|sse` / `--header KEY=VALUE`
  repeatable), plus `--description`, `--disabled`, and `--dry-run`
  (prints merged JSON without writing). Auto-infers transport
  from which flag is set; explicit `--transport` always wins.
  Atomic writes via `mkdirSync(recursive: true)` then
  `writeFileSync` of the merged shape. Duplicate names are
  rejected with a non-zero exit and a clear message. 5 new vitest
  cases (cli 40 → 45): stdio entry round-trips through disk;
  streamable URL with multiple headers; `--dry-run` preserves the
  existing file; duplicate name rejected; missing `--command` and
  `--url` rejected with `must specify either` error. Live dogfood
  verified: created a fresh tmp config, added stdio + streamable
  entries, `config-show` printed both correctly, `config-doctor`
  reported `OK` for both, duplicate-name attempt errored as
  expected. Caveat: the `@clack/prompts` interactive flow (round
  175 design note) is still deferred — flag-driven shipped first
  because it's testable and CI-scriptable.

### Changed

- **`packages/tools/src/muse-tools.ts` decomposition continues**.
  606 → 233 LOC. Three-round combined reduction: 1193 → 233
  (-80%). New `muse-tools-data.ts` (377 LOC) holds the
  data/encoding builders (`createMathEvalTool`, `createHashTextTool`,
  `createCsvParseTool`, `createBase64Tool`) plus their private
  helpers (`evaluateArithmetic`, `parseCsvRecords`, `padBase64`)
  and constants (`MATH_EXPRESSION`, `HASH_TEXT_ALGORITHMS`,
  `CSV_PARSE_*`, `BASE64_MAX_TEXT_LENGTH`). `muse-tools.ts` now
  carries only `createJsonQueryTool` + `createUrlPartsTool` +
  `createRegexExtractTool` plus the `createMuseTools` factory
  composition; same 17-tool public surface, byte-identical
  output ordering. Behavior-preserving — smoke:live's
  `time_now`-using plan-execute test still passes through real
  Gemini and the math tool's evaluator round-trips unchanged.

### Removed

- **All Reactor-migration artifacts**. Muse is now a fresh
  personal-JARVIS project, no longer framed as a port of an
  existing system. Deleted `docs/migration-plan.md` (1623-line
  iteration log), `docs/audits/reactor-*` audits,
  `docs/superpowers/plans/2026-05-06-reactor-migration-*` plans,
  `.claude/rules/migration-loop.md`, `.claude/rules/redaction.md`
  (Reactor-redaction rules), `.claude/commands/migrate-iteration.md`,
  `.claude/commands/audit-parity.md`, `.claude/agents/parity-auditor.md`,
  `scripts/verify-reactor-{db,route}-parity.mjs`, the
  `verify:reactor-{db,routes}` package.json scripts, and
  `packages/db/test/reactor-db-parity-script.test.ts`. CLAUDE.md
  drops the "Don't migrate Reactor's Spring module boundaries"
  rule + all migration-plan / migration-loop / redaction pointers;
  AGENTS.md, README.md, README.ko.md, CONTRIBUTING.md, and the
  remaining `.claude/rules/*.md` files lose their Reactor-leaning
  language. The CLI's `muse spec --json` description is now
  "Print the fixed runtime stack" (was "...migration stack"). New
  rule `.claude/rules/iteration-loop.md` reframes the
  per-iteration discipline as continuous personal-JARVIS
  development.

### Added

- **Open-source baseline files**: `LICENSE` (MIT), `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), `CONTRIBUTING.md`, `SECURITY.md`. Root
  `package.json` carries `license` / `homepage` / `repository` / `bugs`
  fields.
- **Korean auto-extract prompt** for the user-memory hook.
  `pickAutoExtractSystemPrompt(userPrompt)` switches to a Korean system
  prompt when the user message is ≥30% Hangul; English remains the
  conservative default. JSON keys stay snake_case ASCII; values stay in
  the user's native language.
- **CE step 1.e — LLM-summarized fan-in**.
  `OrchestrationRunOptions.summarizeWorkerOutput?: (workerId, output) =>
  Promise<string>` replaces each worker's verbose output with an LLM-
  generated summary before the parent concat. Composes with
  `maxOutputCharsPerWorker`. `/api/multi-agent/orchestrate` accepts a
  `summarize: boolean` body flag; the route builds a Gemini-style
  summarizer from the configured `ModelProvider` (256-token cap, 15s
  timeout, fail-open to raw output).
- **`muse mcp config-doctor` CLI** — per-entry validation that doesn't
  bail on the first malformed entry. Prints
  `<name>\t<STATUS>\t<transport>\t<findings>` per row, exits 1 when any
  entry has `error` status. Soft findings include URL validity for
  streamable/sse transports.
- **`muse mcp config-path` / `config-show`** — file-based ergonomics
  surface for `~/.muse/mcp.json`, no API server required.
- **Voice mode design doc** in `docs/design/voice-mode.md`.
  Phases A/B/D/E shipped (provider interfaces, OpenAI Whisper STT +
  TTS adapters, `/api/voice/*` routes, `<VoicePanel>` Web component).
  Phase C contract written for the next iter to pick up.
- **`~/.muse/mcp.json` Claude-Desktop-style external MCP config loader**.
  Supports stdio (`command`/`args`) and streamable/sse (`url`/`headers`).
  Disabled entries (`disabled: true`) silently skipped; missing file is
  not an error. The boot script seeds entries into the runtime store
  before listening.
- **MCP `roots` capability**. Muse's MCP client now advertises the
  capability and serves a `roots/list` handler. Configurable via
  `MUSE_MCP_CLIENT_ROOTS` (csv of absolute paths).
- **`GET /api/health` alias** under the `/api/*` prefix.
- **Notion tasks adapter**. `NotionTasksProvider` mirrors the round 128
  Notion notes adapter against `api.notion.com/v1` for the tasks domain.
  Opt-in via `MUSE_NOTION_TASKS_*` env vars.
- **Context Engineering primitives** (rounds 157-170):
  working-budget compaction trigger, persona snapshot injection,
  tool-output context-aware trimming, typed user-memory slots
  (preferences / schedule / vetoes / goals), `ContextReferenceStore`
  with `muse.context.fetch` / `muse.context.list` MCP server,
  deterministic per-worker output cap on the multi-agent fan-in.

### Changed

- **Default model auto-detection**. `/api/chat` no longer requires
  `MUSE_MODEL` to be set explicitly — the provider is inferred from
  the available API key (`GEMINI_API_KEY` / `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`). Boot-time warning on
  missing-credentials.
- **ESLint flat config + `typescript-eslint/recommended`** wired
  across the monorepo. All 11 rules at `error`; `pnpm lint` blocks
  on any violation.
- **`packages/tools/src/muse-tools.ts` decomposition**. 1193 → 606 LOC.
  Time/datetime tools moved to `muse-tools-time.ts` (357 LOC),
  text-formatting tools moved to `muse-tools-text.ts` (253 LOC),
  shared parsers in `muse-tools-helpers.ts` (27 LOC). Public
  `createMuseTools()` surface byte-identical.

### Fixed

- `/api/health` 404 when accessed under the `/api/*` prefix.
- Multi-agent fan-in could blow the parent context on N parallel
  verbose workers — now bounded by `maxOutputCharsPerWorker`.
- Stale lint warnings (80 → 0) across the monorepo, mostly dead
  barrel-re-export imports.
