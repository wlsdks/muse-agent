# Changelog

All notable changes to Muse are recorded here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is in
continuous iteration on `main`; once a tagged release exists, sections will
move from `Unreleased` to dated/versioned headings. Version policy:
[`docs/VERSIONING.md`](docs/VERSIONING.md).

## [Unreleased]

## [0.1.0] - 2026-06-21

First tagged release — **early / experimental, macOS only**. While the major
version is `0`, every release is a pre-release and the public surface may still
change (see [`docs/VERSIONING.md`](docs/VERSIONING.md)).

### Added

- **The personal AI that learns _you_, not the world.** A local-first agent
  that builds a private model of who you are from your own notes and files,
  reinforces what works for you, and forgets the moment you correct it — the
  model of you never leaves your machine (cloud egress is refused in code under
  `MUSE_LOCAL_ONLY`, on by default).
- **"Shows its work" grounding gate** under every surface (recall, proactivity,
  reflection, chat, vision): every claim cites a real source, weak grounding
  becomes "I'm not sure," and an un-groundable claim is dropped by code.
  `fabrication = 0` is a CI-enforced release gate.
- **Runs entirely on a local open-source model** (`gemma4:12b` via Ollama by
  default) behind a model-neutral `ModelProvider` core; the same runtime drives
  the CLI, the API server, and the web UI.
- **Personal-domain surfaces** — notes, tasks, reminders, calendar (5
  providers), a proactive daemon, multi-agent orchestration, messaging
  channels, and a native macOS desktop companion — all draft-first for any
  third-party action, with banking permanently out of scope.

### Fixed

- Fresh `pnpm install` now wires dependency build scripts automatically — no
  manual `pnpm approve-builds` step on a first clone.

### Prior `[Unreleased]` development log

The detailed entries below accumulated during pre-tag iteration on `main` and
are retained here for history.

### Added

- **Grounding gate — architectural-delta benchmark (`pnpm eval:grounding-delta`).**
  The honest "best" claim for a fixed ~12B local model is not an absolute
  faithfulness score (a bigger model beats that) — it is the DELTA a deterministic
  gate buys on the SAME model. This runs the corpus through the real recall stack
  twice — gate ON vs gate OFF (a no-op verdict injected into `runGroundingEval`,
  in the eval harness only, never a production bypass) — and writes
  `docs/benchmarks/RESULTS.md` with the Δ table. First measured number on
  `gemma4:12b`: gate OFF lets 17/17 fabrications through (faithfulness 0.00); gate
  ON catches 16/17 (**0.94**) at **0.00** false-refusal — a **+0.94** lift that is
  purely the gate's architectural contribution, not the model's. (Same-model judge
  ⇒ an internal-validity delta; a public-dataset arm — SQuAD-2.0-style
  answerable/unanswerable — is the next slice to make it externally citable.)

- **`fabrication=0` is now enforced by code, not discipline.** CLAUDE.md calls
  fabrication=0 a release gate and "grounded-surface count never drops", but the
  only git hook was the immutable-core commit-msg guard — a grounding regression
  could land on a green `pnpm check`. Two layers close that:
  - **Deterministic grounded-surface ratchet** (`self-eval`): `countGroundedSurfaces`
    counts the live batteries registered in the `eval:self-improving` release gate
    and exposes them as a numeric scoreboard gate, so `detectRegressions` fails the
    moment a surface is dropped from the gate (no Ollama; runs at the top of every
    loop fire). Proven: dropping one surface yields `groundedSurfaces: 27→26` +
    exit 1.
  - **Live pre-push tripwire** (`pnpm precheck:grounding`): re-spawns the
    fabrication-critical batteries (faithfulness-rate, recall-citation-gate,
    rubric-reverify) `MUSE_EVAL_REPEAT` times each and requires every run to pass
    (pass^k). Installed as a `pre-push` hook by `scripts/install-git-hooks.sh`.
    Fail-open ONLY on a broken environment (Ollama unreachable, or a battery
    exceeds its per-battery timeout → that battery skips); a battery that RUNS and
    FAILS blocks the push. Emergency escape: `MUSE_SKIP_PREPUSH=1`. Proven live:
    3/3 batteries green at pass^2 on `gemma4:12b`.

