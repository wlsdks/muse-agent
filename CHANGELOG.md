# Changelog

All notable changes to Muse are recorded here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is in
continuous iteration on `main`; once a tagged release exists, sections will
move from `Unreleased` to dated/versioned headings.

## [Unreleased]

### Added

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
