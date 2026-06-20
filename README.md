# Muse — a private, local-first personal AI assistant

<p align="center">
  <img src="docs/assets/muse-goddess.png" alt="Muse — the goddess mascot" width="300" />
</p>

**A self-hosted, offline JARVIS / second brain that answers from *your own* notes
and files** — with the exact source quoted, saying "I'm not sure" instead of
hallucinating, and running **entirely on a local open-source model** (via
[Ollama](https://ollama.com)). Your data never leaves your machine: cloud egress
is refused in code, not just a setting. Provider-neutral (OpenAI · Anthropic ·
Gemini · OpenRouter · Ollama · LM Studio), but **local-first is the default it
ships and defends.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node ≥ 22.12](https://img.shields.io/badge/node-%E2%89%A5%2022.12-43853d.svg)](package.json)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)
[![Cloud egress: off by default](https://img.shields.io/badge/cloud%20egress-off%20by%20default-6f42c1.svg)](#what-muse-is)
[![Runs on Ollama](https://img.shields.io/badge/runs%20on-Ollama-000000.svg)](https://ollama.com)

> *Keywords: local AI assistant · private / offline / self-hosted LLM · personal
> RAG over your notes · cited, hallucination-resistant answers · JARVIS · second
> brain · Ollama · open source.*

---

> **Tell it everything — it can't tell anyone, and it gets stronger by fixing its own blind spots.**
>
> *네 약점까지 다 말해 — 아무한테도 안 새고, 그걸 같이 고쳐 더 똑똑해지니까.*

Muse is a personal AI companion that runs **entirely on your own machine** and
answers from **your own** notes and files — quoting the exact source, saying
"I'm not sure" instead of guessing, and getting genuinely better over time by
finding and fixing its own weak spots. Nothing ever leaves your machine; that's
not a setting, it's enforced in the code.

## What Muse is — five principles

Read these five and you know exactly what kind of agent this is.

1. **Local by construction — _so you can tell it everything._**
   Runs entirely on a local open-source model (gemma4:12b via Ollama by
   default — multimodal + grounding-strong — or any weights you run locally); cloud egress is **refused in code**
   (`MUSE_LOCAL_ONLY` on by default). Not your agent on someone else's cloud —
   actually yours.

2. **Shows its work — _never makes things up._**
   Every answer, nudge, and insight cites the real source it came from; weak
   grounding becomes "I'm not sure"; an un-groundable claim is **dropped by
   code**. Fabrication rate = 0 is a release gate, enforced on every surface
   (recall, proactivity, reflection, chat).

3. **Whetstone — _overcomes its own weaknesses to get stronger._**
   Muse notices what it reliably gets wrong (a refusal it shouldn't make, an
   action it claimed but didn't do), records it, and systematically grinds it
   down — the way a disciplined learner improves a fixed brain, with no weight
   changes. A modest model kept sharp out-cuts a finer one left dull.
   (`muse doctor --weaknesses`)

4. **Distills nature's mechanisms — _the cross-field moat._**
   Muse mines OPEN papers from **biology, ecology, neuroscience** and beyond,
   turning a real mechanism into a deterministic, live-verified capability:
   optimal foraging → adaptive recall depth, ant stigmergy → an evaporating
   note-relatedness graph, allostasis → anticipating a recurring need,
   biodiversity indices → spotting a one-sided corpus. A rival can copy a
   feature; copying a *research-distillation discipline yoked to a
   fabrication-zero floor* is far harder.

5. **Yours to act through — _draft-first, never autonomous._**
   Acts through your real tools (calendar, notes, tasks, reminders, the web) —
   but any send or action toward another person is draft-first and needs your
   explicit confirmation; banking and money movement are permanently out of
   scope.

Principle 1 is *why* you can tell it everything; principles 2–3 are *what it
then does for you*; principle 4 is *how* it keeps getting capabilities a copycat
can't.

### Borrowed from nature (principle 4, in the flesh)

Concrete examples of mechanism 4 — a real result from biology / life-sciences
turned into a live-verified Muse capability (the full 20-mechanism catalog
across all fields is [further down](#cross-field-mechanism-distillation-the-moat)):

| Field | Mechanism (paper) | Muse capability |
| --- | --- | --- |
| Ecology | Optimal foraging / Marginal Value Theorem (Charnov 1976) | `muse recall --adaptive` — the evidence decides how many sources to return |
| Ecology / biodiversity | Shannon & Simpson diversity indices (Shannon 1948; Simpson 1949) | `muse diversity` — is a column concentrated in one bucket, or genuinely varied? |
| Ant colonies | Stigmergy / pheromone trails (Grassé 1959; Vittori 2006) | `muse notes trails` / `hubs` — an evaporating co-recall relatedness graph |
| Physiology / neuroscience | Allostasis — predictive regulation (Sterling 2012) | `muse pattern upcoming` — anticipate a recurring need before its slot |
| Ecology / network science | Keystone species + brokerage (Paine 1966; Freeman 1977) | `muse notes bridges` — the notes connecting your otherwise-separate topics |
| Network science | k-shell influential spreaders (Kitsak et al. 2010) | `muse notes hubs` — the load-bearing core of your notes (depth, not degree) |

Deep dives: [differentiation](docs/strategy/differentiation.md) ·
[verified feature catalog](docs/feature-catalog/INDEX.md) ·
[frontier research](docs/strategy/frontier-research-2026-06.md).

**Quickstart:** `muse onboard` walks you — one command at a time — from a
fresh install to your first private, cited answer (point it at a notes
folder, or `muse ingest` a ChatGPT/Claude export or an `.mbox`, then
`muse ask --notes-only "…"`).

## The edge: Muse shows its work — for everything

Running locally is the *floor*, not the pitch. The functional reason to use
Muse is this: **every answer, every proactive nudge, and every insight it
forms about you cites the real source it came from — and a deterministic gate
makes "confidently wrong" impossible by code.** Weak grounding becomes
"I'm not sure," never a guess. A citation that can't point to something you
actually have is dropped, not bluffed.

Hermes self-improves but can confabulate; OpenClaw "dreams" but its dreams
aren't grounded. Muse is the only one that is **proactive *and* self-learning
*and* incapable of making things up** — and it measures that continuously
(fabrication rate = 0 is a release gate). The same grounding gate governs
recall, proactivity, reflection, **and now plain `muse chat`** — the front door
retrieves your relevant notes per turn and answers from them with the source
cited (ask "what's my office VPN MTU?" and it quotes your note's 1380, not the
textbook 1500), instead of confabulating; nothing relevant in your notes ⇒ it
stays on the refusal floor. Every surface Muse gains plugs into the gate.
Full rationale: [`docs/strategy/differentiation.md`](docs/strategy/differentiation.md).

### How it improves on a *fixed* local model: Playbook + Whetstone

Two complementary memories — never a weight change — let Muse get better the way
a person does: the **Playbook** reinforces the strategies that *work* for you
(reward/decay of learned plays), and **Whetstone** (principle 3) records what it
gets *wrong* and systematically grinds it down. Grounded in real learning-science
and 2024-2026 agent research; Whetstone strengthens the grounding edge (it
remediates the gate's own misses, with a calibration brake against
over-confidence) and never bypasses it. Design + citations:
[`docs/strategy/differentiation.md`](docs/strategy/differentiation.md).

A native **macOS desktop companion** (a floating, voice-capable orb;
on-device speech via WhisperKit + Qwen3-TTS) is the newest surface — same
local-only, grounded runtime.

[한국어 README →](README.ko.md)

<!--LIVE_URL-->📊 **Live progress:** _not exposed yet — start it with `pnpm dashboard:tunnel` (needs the `cloudflared` binary; no account). The loop writes the current public URL on this line and refreshes it when it rotates. Locally any time: `node scripts/dashboard-server.mjs` → <http://127.0.0.1:8787> (read-only, 127.0.0.1-only)._<!--/LIVE_URL-->

## What Muse is

Muse is the AI assistant that's **actually yours**. Point it at the
notes, files, and mail you'd never paste into ChatGPT — it answers from
**your own** corpus with the exact passage quoted, and the part that earns
your trust is what it does when it *isn't* sure: a deterministic confidence
gate (not the model's guess) flags weak matches as "verify before relying"
and says "no matching passages" rather than confabulate. It learns only you,
grows more *you* over time, and acts through your real tools — calendar,
notes, tasks, messaging, the web — always draft-first, never an autonomous
send.

And it runs **entirely on your own machine**. By default Muse uses a local
open-source model (gemma4:12b via Ollama by default, or any HuggingFace
weights you run locally) and **refuses cloud egress in code** — `MUSE_LOCAL_ONLY` is on by
default, so the runtime won't even start against a cloud provider unless you
explicitly opt out (and forfeit the guarantee). Not your agent on someone
else's cloud. Actually yours. The same runtime drives the CLI, the API, and
the web UI — the model-neutral core can still reach any provider when you
opt out, but local is the default it ships and defends. Under the hood:

- **Model-neutral core.** OpenAI, Anthropic, Google Gemini, OpenRouter,
  Ollama, LM Studio, and any OpenAI-compatible endpoint live behind a
  single `ModelProvider` adapter. The runtime calls the abstraction,
  never a vendor SDK directly.
- **Tool & MCP first.** Tools are first-class — read, write, or
  execute — with explicit risk levels, approval gates, and
  deterministic loop limits. ~24 in-process `muse.*` servers ship
  built-in: eight pure-utility ones (`muse.time`, `muse.text`,
  `muse.math`, `muse.json`, `muse.url`, `muse.crypto`, `muse.diff`,
  `muse.regex`) plus the personal-domain set (`muse.notes`,
  `muse.tasks`, `muse.calendar`, `muse.reminders`, `muse.episode`,
  `muse.history`, `muse.status`, `muse.search`, `muse.fetch`,
  `muse.fs`, `muse.pattern`, `muse.proactive`, `muse.followup`,
  `muse.messaging`, `muse.context`, `muse.web`); external servers
  connect over stdio / SSE / streamable-HTTP.
- **Personal-domain primitives.** Markdown notes, calendar events
  across 5 providers (Local file, Local-ICS `.ics`, Google Calendar,
  CalDAV, macOS Calendar.app), and a todo list — all stored locally by default,
  queryable by the agent, and editable from CLI / Web UI.
- **Multi-agent orchestration.** Sequential or parallel worker
  fan-out, an in-memory cross-agent message bus, per-run history
  with full conversation snapshots, and aggregate stats — all
  exposed over HTTP and SSE.
- **Deterministic safety.** Guards are fail-close, hooks are
  fail-open, and security lives in code (not in prompt instructions).
  Tool output is untrusted until sanitised. Risky local execution
  flows through a separate Rust runner (`crates/runner`).

## What Muse will not do (boundaries)

These are deliberate product boundaries, enforced in code — not TODOs:

- **No money movement.** Muse never connects to bank / brokerage
  accounts, initiates payments, or moves money. The blast radius is
  irreversible for a single-user assistant; this is a permanent
  boundary, not a deferral (see
  [`outbound-safety.md`](.claude/rules/outbound-safety.md)).
- **No autonomous third-party sends.** Anything that transmits to
  another person (email, chat, message, web form / booking) is
  **draft-first and you confirm the exact content** before it leaves.
  The approval gate is fail-closed: deny / timeout / ambiguous
  recipient ⇒ nothing is sent. Messaging sends (`muse.messaging.send`)
  are gated by the runtime approval gate in the shipping CLI / API
  paths and now also self-record every send to the action log.
- **Single user, single environment.** No multi-tenant accounts, no
  shared workspace, no RBAC. Identity is your local `$USER`.
- **Vision input — one path excepted.** Image attachments are
  serialized on local **Ollama** (gemma4, the `muse ask --image` path),
  **Anthropic**, the OpenAI **Chat-Completions** path, OpenAI-compatible /
  OpenRouter, and **Gemini**. The one exception is the OpenAI **Responses**
  API path, which is still text-only (it emits `input_text` only). Under
  local-only (the default) image bytes never leave the machine regardless.

## Architecture at a glance

```
apps/
  api/        Fastify API server (chat, agent specs, multi-agent, MCP,
              scheduler, calendar, tasks)
  cli/        terminal agent (commander + Ink TUI + setup wizards)
  web/        React UI — 13 panels (Chat, Today, Dashboard, Tasks,
              Reminders, Calendar, Notes, Memory, Messaging, Tools,
              Activity, Autonomy, Settings)
  desktop/    native macOS floating companion (SwiftPM)

packages/
  agent-core/         ReAct + Plan-Execute loops, guard pipeline,
                      hook registry, context transforms, model loop
  model/              ModelProvider interface + provider wire-format
                      adapters (OpenAI / Anthropic / Gemini / OpenRouter /
                      Ollama + OpenAI-compat presets for Groq / DeepSeek /
                      Together / Mistral / Moonshot / Cerebras)
  tools/              tool registry, executor, sanitiser, approval path
  multi-agent/        SupervisorAgent, MultiAgentOrchestrator,
                      message bus, history
  mcp/                MCP transports + loopback servers (incl.
                      notes / tasks / calendar) + NotesProvider abstraction
  calendar/           CalendarProvider abstraction +
                      Local / Local-ICS / Google / CalDAV / macOS adapters +
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
  recall/             grounded-recall presentation / orchestration
  skills/             self-authored skills (author / curate / merge)
  agent-specs/        named sub-agent role / tool / prompt specs
  a2a/                Muse-to-Muse swarm + council federation
  messaging/          Telegram / Discord / Slack / LINE adapters
  voice/              STT / TTS registry (local + cloud)
  browser/            real-Chrome control (opt-in, gated)
  autoconfigure/      zero-config provider / model / index resolution
  auth/ cache/ resilience/ runtime-settings/ macos/ prompts/ shared/
                      (auth store · caching · retries · settings · macOS
                      glance · prompt assembly · shared utils)

crates/
  runner/             Rust sandbox: shell / process / file execution
```

## Quick start

```bash
# Requirements: Node.js >= 22.12 (24 LTS recommended) + pnpm 10
pnpm install
pnpm build
pnpm test

# 30-second JARVIS demo (runs on your local default model, gemma4:12b via Ollama):
pnpm demo
```

The demo exercises chat with cross-turn memory, a credential-free
proactive notice, the setup diagnostic, and the Codex / Claude
Desktop MCP bridge in one narrated run.

The full command surface (`muse --help`):

![muse --help command catalog](docs/images/cli-help.png)

### Daily-driver flows

```bash
# JARVIS REPL — continuous conversation, token streaming, persona-aware.
# The interactive REPL is `chat --local`; type /help to list slash commands:
muse chat --local --user me

# Stdin piping for ad-hoc summarisation:
cat note.md | muse chat --local --no-tools "한 단락으로 요약"   # gemma4:12b by default

# Real-time proactive daemon (Ctrl-C to stop). Notices are
# personalised — they address you by name in your preferred language:
muse proactive watch --user me --interval 60

# At-a-glance dashboard — model, persona, imminent tasks, last notice:
muse status --user me
```

`muse status` and `muse today` render entirely from your local stores —
no API key required (they fall back to a local briefing when the API
server isn't running):

| `muse today` | `muse status` |
| --- | --- |
| ![muse today briefing](docs/images/cli-today.png) | ![muse status dashboard](docs/images/cli-status.png) |

### What "JARVIS" means in Muse

Muse keeps a persistent personal model at `~/.muse/user-memory.json`
keyed by `--user <id>`. Every REPL turn the model sees:

- Your **facts** (`name`, `city`, `role`, …) — auto-extracted from
  chat, taught in the REPL with `/remember …`, or set directly with
  `muse memory set fact <key> <value>` (no-LLM path)
- Your **preferences** (`language`, `reply_style`, …) — same auto-
  extract path, REPL slash command `/pref key=value`
- Your **vetoes** (`no_coffee`, `no_email_after_9pm`, …) — things
  Muse must never suggest. Recognised when you state a hard rule.
- Your **goals** — active objectives Muse can steer toward
- The current local **date / time / day-of-week**

The same persona ships into `muse proactive watch`, so the
notification "Send Q3 memo due in 5 min" gets translated through
your prefs and lands as **"Q3 예산 메모를 금융팀에 보내야 합니다. 지금
작성 시작할까요?"** — same daemon, same model, no extra work.

That is the differentiator: Muse doesn't just wrap a model for a
single call — it remembers you, learns from natural conversation,
and uses what it learns to shape every future turn AND every
proactive notice.

### Cloud + API server (BYOK)

```bash
GEMINI_API_KEY=… MUSE_MODEL=gemini/gemini-2.0-flash MUSE_MODEL_PROVIDER_ID=gemini \
  pnpm --filter @muse/api dev

curl -X POST http://127.0.0.1:3030/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What time is it? Use a tool."}'

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
muse setup calendar   # multi-select Local / Local-ICS / Google / CalDAV / macOS
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
| `NotesProvider` Apple | `scaffold` | osascript (Notes.app) adapter implemented; needs macOS to exercise live (first call triggers a permission prompt) |
| `NotesProvider` Notion | `live` (unit) | api.notion.com/v1 adapter implemented — list/read/search/save/append + 429 retry / 401 fail-fast / write-not-retried; needs a user token to exercise against the real API |

## Verification

Tests are the only form of verification. The repo ships these gates:

```bash
pnpm check                                      # build + test for every workspace (thousands of tests across all 27 packages)
pnpm smoke:broad                                # 51 HTTP endpoints, diagnostic provider
pnpm smoke:live                                 # real LLM round-trip — LOCAL OLLAMA ONLY, gemma4:12b default (auto-skips if Ollama is unreachable)
```

`smoke:live` (`scripts/smoke-live-llm.mjs`) is **local Ollama only by
deliberate policy** — it probes `${OLLAMA_BASE_URL:-http://localhost:11434}`,
prefers the installed gemma4 (or `MUSE_SMOKE_LIVE_MODEL`), and asserts the
model→tool→model loop end-to-end across direct chat, streaming SSE,
plan-execute, input guards, multi-agent orchestration,
`muse.notes.search`, `muse.tasks.add`, and `muse.calendar.add`. Cloud
provider keys are intentionally never consulted; it skips only when local
Ollama is unreachable. (A separate, unwired
`scripts/smoke-live-all-providers.mjs` exists for ad-hoc cloud-key probing
and is **not** what `pnpm smoke:live` runs.)

## Provider configuration

Pick a model at runtime via env:

| Env | Example | Notes |
| --- | --- | --- |
| `MUSE_MODEL` | `gemini/gemini-2.0-flash` | `<providerId>/<modelId>` form |
| `MUSE_MODEL_PROVIDER_ID` | `gemini` | optional override; inferred from prefix |
| `MUSE_MODEL_API_KEY` | `…` | per-provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) also work |
| `MUSE_MODEL_BASE_URL` | `http://localhost:11434/v1` | overrides for OpenAI-compatible endpoints (Ollama, LM Studio, custom) |

Free / offline path — Ollama with an open-source model:

```bash
brew install ollama && ollama serve &
ollama pull gemma4:12b                 # the shipped default — multimodal + grounding-strong
muse setup local                       # wires defaultModel into ~/.config/muse/config.json
```

See [`docs/setup-local-llm.md`](docs/setup-local-llm.md) for the
four tiers (0.8B / 2B / 9B / 27B), license notes, and the dogfood script
that measures first-token latency on your hardware.

Personal-domain toggles:

| Env | Default | Effect |
| --- | --- | --- |
| `MUSE_NOTES_DIR` | `~/.muse/notes` | Markdown notes directory (point at Obsidian vault to query it) |
| `MUSE_NOTES_ENABLED` | `true` | Disable `muse.notes.*` tools |
| `MUSE_TASKS_FILE` | `~/.muse/tasks.json` | Todo list file |
| `MUSE_TASKS_ENABLED` | `true` | Disable `muse.tasks.*` tools |
| `MUSE_CALENDAR_FILE` | `~/.muse/calendar.json` | Local calendar provider file |
| `MUSE_CALENDAR_PROVIDERS` | `local` | Comma list: `local,ics,gcal,caldav,macos` (`ics` auto-added when `~/.muse/calendar.ics` exists) |
| `MUSE_CREDENTIALS_FILE` | `~/.muse/credentials.json` | chmod-600 OAuth / app-password store |
| `MUSE_USER_MEMORY_AUTO_EXTRACT` | `true` | LLM auto-extracts facts/preferences after each turn — set `false` to skip the extra per-turn call |

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

## Research & attributions

Muse is an independent MIT project. The designs below were **studied and
reimplemented from scratch** (no third-party source copied) — we record where
the ideas came from, per feature. Full notices + license texts:
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

| Feature | Borrowed idea | Source |
| --- | --- | --- |
| **Held-out validation gate** over self-edits — a merged skill (curator), a merged playbook strategy, or an inferred preference commits only if it is semantically supported by its evidence, else it is dropped (`packages/agent-core/src/skill-merge-gate.ts`, `validateMergeCoverage`). Script-aware so it never false-rejects bilingual (KO/EN) learning. | propose-and-test self-improvement (accept only a verified edit) | **SkillOpt**, Microsoft (MIT) — [arXiv 2605.23904](https://arxiv.org/abs/2605.23904) |
| Session-end skill authoring, curator umbrella-consolidation, behavior-inferred user model, background-review engine | fork-and-review self-improvement; curator lifecycle | **Hermes Agent**, Nous Research (MIT) |
| Recurring-theme surfacing, episode consolidation, skill-body risk scan, commitment extraction | sleep/"dreaming" memory consolidation; scan-before-activate | **OpenClaw** (MIT) |
| Grounded reflection synthesis (insights cite their source episodes) | offline reflection over observations | Generative Agents — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442) |
| Confidence-gated cited recall ("I'm not sure" floor) | lightweight retrieval evaluator | CRAG — [arXiv 2401.15884](https://arxiv.org/abs/2401.15884) |
| Long-context passage reordering (strong sources at head/tail) | "Lost in the Middle" | [arXiv 2307.03172](https://arxiv.org/abs/2307.03172) |
| Preference inference from real corrections (not self-judgement) | distil from outcome signals | ReasoningBank — [arXiv 2509.25140](https://arxiv.org/abs/2509.25140) |
| Deterministic detection (rules) before any model generalisation | small models are unreliable self-verifiers | [arXiv 2404.17140](https://arxiv.org/abs/2404.17140) |

### Cross-field mechanism distillation (the moat)

Beyond the AI-agent literature, Muse continuously mines OPEN papers from **many
fields** — biology, ecology, neuroscience, network science, control theory,
decision & information theory, linguistics, psychology, forensic & environmental
statistics — distilling a real mechanism into a deterministic, live-verified
capability. A rival can copy a feature; copying a *research-distillation
discipline yoked to a fabrication-zero floor* is far harder. The complete
catalog (see also [`docs/strategy/differentiation.md`](docs/strategy/differentiation.md)):

| Field | Mechanism (paper) | Muse capability |
| --- | --- | --- |
| Ecology | Optimal foraging / Marginal Value Theorem (Charnov 1976) | `muse recall --adaptive` — the evidence picks how many sources to return |
| Ecology / biodiversity | Shannon & Simpson diversity + Pielou evenness (Shannon 1948; Simpson 1949) | `muse diversity` — is a category column diverse or concentrated? |
| Collective behaviour / biology | Stigmergy, ant pheromone trails (Grassé 1959; Vittori 2006) | `muse notes trails` / `hubs` — an evaporating co-recall relatedness graph |
| Physiology / neuroscience | Allostasis — predictive regulation (Sterling 2012) | `muse pattern upcoming` — anticipate a recurring need before its slot |
| Network science | k-shell decomposition / influential spreaders (Kitsak et al. 2010) | `muse notes hubs` — the load-bearing core of your notes (depth, not degree) |
| Network science / ecology | Betweenness / brokerage (Freeman 1977; Burt 1992) + keystone species (Paine 1966) | `muse notes bridges` — the notes connecting your separate topic clusters |
| Control theory / SPC | CUSUM change-point (Page 1954) | `muse pattern lapsed` — a recurring habit that has STOPPED |
| Decision / information theory | Expected information gain / EVPI (Lindley 1956; Howard 1966) | `muse ask` clarify arm — ask when divergent sources tie, vs guess or abstain |
| Computer science (web-scale) | Broder resemblance / shingling (Broder 1997) | `muse feeds` near-duplicate collapse (same story across outlets) |
| Information science | Luhn extractive summarization (Luhn 1958) | `muse summarize` — a document's own key sentences (cannot fabricate) |
| NLP | RAKE keyphrase extraction (Rose et al. 2010) | `muse keywords` — a document's key phrases (topics) |
| Computational linguistics | Pointwise mutual information (Church & Hanks 1990) | `muse contacts related` — inferred relationship edges from co-mention |
| Queueing / operations research | Little's Law L=λW (Little 1961) | `muse tasks flow` — are you finishing tasks as fast as you add them? |
| Real-time systems / scheduling | Earliest Deadline First (Liu & Layland 1973) + aging | `muse tasks next` — what to do NOW, with a why-now; old tasks aged up |
| Forensic statistics | Benford's Law + Pearson χ² (Benford 1938; Pearson 1900) | `muse benford` — unnatural patterns in a numeric column |
| Environmental statistics | Mann-Kendall trend + Sen's slope (Mann 1945; Kendall 1975) | `muse trend` — is a tracking column rising, falling, or wandering? |
| Cognitive psychology | Autobiographical / date-cued recall (Rubin et al. 1986) | `muse on-this-day` — notes from today's date in earlier years |
| Organizational psychology | Attention residue / deep work (Leroy 2009) | `muse calendar focus` — your longest uninterrupted block |
| Psychology | Implementation intentions / time-blocking (Gollwitzer 1999) | `muse calendar block` — book the next free slot to protect focus |
| Cognition / strategy | First-principles (Musk) + contrarian question (Thiel) | reasoning principles in `muse ask` — the engine; the grounding floor is the brake |

Each mechanism cites its paper in the module header comment; the verified
feature inventory lives in [`docs/feature-catalog/INDEX.md`](docs/feature-catalog/INDEX.md).

## License

[MIT](LICENSE). The runtime, adapters, and tooling are open
source. Contributions are accepted under the same terms — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the flow.