- **Default local model → `gemma4:12b`** (was `qwen3:8b`). Chosen for native
  multimodal vision plus stronger grounding; verified across every agent-eval
  gate (tools, faithfulness, adversarial safety, judge meta-eval, plan-quality,
  self-improving). Answer temperature is now pinned explicitly (grounding-first
  0.6, `MUSE_ANSWER_TEMPERATURE`) instead of inheriting the model's high default.
- **Grounded vision actions** — turn the camera into a grounded, draft-first
  agent. `muse ask --image` sees a photo; `--extract "f,…"` pulls structured
  JSON; `--auto` classifies the image (event / receipt / contact / document) and
  drafts the matching action (calendar event / expense note / contact / titled
  note), writing only on `--apply`. The agent does the same flag-free given an
  image + a natural request. `muse chat --local --image` and the Ink chat's
  `@photo.png` bring vision to the chat surface. The grounding floor holds on the
  image surface (an unreadable field is omitted, an absent fact is refused — never
  invented), gated by `eval:vision`, `eval:vision-agent`, `eval:vision-grounding`
  (the last registered into the `eval:self-improving` release battery).

- **Proactive surfacing (Phases A + B + C + D)**. New daemon scans the
  calendar registry AND the personal-tasks store every minute
  (`MUSE_PROACTIVE_TICK_MS`, default 60s) and pushes a one-line
  notice via the messaging registry for items in the
  `MUSE_PROACTIVE_LEAD_MINUTES` window (default 10):
  - **Phase A — calendar imminence**: non-all-day events whose
    `startsAt` is in `[now, now + leadMinutes]`. Format
    `⏰ {title} in {N} min (location?)`.
  - **Phase B — task due-soon**: open tasks (status="open") with
    `dueAt` in the same window. Format `📋 {title} due in {N} min`.
  - **Phase C — per-item opt-out**:
    - Calendar: case-insensitive `[no-proactive]` marker in the
      event title or notes suppresses the notice. Provider-neutral
      (works against CalDAV / Google Calendar / LocalCalendar /
      macOS Calendar) since every backend surfaces user-typed text.
    - Tasks: explicit `proactive: false` field on a `PersistedTask`
      suppresses the notice without affecting the rest of the
      lifecycle (still due, still surfaces in `muse today`).
  - **Phase D — agent-initiated turn**: when
    `MUSE_PROACTIVE_AGENT_TURN=true` AND an `AgentRuntime` is wired
    AND the user has touched `/api/chat*` within
    `MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS` (default 300_000 =
    5 min), the daemon spawns a one-shot agent run with a
    JARVIS-style synthesis prompt and uses the LLM reply (with the
    emoji prefix kept) as the notice text. Falls back to the flat
    "⏰ {title} in {N} min" string when the window has lapsed,
    the agent is missing, or synthesis errors. Activity tracker
    defaults to in-process; set
    `MUSE_PROACTIVE_PRESENCE_FILE=~/.muse/presence.json` to switch
    to a file-backed tracker that two processes (apps/api + a
    future `muse listen` daemon) can share, so activity on either
    surface unlocks Phase D for both. Writes are debounced to once
    per second to avoid disk thrash.
  Off by default — activates only when `MUSE_PROACTIVE_PROVIDER` +
  `MUSE_PROACTIVE_DESTINATION` are set, the named provider is
  registered, AND at least one signal is available (a calendar
  registry with ≥1 wired provider OR a `tasksFile` configured).
  Shared dedupe sidecar at `MUSE_PROACTIVE_SIDECAR_FILE`
  (default `~/.muse/proactive-fired.json`) ensures a single item
  fires at most once per `{kind, id, startIso}` tuple; a moved
  meeting / rescheduled task re-fires. Quiet-hours inherit from
  `MUSE_REMINDER_QUIET_HOURS` unless overridden by
  `MUSE_PROACTIVE_QUIET_HOURS`. Phase D (agent-initiated turn) is
  scoped in `docs/design/proactive-surfacing.md`.

