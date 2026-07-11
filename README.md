<p align="center">
  <img src="docs/assets/mascot.svg" alt="Muse — the bluebird mascot" width="120" />
</p>

<p align="center"><i>Meet Muse — and the bluebird that lives in it: a small companion that watches quietly and chirps when it has something for you.</i></p>

<h1 align="center">Muse</h1>

<p align="center">
  <b>The personal AI that learns <i>you</i> — not the world. It builds a private model of who you are<br/>from your own notes and files, keeps it on your machine, and forgets the moment you correct it.</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg" /></a>
  <a href="package.json"><img alt="Node ≥ 22.12" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-43853d.svg" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg" /></a>
  <a href="#what-muse-will-not-do-boundaries"><img alt="Cloud egress: off by default" src="https://img.shields.io/badge/cloud%20egress-off%20by%20default-6f42c1.svg" /></a>
  <a href="https://ollama.com"><img alt="Runs on Ollama" src="https://img.shields.io/badge/runs%20on-Ollama-000000.svg" /></a>
  &nbsp;·&nbsp; <a href="README.ko.md">한국어</a>
</p>

> **Learns you, not the world.**
>
> *세상이 아니라, 너를 학습한다.*
>
> It learns you a little deeper every day, lives only on your machine, and forgets the moment you tell it to.

Most AI learns the whole world — and you, for everyone else. Muse learns **you**, for
**you**: it builds a model of who you are from the notes, files, and mail you'd never
paste into ChatGPT, reinforces what actually works for you, and **forgets the moment you
correct it**. That model of you never leaves your machine (cloud egress is **refused in
code**, not a setting), and every claim it makes cites a real source — weak grounding
becomes *"I'm not sure,"* an un-groundable claim is dropped by code. The deeper it knows
you, the more it's yours.

> Hermes learns you too — but on its server, and it can confabulate. **Muse learns you on
> _your_ machine, cites why it believes what it knows, and forgets when you correct it** —
> a model of you that gets sharper without ever getting riskier (fabrication rate = 0 is a
> release gate).

---

## ✨ Why Muse — five principles

Read these five and you know exactly what kind of agent this is.

1. **Learns you — _not the world._**
   Muse builds a model of who *you* are — your facts, preferences, goals, and the things
   it must never suggest — from what you tell it and correct it on. It reinforces the
   strategies that work for you (the **Playbook**), grinds down its own blind spots (the
   **Whetstone**), and — unlike every "memory" that only piles up — **forgets the moment
   you correct it**. A fixed local brain that gets sharper *about you* every day, with no
   weight changes. (`muse memory`, `muse doctor --weaknesses`)

2. **It's yours — _the model of you can stay on your machine._**
   Runs on a local open-source model by default (`gemma4:12b` via Ollama —
   multimodal + grounding-strong — or any weights you run locally), and it's provider-
   neutral: use cloud or local, your choice. Privacy is a first-class **opt-in** — set
   `MUSE_LOCAL_ONLY=true` and cloud egress is **refused in code** (the runtime won't even
   start against a cloud provider). The deeper it knows you, the more that matters.

3. **Honest — _it won't make you up._**
   Every answer, proactive nudge, and insight cites the real source it came from; weak
   grounding becomes *"I'm not sure"*; an un-groundable claim is **dropped by code**. The
   same gate governs recall, proactivity, reflection, **and plain `muse chat`** — ask
   *"what's my office VPN MTU?"* and it quotes your note's `1380`, not the textbook `1500`.
   **Fabrication rate = 0 is a release gate**, measured continuously — so a model of you
   that deepens never gets riskier.

