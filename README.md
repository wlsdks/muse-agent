<p align="center">
  <img src="docs/assets/muse-goddess.png" alt="Muse" width="300" />
</p>

<h1 align="center">Muse</h1>

<p align="center">
  <b>A private, local-first personal AI — a self-hosted JARVIS that answers from <i>your own</i> notes and files,<br/>quotes the source, says "I'm not sure" instead of guessing, and never leaves your machine.</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg" /></a>
  <a href="package.json"><img alt="Node ≥ 22.12" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-43853d.svg" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg" /></a>
  <a href="#what-muse-will-not-do-boundaries"><img alt="Cloud egress: off by default" src="https://img.shields.io/badge/cloud%20egress-off%20by%20default-6f42c1.svg" /></a>
  <a href="https://ollama.com"><img alt="Runs on Ollama" src="https://img.shields.io/badge/runs%20on-Ollama-000000.svg" /></a>
  &nbsp;·&nbsp; <a href="README.ko.md">한국어</a>
</p>

> **Tell it everything — it can't tell anyone, and it gets stronger by fixing its own blind spots.**
>
> *네 약점까지 다 말해 — 아무한테도 안 새고, 그걸 같이 고쳐 더 똑똑해지니까.*

Point Muse at the notes, files, and mail you'd never paste into ChatGPT. It runs
**entirely on your own machine** (a local open-source model via [Ollama](https://ollama.com)),
answers from **your own** corpus with the exact passage quoted, and — the part that
earns trust — a **deterministic confidence gate** flags weak matches and says
*"no matching passages"* rather than confabulate. Cloud egress isn't a setting you
remember to turn off; it's **refused in code**.

> Hermes self-improves but can confabulate; OpenClaw "dreams" but its dreams aren't
> grounded. **Muse is the only one that is local, proactive, self-learning — _and_
> incapable of making things up**, and it measures that continuously (fabrication rate = 0
> is a release gate).

---

## ✨ Why Muse — five principles

Read these five and you know exactly what kind of agent this is.

1. **Local by construction — _so you can tell it everything._**
   Runs entirely on a local open-source model (`gemma4:12b` via Ollama by default —
   multimodal + grounding-strong — or any weights you run locally). Cloud egress is
   **refused in code** (`MUSE_LOCAL_ONLY` on by default): the runtime won't even start
   against a cloud provider unless you explicitly opt out. Not your agent on someone
   else's cloud — actually yours.

2. **Shows its work — _never makes things up._**
   Every answer, proactive nudge, and insight cites the real source it came from; weak
   grounding becomes *"I'm not sure"*; an un-groundable claim is **dropped by code**.
   The same gate governs recall, proactivity, reflection, **and plain `muse chat`** —
   ask *"what's my office VPN MTU?"* and it quotes your note's `1380`, not the textbook
   `1500`. **Fabrication rate = 0 is a release gate**, measured continuously.

3. **Whetstone — _overcomes its own weaknesses to get stronger._**
   Muse notices what it reliably gets wrong (a refusal it shouldn't make, an action it
   claimed but didn't do), records it, and grinds it down — the way a disciplined learner
   improves a *fixed* brain, with no weight changes. Paired with the **Playbook**, which
   reinforces the strategies that work for you. _A modest model kept sharp out-cuts a finer
   one left dull._ (`muse doctor --weaknesses`)

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

> Principle 1 is *why* you can tell it everything; principles 2–3 are *what it then does
> for you*; principle 4 is *how* it keeps gaining capabilities a copycat can't.

A native **macOS desktop companion** (a floating, voice-capable orb; on-device speech via
WhisperKit + Qwen3-TTS) is the newest surface — same local-only, grounded runtime.

---

## ⚡ See it

```bash
# Requirements: Node.js >= 22.12 (24 LTS recommended) + pnpm 10
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
  levels, approval gates, and deterministic loop limits. ~24 in-process `muse.*` servers ship
  built-in (eight pure-utility: `time` / `text` / `math` / `json` / `url` / `crypto` / `diff` /
  `regex`, plus the personal-domain set); external servers connect over stdio / SSE /
  streamable-HTTP.
- **Personal-domain primitives.** Markdown notes, a todo list, and calendar events across 5
  providers (Local file, Local-ICS, Google Calendar, CalDAV, macOS Calendar.app) — all stored
  locally by default, queryable by the agent, editable from CLI / Web UI.
- **Multi-agent orchestration.** Sequential or parallel worker fan-out, an in-memory
  cross-agent message bus, per-run history with full conversation snapshots — exposed over
  HTTP and SSE.
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
pnpm check        # build + test for every workspace (thousands of tests across all 27 packages)
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
<summary><b>The full 20-mechanism catalog</b></summary>

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

Each mechanism cites its paper in the module header; the verified feature inventory lives in
[`docs/feature-catalog/INDEX.md`](docs/feature-catalog/INDEX.md).
</details>

Deep dives: [differentiation](docs/strategy/differentiation.md) ·
[verified feature catalog](docs/feature-catalog/INDEX.md) ·
[frontier research](docs/strategy/frontier-research-2026-06.md).

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