- **Local Whisper.cpp STT** via the new `WhisperCppSttProvider`. Set
  `MUSE_VOICE_STT=whisper-cpp` to route `/api/voice/stt` (and the
  CLI `muse listen` path, once it picks up the runtime registry)
  through the local `whisper-cpp` binary instead of OpenAI Whisper.
  Tune the binary / model paths with `MUSE_WHISPER_CPP_PATH`
  (default `whisper-cpp` via `$PATH`) and `MUSE_WHISPER_CPP_MODEL`
  (default `~/.muse/whisper-models/ggml-base.en.bin` — operators
  bring their own model). See `docs/design/voice-mode.md` for the
  full Phase F contract.

- **Reminder firing — agent-synthesized text (Phase D mirror)**.
  When `MUSE_REMINDER_AGENT_TURN=true` AND an `AgentRuntime` is
  wired AND the user touched `/api/chat*` within
  `MUSE_REMINDER_ACTIVE_SESSION_WINDOW_MS` (default 300_000 = 5
  min), the firing loop spawns a one-shot agent run with a
  JARVIS-style synthesis prompt and uses the LLM reply as the
  delivered message instead of the raw `reminder.text`.
  - Falls back to the flat reminder text on missing wires, stale
    window, empty reply, or synthesis error (failure logs to
    `summary.errors` but the reminder still fires so the user
    never misses a beat).
  - The activity tracker is **shared** with the proactive daemon:
    a single `onRequest` hook on `/api/chat*` unlocks both daemons
    in lockstep. `MUSE_PROACTIVE_PRESENCE_FILE` still drives the
    file-backed variant for multi-process setups.
  - History records the *delivered* text (synthesized or flat) so
    `muse.reminders.history` reflects what the user actually saw.

- **`muse proactive test` / `muse proactive scan`** — operator tools
  for verifying the proactive surfacing daemon without waiting for
  a real imminent event.
  - `muse proactive test [--text <message>]` sends a one-line
    notice through `MUSE_PROACTIVE_PROVIDER` / `MUSE_PROACTIVE_DESTINATION`
    so the operator can confirm the messaging channel works
    end-to-end. Exits 1 with a helpful message when either env is
    missing or the configured provider isn't registered.
  - `muse proactive scan [--lead-minutes N]` dry-runs the
    calendar + tasks scan against the same window the daemon
    would use and prints what would fire next tick. Doesn't push,
    doesn't touch the sidecar.

- **Web SetupPanel now surfaces voice STT/TTS backends, user-memory
  auto-extract, and proactive daemon state** — parity with the CLI
  `muse setup` output. The `voice` row reads
  `stt=openai-whisper, tts=openai-tts` (or whichever local
  combo is wired), the new `user memory` row reflects
  `MUSE_USER_MEMORY_AUTO_EXTRACT`, and the new `proactive` row
  shows the provider/destination/lead/tick + Phase D and
  quiet-hours flags when the daemon would activate.

- **Proactive surfacing audit log** — full stack mirror of
  `reminder-history`. The proactive daemon now appends every
  delivery attempt (success or failure) to
  `~/.muse/proactive-history.json` (override via
  `MUSE_PROACTIVE_HISTORY_FILE`) with the resolved item id, title,
  startsAt/dueAt, provider/destination, the *delivered* text
  (flat or Phase D agent-synthesized), the firedAt, status, and
  error context. The history surface is exposed through four
  symmetric channels:
  - **MCP loopback**: new `muse.proactive.history` tool (mirror
    of `muse.reminders.history`) — the agent can answer "did the
    3pm meeting notice land?" without an extra tool call.
  - **REST**: `GET /api/proactive/history?limit=N` returns the
    newest-first audit log. Auth-gated when an auth service is
    wired.
  - **CLI**: `muse proactive history [--limit N] [--json]` — a
    quick terminal-side audit without needing the API server.
  - **Library**: `appendProactiveHistory` / `readProactiveHistory`
    in `@muse/mcp` for callers that want the same shape directly.