4. **Distills nature's mechanisms — _the cross-field moat._**
   Muse mines OPEN papers from **biology, ecology, neuroscience** and beyond, turning a
   real mechanism into a deterministic, live-verified capability: optimal foraging →
   adaptive recall depth, ant stigmergy → an evaporating note-relatedness graph,
   allostasis → anticipating a recurring need. A rival can copy a feature; copying a
   *research-distillation discipline yoked to a fabrication-zero floor* is far harder.
   ([full catalog ↓](#cross-field-mechanism-distillation-the-moat))

5. **Yours to act through — _draft-first, never autonomous._**
   Acts through your real tools (calendar, notes, tasks, reminders, the web) — but any
   send or action toward another person is **draft-first and needs your explicit
   confirmation**. Banking and money movement are permanently out of scope.

> Principle 1 is *what Muse is* — it learns you; principles 2–3 are *why you can trust it
> with that* — the learning stays yours and stays honest; principle 4 is *how* it keeps
> gaining capabilities a copycat can't.

A native **macOS desktop companion** (a floating, voice-capable orb; on-device speech via
WhisperKit + Qwen3-TTS) is the newest surface — same local-only, grounded runtime.

---

## ⚡ See it

```bash
# Requirements: Node.js >= 22.12 (24 LTS recommended) + pnpm 10 · macOS only (Windows support planned)
pnpm install && pnpm build && pnpm test

# 30-second JARVIS demo (runs on your local default model, gemma4:12b via Ollama):
pnpm demo
```

The demo exercises chat with cross-turn memory, a credential-free proactive notice, the
setup diagnostic, and the Codex / Claude Desktop MCP bridge in one narrated run. Then
`muse onboard` walks you — one command at a time — from a fresh install to your first
private, cited answer.

The full command surface (`muse --help`):

<p align="center"><img src="docs/images/cli-help.png" alt="muse --help command catalog" width="620" /></p>

`muse status` and `muse today` render entirely from your local stores — **no API key
required** (they fall back to a local briefing when the API server isn't running):

| `muse today` | `muse status` |
| --- | --- |
| <img src="docs/images/cli-today.png" alt="muse today briefing" width="420" /> | <img src="docs/images/cli-status.png" alt="muse status dashboard" width="420" /> |

### Daily-driver flows

```bash
# JARVIS REPL — continuous conversation, token streaming, persona-aware (type /help):
muse chat --local --user me

# Ad-hoc summarisation over stdin:
cat note.md | muse chat --local --no-tools "한 단락으로 요약"   # gemma4:12b by default

# Real-time proactive daemon — notices address you by name, in your language:
muse proactive watch --user me --interval 60

# At-a-glance dashboard — model, persona, imminent tasks, last notice:
muse status --user me
```

### What "JARVIS" means in Muse

Muse keeps a persistent personal model at `~/.muse/user-memory.json` keyed by `--user <id>`.
Every REPL turn the model sees your **facts** (`name`, `city`, `role`…), **preferences**
(`language`, `reply_style`…), **vetoes** (things it must never suggest), **goals**, and the
current local **date / time**. Facts are auto-extracted from chat, taught with `/remember`,
or set directly with `muse memory set` (no-LLM path).

The same persona ships into `muse proactive watch`, so *"Send Q3 memo due in 5 min"* gets
translated through your prefs and lands as **"Q3 예산 메모를 금융팀에 보내야 합니다. 지금
작성 시작할까요?"** — same daemon, same model, no extra work. Muse doesn't just wrap a model
for a single call; it remembers you and shapes every future turn *and* every proactive notice.

---

## 🔧 Under the hood

- **Model-neutral core.** OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama, LM Studio,
  and any OpenAI-compatible endpoint live behind a single `ModelProvider` adapter. The
  runtime calls the abstraction, never a vendor SDK directly. The same core drives the CLI,
  the API server, and the web UI.
- **Tool & MCP first.** Tools are first-class — read, write, or execute — with explicit risk
  levels, approval gates, and deterministic loop limits. 25 in-process `muse.*` servers ship
  built-in (eight pure-utility: `time` / `text` / `math` / `json` / `url` / `crypto` / `diff` /
  `regex`, plus the personal-domain set); external servers connect over stdio / SSE /
  streamable-HTTP. `muse mcp serve` runs the reverse direction — Muse itself AS a local,
  read-only MCP server (`muse_recall` cited grounded Q&A, `knowledge_search` ranked search,
  `user_model_read` your facts/preferences with confidence) another agent can connect to;
  see [MCP server mode](#mcp-server-mode-muse-mcp-serve) below.
- **Personal-domain primitives.** Markdown notes, a todo list, reminders, contacts, and calendar
  events across 5 providers (Local file, Local-ICS, Google Calendar, CalDAV, macOS Calendar.app) —
  plus macOS Reminders / Notes mirrors — all stored locally by default, queryable by the agent,
  editable from CLI / Web UI.
- **Multi-agent orchestration.** Sequential or parallel worker fan-out, an in-memory
  cross-agent message bus, per-run history with full conversation snapshots — exposed over
  HTTP and SSE.
- **Messaging channels.** Inbound/outbound adapters for **Telegram, Discord, Slack, and LINE**
  (plus local macOS desktop notifications), all routed through the same fail-closed
  channel-approval gate — a reply toward a person is draft-first, never autonomous.
- **Deterministic safety.** Guards are fail-close, hooks are fail-open, security lives in code
  (never in prompt instructions). Tool output is untrusted until sanitised. Risky local
  execution flows through a separate Rust runner (`crates/runner`).

<details>
<summary><b>Repository layout</b></summary>

```
apps/
  api/        Fastify API server (chat, agent specs, multi-agent, MCP, scheduler, calendar, tasks)
  cli/        terminal agent (commander + Ink TUI + setup wizards)
  web/        React UI — 13 panels (Chat, Today, Dashboard, Tasks, Reminders, Calendar,
              Notes, Memory, Messaging, Tools, Activity, Autonomy, Settings)
  desktop/    native macOS floating companion (SwiftPM)

packages/
  agent-core/    ReAct + Plan-Execute loops, guard pipeline, hook registry, model loop
  model/         ModelProvider interface + provider wire-format adapters
  tools/         tool registry, executor, sanitiser, approval path
  multi-agent/   SupervisorAgent, MultiAgentOrchestrator, message bus, history
  mcp/           MCP transports + loopback servers (notes / tasks / calendar) + NotesProvider
  calendar/      CalendarProvider abstraction + Local / ICS / Google / CalDAV / macOS adapters
  policy/        input / output guards, approval policies, adversarial red-team harness
  memory/        context trimming, summaries, user-memory store + auto-extraction hook
  observability/ tracing, latency / token-cost queries, JARVIS snapshot
  recall/        grounded-recall presentation / orchestration
  skills/        self-authored skills (author / curate / merge)
  a2a/           Muse-to-Muse swarm + council federation
  messaging/     Telegram / Discord / Slack / LINE adapters
  voice/         STT / TTS registry (local + cloud)
  browser/       real-Chrome control (opt-in, gated)
  autoconfigure/ zero-config provider / model / index resolution
  db/ scheduler/ auth/ cache/ resilience/ runtime-state/ runtime-settings/ macos/ prompts/ shared/

crates/
  runner/        Rust sandbox: shell / process / file execution
```
</details>

---

## What Muse will not do (boundaries)

Deliberate product boundaries, enforced in code — not TODOs:

- **No money movement.** Muse never connects to bank / brokerage accounts, initiates payments,
  or moves money. The blast radius is irreversible for a single-user assistant; a permanent
  boundary, not a deferral ([`outbound-safety.md`](.claude/rules/outbound-safety.md)).
- **No autonomous third-party sends.** Anything that transmits to another person (email, chat,
  message, web form / booking) is **draft-first and you confirm the exact content** before it
  leaves. The approval gate is fail-closed: deny / timeout / ambiguous recipient ⇒ nothing is sent.
- **Single user, single environment.** No multi-tenant accounts, no shared workspace, no RBAC.
  Identity is your local `$USER`.
- **Vision input — one path excepted.** Image attachments are serialized on local **Ollama**
  (`muse ask --image`), **Anthropic**, OpenAI **Chat-Completions**, OpenAI-compatible /
  OpenRouter, and **Gemini**. The only exception is the OpenAI **Responses** API path (text-only).
  Under local-only (the default) image bytes never leave the machine regardless.

---

## 🪟 Windows

Muse core runs on Windows: the CLI, the API server, grounded recall, and the
local Ollama model ([Ollama for Windows](https://ollama.com/download/windows)).
Platform behavior is gated in CI on `windows-latest`; macOS-only integrations
(Apple Notes/Reminders mirrors, Contacts import, the desktop companion) are
disabled automatically — `muse doctor` shows the exact posture for your OS.

- Native actuators: set `MUSE_WINDOWS_ACTUATORS=true` to arm the PowerShell
  tool set — open apps/URLs, read battery/wifi/storage/frontmost window, set
  the clipboard, speak text, take screenshots, control media, and change
  volume / display sleep. Dark by default, like the macOS actuators.
- Ambient awareness: `MUSE_AMBIENT_SOURCE=windows` feeds the proactive daemon
  the frontmost window (clipboard strictly opt-in).
- Autostart: `muse daemon --install` registers a `schtasks` logon task
  (LaunchAgent on macOS).
- Media/volume key events are CI-verified only (no observable state on a
  runner) — report anything odd via issues.
- Voice output uses PowerShell's wav player; recording needs
  [sox for Windows](https://sourceforge.net/projects/sox/) on PATH.
- Windows paths are CI-verified; report anything odd via issues.

## 🧩 Providers & configuration

Pick a model at runtime via env:

| Env | Example | Notes |
| --- | --- | --- |
| `MUSE_MODEL` | `gemini/gemini-2.0-flash` | `<providerId>/<modelId>` form |
| `MUSE_MODEL_PROVIDER_ID` | `gemini` | optional override; inferred from prefix |
| `MUSE_MODEL_API_KEY` | `…` | per-provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) also work |
| `MUSE_MODEL_BASE_URL` | `http://localhost:11434/v1` | overrides for OpenAI-compatible endpoints (Ollama, LM Studio, custom) |

**Free / offline path** — Ollama with an open-source model:

```bash
brew install ollama && ollama serve &
ollama pull gemma4:12b                 # the shipped default — multimodal + grounding-strong
muse setup local                       # wires defaultModel into ~/.config/muse/config.json
```

See [`docs/setup-local-llm.md`](docs/setup-local-llm.md) for the four tiers
(0.8B / 2B / 9B / 27B), license notes, and a latency-measuring dogfood script.

<details>
<summary><b>First-run troubleshooting</b></summary>

| Symptom | Fix |
| --- | --- |
| Local model calls fail / time out | Start Ollama: `ollama serve` (probes `${OLLAMA_BASE_URL:-http://localhost:11434}`) |
| `model not found` | Pull the shipped default: `ollama pull gemma4:12b` |
| Not sure what's wired (model, posture, providers) | `muse doctor` reports the local-only posture and resolved configuration |

`smoke:live` auto-skips when Ollama is unreachable — a skip means the local runtime
isn't up, not that anything is broken.
</details>

### MCP server mode (`muse mcp serve`)

Expose Muse itself as a local MCP server so another agent (Claude Code, Cursor, Codex, …)
can call it: your grounded, cited notes recall and the facts/preferences Muse has learned
about you, available as local tools to every agent you use — nothing leaves your machine.

```bash
claude mcp add muse -- muse mcp serve
```

Three read-only tools, no write/outbound access, no network listener (stdio only):

| Tool | What it does |
| --- | --- |
| `muse_recall` | Cited, gated Q&A over your notes — a weak match answers "I'm not sure", never a guess (requires Ollama) |
| `knowledge_search` | Deterministic ranked search over your notes + remembered facts/preferences (works even with no model running) |
| `user_model_read` | Your facts/preferences with a confidence score; never returns anything vetoed or forgotten |

Running `muse mcp serve` is your explicit consent to expose these read tools to the
connecting client. See `.claude/rules/outbound-safety.md` for why write/outbound tools
aren't in scope here.

**Cloud + API server (BYOK)** — opt out of local-only to reach any provider:

```bash
GEMINI_API_KEY=… MUSE_MODEL=gemini/gemini-2.0-flash MUSE_MODEL_PROVIDER_ID=gemini \
  pnpm --filter @muse/api dev
curl -X POST http://127.0.0.1:3030/api/chat -H 'content-type: application/json' \
  -d '{"message":"What time is it? Use a tool."}'
pnpm --filter @muse/web dev            # or the Web UI → http://localhost:5173
```

<details>
<summary><b>Personal-domain toggles</b></summary>

| Env | Default | Effect |
| --- | --- | --- |
| `MUSE_NOTES_DIR` | `~/.muse/notes` | Markdown notes directory (point at an Obsidian vault to query it) |
| `MUSE_NOTES_ENABLED` | `true` | Disable `muse.notes.*` tools |
| `MUSE_TASKS_FILE` | `~/.muse/tasks.json` | Todo list file |
| `MUSE_CALENDAR_FILE` | `~/.muse/calendar.json` | Local calendar provider file |
| `MUSE_CALENDAR_PROVIDERS` | `local` | Comma list: `local,ics,gcal,caldav,macos` |
| `MUSE_CREDENTIALS_FILE` | `~/.muse/credentials.json` | chmod-600 OAuth / app-password store |
| `MUSE_USER_MEMORY_AUTO_EXTRACT` | `true` | LLM auto-extracts facts/preferences after each turn |

Set up calendar providers interactively with `muse setup calendar` (multi-select
Local / Local-ICS / Google / CalDAV / macOS; OAuth + app-password flows; chmod-600 credentials).
</details>

---

## ✅ Verification

Tests are the only form of verification. The repo ships these gates:

```bash
pnpm check        # build + test for every workspace (thousands of tests across all 28 packages)
pnpm smoke:broad  # 51 HTTP endpoints, diagnostic provider (no key)
pnpm smoke:live   # real LLM round-trip — LOCAL OLLAMA ONLY, gemma4:12b (auto-skips if unreachable)
```

`smoke:live` is **local Ollama only by deliberate policy** — it probes
`${OLLAMA_BASE_URL:-http://localhost:11434}` and asserts the model→tool→model loop
end-to-end across direct chat, streaming SSE, plan-execute, input guards, multi-agent
orchestration, `muse.notes.search`, `muse.tasks.add`, and `muse.calendar.add`. Cloud
provider keys are intentionally never consulted.

---

## 📚 Research & attributions

Muse is an independent MIT project. The designs below were **studied and reimplemented from
scratch** (no third-party source copied) — we record where the ideas came from, per feature.
Full notices: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

| Feature | Borrowed idea | Source |
| --- | --- | --- |
| **Held-out validation gate** over self-edits — a merged skill, playbook strategy, or inferred preference commits only if semantically supported by its evidence, else dropped (script-aware, so bilingual KO/EN learning isn't false-rejected) | propose-and-test self-improvement | **SkillOpt**, Microsoft (MIT) — [arXiv 2605.23904](https://arxiv.org/abs/2605.23904) |
| Session-end skill authoring, curator consolidation, behavior-inferred user model, background-review engine | fork-and-review self-improvement | **Hermes Agent**, Nous Research (MIT) |
| Recurring-theme surfacing, episode consolidation, skill-body risk scan, commitment extraction | sleep/"dreaming" memory consolidation | **OpenClaw** (MIT) |
| Grounded reflection synthesis (insights cite their source episodes) | offline reflection over observations | Generative Agents — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442) |
| Confidence-gated cited recall ("I'm not sure" floor) | lightweight retrieval evaluator | CRAG — [arXiv 2401.15884](https://arxiv.org/abs/2401.15884) |
| Long-context passage reordering (strong sources at head/tail) | "Lost in the Middle" | [arXiv 2307.03172](https://arxiv.org/abs/2307.03172) |
| Preference inference from real corrections (not self-judgement) | distil from outcome signals | ReasoningBank — [arXiv 2509.25140](https://arxiv.org/abs/2509.25140) |

### Cross-field mechanism distillation (the moat)

Beyond the AI-agent literature, Muse continuously mines OPEN papers from **many fields** —
biology, ecology, neuroscience, network science, control theory, decision & information
theory, linguistics, psychology, forensic & environmental statistics — distilling a real
mechanism into a deterministic, live-verified capability.

<details>
<summary><b>The full mechanism catalog</b></summary>

| Field | Mechanism (paper) | Muse capability |
| --- | --- | --- |
| Ecology | Optimal foraging / Marginal Value Theorem (Charnov 1976) | `muse recall --adaptive` — the evidence picks how many sources to return |
| Collective behaviour / biology | Stigmergy, ant pheromone trails (Grassé 1959; Vittori 2006) | `muse notes trails` / `hubs` — an evaporating co-recall relatedness graph |
| Physiology / neuroscience | Allostasis — predictive regulation (Sterling 2012) | `muse pattern upcoming` — anticipate a recurring need before its slot |
| Network science | k-shell decomposition / influential spreaders (Kitsak et al. 2010) | `muse notes hubs` — the load-bearing core of your notes (depth, not degree) |
| Network science / ecology | Betweenness / brokerage (Freeman 1977; Burt 1992) + keystone species (Paine 1966) | `muse notes bridges` — the notes connecting your separate topic clusters |
| Control theory / SPC | CUSUM change-point (Page 1954) | `muse pattern lapsed` — a recurring habit that has STOPPED |
| Decision / information theory | Expected information gain / EVPI (Lindley 1956; Howard 1966) | `muse ask` clarify arm — ask when divergent sources tie, vs guess or abstain |
| Computer science (web-scale) | Broder resemblance / shingling (Broder 1997) | `muse feeds` near-duplicate collapse (same story across outlets) |
| Information science | Luhn extractive summarization (Luhn 1958) | `muse summarize` — a document's own key sentences (cannot fabricate) |
| Computational linguistics | Pointwise mutual information (Church & Hanks 1990) | `muse contacts related` — inferred relationship edges from co-mention |
| Queueing / operations research | Little's Law L=λW (Little 1961) | `muse tasks flow` — are you finishing tasks as fast as you add them? |
| Real-time systems / scheduling | Earliest Deadline First (Liu & Layland 1973) + aging | `muse tasks next` — what to do NOW, with a why-now; old tasks aged up |
| Cognitive psychology | Autobiographical / date-cued recall (Rubin et al. 1986) | `muse on-this-day` — notes from today's date in earlier years |
| Organizational psychology | Attention residue / deep work (Leroy 2009) | `muse calendar focus` — your longest uninterrupted block |
| Psychology | Implementation intentions / time-blocking (Gollwitzer 1999) | `muse calendar block` — book the next free slot to protect focus |
| Cognition / strategy | First-principles (Musk) + contrarian question (Thiel) | reasoning principles in `muse ask` — the engine; the grounding floor is the brake |

Each mechanism cites its paper in the module header; the verified feature inventory lives in
[`docs/feature-catalog/INDEX.md`](docs/feature-catalog/INDEX.md).
</details>

Deep dives: [differentiation](docs/strategy/differentiation.md) ·
[verified feature catalog](docs/feature-catalog/INDEX.md) ·
[frontier research](docs/strategy/frontier-research-2026-06.md).

---

## 📖 Documentation

| Goal | Read |
| --- | --- |
| Run on a local open-source model (tiers, licenses, latency) | [`docs/setup-local-llm.md`](docs/setup-local-llm.md) |
| The verified, proof-cited feature inventory | [`docs/feature-catalog/INDEX.md`](docs/feature-catalog/INDEX.md) |
| Why Muse differs from Hermes / OpenClaw | [`docs/strategy/differentiation.md`](docs/strategy/differentiation.md) |
| The 2026 frontier research it draws on | [`docs/strategy/frontier-research-2026-06.md`](docs/strategy/frontier-research-2026-06.md) |
| Security posture & reporting | [`SECURITY.md`](SECURITY.md) |
| The bluebird mascot — concept, states, palette, single-source pixels | [`docs/design/mascot.md`](docs/design/mascot.md) · [showroom](docs/design/mascot-showroom.html) |
| Korean overview | [`README.ko.md`](README.ko.md) |

---

## 💬 Community & support

Questions, bugs, and feature ideas go through GitHub:

- **Issues** — [github.com/wlsdks/Muse/issues](https://github.com/wlsdks/Muse/issues)
- **Security reports** — see [`SECURITY.md`](SECURITY.md) (do not open a public issue for vulnerabilities)

---

## Contributing

This repo follows a lean-contract style for Claude Code collaboration:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, verification gates, commit / lint / test discipline
- [`CLAUDE.md`](CLAUDE.md) — the contract every Claude Code agent reads first
- [`.claude/rules/`](.claude/rules/) — domain rules (architecture, testing, commits, code style, …)
- [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`). Commits
and PR descriptions are written in English.

## License

[MIT](LICENSE). The runtime, adapters, and tooling are open source. Contributions are accepted
under the same terms — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