- **Setup status now surfaces the reminder firing daemon**. New
  `reminder` section in the snapshot mirrors the `proactive`
  section: `{ enabled, providerId?, destination?, tickMs,
  agentTurn, quietHours?, nextStep? }`. Both the CLI text
  renderer and the web SetupPanel print a `reminder firing` row
  alongside the existing `proactive` row, including the
  `agent-turn=true` flag when `MUSE_REMINDER_AGENT_TURN=true`.

- **`muse setup status` now surfaces the recent env knobs**. The
  setup-status snapshot (used by both `muse setup` CLI text /
  `--json` and `GET /api/setup/status`) gained three sections /
  fields so operators can verify their toggles without grepping
  env:
  - `voice.sttBackend` and `voice.ttsBackend` resolve the
    effective backend (`openai-whisper` / `whisper-cpp` for STT,
    `openai-tts` / `piper` for TTS) given the configured env. The
    CLI line reads `[ok] voice — stt=openai-whisper, tts=openai-tts`
    (or your local-only combo) instead of the previous "OpenAI
    key present" string.
  - New `userMemory` section: `{ status, autoExtract, model? }`.
    Reflects the `MUSE_USER_MEMORY_AUTO_EXTRACT` flag (default
    `true`) and the resolved extraction model.
  - New `proactive` section:
    `{ status, enabled, providerId?, destination?, leadMinutes,
    tickMs, agentTurn, quietHours?, sidecarFile, nextStep? }`.
    The `enabled` boolean reflects whether
    `MUSE_PROACTIVE_PROVIDER` + `MUSE_PROACTIVE_DESTINATION` are
    set (the server-side daemon also needs a calendar or tasks
    signal, which the snapshot doesn't enumerate). Phase D
    `agentTurn` exposes whether `MUSE_PROACTIVE_AGENT_TURN=true`.

- **`LiveVoiceProvider` abstraction** for duplex (audio-in /
  audio+text-out) providers like Gemini Live and OpenAI Realtime
  (Voice Phase F.3). Ships the interface
  (`LiveVoiceSession.sendAudio` / `endTurn` / `events()` /
  `close()`) and a `FakeLiveVoiceProvider` for tests / dry runs.

- **Gemini Live wire-format helpers** —
  `buildGeminiLiveSetupFrame`, `buildGeminiLiveAudioFrame`,
  `buildGeminiLiveEndTurnFrame`, `parseGeminiLiveServerFrame`.
  These compose into a future `GeminiLiveProvider` (which would
  implement `LiveVoiceProvider`) without locking the websocket
  transport details. Parser surfaces text-delta / audio-delta
  / turn-complete events; malformed JSON resolves to an error
  event so a single consumer loop handles both happy and sad
  paths.

- **`AudioFrameWakeWordDetector` interface** + a
  `FakeAudioFrameWakeWordDetector` test seam. Extends the
  Phase F.1 wake-word scaffolding so a future
  `OnnxWakeWordDetector` (openWakeWord / Porcupine) can plug in
  alongside the existing text-scan detector without changing the
  CLI loop's shape. The audio-frame variant consumes 80 ms
  PCM16 frames at 16 kHz and exposes `feedFrame()` +
  `reset()`.

- **Wake-word ambient mode** for `muse listen` (Voice Phase F.1
  first cut). New `--wake "hey muse"` flag turns the CLI into a
  continuous-listen daemon: short rolling clips (default 5s,
  override via `--clip-seconds`) are transcribed through the
  configured STT provider, scanned for the wake phrase, and on a
  hit Muse either uses the residual text after the phrase as the
  prompt (same clip) or captures another clip to get one. Ctrl-C
  stops the loop. Implemented against a new `WakeWordDetector`
  abstraction in `@muse/voice` so a future
  `OnnxWakeWordDetector` (openWakeWord / Porcupine) drops in
  without touching the CLI. This Phase F.1 cut uses the
  text-scan path; the openWakeWord ONNX adapter is future work.

- **Local Piper TTS** via the new `PiperTtsProvider`. Set
  `MUSE_VOICE_TTS=piper` AND `MUSE_PIPER_VOICE=/path/to/voice.onnx`
  to route `/api/voice/tts` through the local `piper` binary
  instead of OpenAI TTS. Override the binary path with
  `MUSE_PIPER_PATH` (default `piper` via `$PATH`). Piper produces
  WAV only (the existing `format: wav` request stays valid; mp3 /
  opus etc. requests are rejected with `UNSUPPORTED_FORMAT` so
  callers transcode downstream if needed). Voice files come from
  https://github.com/rhasspy/piper/blob/master/VOICES.md. Phase
  F.3's Gemini Live duplex stream remains future work.

### Changed

- **`MUSE_USER_MEMORY_AUTO_EXTRACT` default flips from `false` to
  `true`**. JARVIS-class memory ("the assistant that remembers")
  is central to Muse's identity, so the per-turn structured-output
  LLM call that persists newly stated facts / preferences into the
  `UserMemoryStore` is now on by default. The extractor runs
  fail-open with a 10-second wall-clock cap and bounded
  input slices (2 KB / 2 KB user / assistant). Set
  `MUSE_USER_MEMORY_AUTO_EXTRACT=false` to skip the extra call
  (offline runs, cheap-model budgets, disabled-memory test rigs).

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

- **Six new OpenAI-compatible provider presets** — Groq, DeepSeek,
  Together, Mistral, Moonshot, Cerebras. Just export the matching key
  (`GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `CEREBRAS_API_KEY`, …) and
  `muse` auto-selects a sensible default model. The interactive
  `muse setup model` wizard now offers all 11 providers (legacy 5 +
  new 6) and the JSON / CLI setup status surfaces each preset.
- **Bare-prefix model spec inference** — `MUSE_MODEL=mistral-small-latest`
  (no `provider/` prefix) now resolves to the Mistral provider via the
  `knownModelPrefixes()` map instead of falling through to undefined.
  Same fix applies to `moonshot-`, `codestral-`, `pixtral-`, etc.

- **Fixes to the streaming + multi-turn paths shipped alongside
  `web_search`**: Anthropic / Gemini `provider.stream()` now synthesise
  `tool-call-started` / `tool-call-finished` / `citations` `ModelEvent`s
  the same way the OpenAI Responses SSE parser does (was: silently
  dropped on those two providers). OpenAI Responses request `input[]`
  items now always use `content[].type: "input_text"` (was: `output_text`
  for assistant turns, which is the response-side shape).

- **`webSearch` policy line in `muse setup`** — the human-readable setup
  output now reports `enabled / maxUses / source` so operators can
  verify a `MUSE_WEB_SEARCH=off` override is being honored without
  hitting an endpoint.

- **Admin API now mirrored in the CLI** — ten previously web-only
  observability / admin surfaces now have thin CLI wrappers:
  `muse runs list/show`, `muse doctor`, `muse cost {daily,top,for}`,
  `muse latency {summary,timeseries}`, `muse traces {list,spans}`,
  `muse settings {list,get,set,unset,refresh}`,
  `muse tools {stats,accuracy,calls,ranking}`,
  `muse analytics {failures,latency-distribution}`,
  `muse debug {replay,replay-show}`, plus `muse scheduler {delete,executions}`.
  Operators can now triage from the terminal without curl or the web UI.

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

- **CLI displayed task/reminder times in UTC** — `muse tasks list`,
  `muse remind list`, `muse today`, and `muse brief` all rendered
  stored UTC ISO instants by slicing the string ("2026-05-14 06:00")
  with no timezone conversion. A user in KST who typed
  `--due "tomorrow at 3pm"` saw `06:00` back, forcing a mental
  UTC→local conversion on every glance. Times now render in the
  host's local timezone via a shared `formatLocalDateTime` helper
  (Intl.DateTimeFormat with `en-CA` to preserve ISO digit ordering),
  so "tomorrow at 3pm" round-trips as `15:00`. The three previously
  duplicated `shortDateTime` helpers collapse to one export.
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
