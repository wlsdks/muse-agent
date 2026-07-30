<div align="center">

<img src="docs/assets/mascot.svg" alt="Muse" width="112" />

# Muse

### An AI that stays with you between conversations.

<p>Muse holds the threads you didn't finish, answers from your own notes with receipts you can open,<br/>
and asks before it does anything on your behalf. You choose the model and where it runs.</p>

<p><a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-22c55e.svg" /></a> <a href="package.json"><img alt="Node ≥ 22.12" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-43853d.svg" /></a> <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6.svg" /></a> <a href="#architecture"><img alt="Provider-neutral" src="https://img.shields.io/badge/architecture-provider--neutral-6f42c1.svg" /></a> <a href="https://ollama.com"><img alt="Runs on Ollama" src="https://img.shields.io/badge/runs%20on-Ollama-000000.svg" /></a></p>

</div>

<p align="center"><img src="docs/images/web-home.png" alt="The Muse console" width="840" /></p>

---

<table>
<tr>
<td width="33%" valign="top">

**🧵 It keeps the thread**

Not a chat that forgets. You name what you're in the middle of; Muse hands it back later with
what changed.

</td>
<td width="33%" valign="top">

**🧾 It shows its work**

Answers are built from your own notes, each with a receipt you can open. Weak evidence gets an
honest *"I'm not sure."*

</td>
<td width="33%" valign="top">

**🔐 You decide where it runs**

Plain files in `~/.muse/`, no cloud account required. `MUSE_LOCAL_ONLY=true` turns cloud egress
into a hard error.

</td>
</tr>
</table>

### Contents

| | |
| --- | --- |
| **Get going** | [Install](#install) · [Local or cloud](#local-or-cloud--your-choice) · [Everyday commands](#everyday-commands) |
| **The idea** | [Continuity, the one thing Muse is for](#continuity--the-one-thing-muse-is-for) · [How Muse answers](#how-muse-answers) · [Where this is going](#where-this-is-going) |
| **The truth** | [Status: what's real today](#status--whats-real-today) · [Evidence and numbers](#evidence-and-numbers) · [What Muse will never do](#what-muse-will-never-do) |
| **The code** | [Architecture](#architecture) · [Repository layout](#repository-layout) · [Build and verify](#build-and-verify) · [Documentation](#documentation) |

---

## Install

### Requirements

| | |
| --- | --- |
| **Node.js** | ≥ 22.12 (24 LTS recommended) |
| **pnpm** | 10 (`corepack enable`) |
| **A model** | [Ollama](https://ollama.com) on your machine, or any provider API key |
| **OS** | macOS, Linux, Windows (CLI, API, recall, Ollama, opt-in PowerShell actuators) |

### Install from source

```bash
git clone https://github.com/wlsdks/muse-agent.git
cd muse-agent && corepack enable
pnpm install:muse     # frozen install → build → link the `muse` CLI → verify
muse onboard
```

`pnpm install:muse` requires a clean `main`. Preview it with `pnpm install:muse -- --dry-run`,
update later with `muse update`, or watch the narrated tour with `pnpm demo`. If anything looks
wrong afterwards, `muse doctor` diagnoses and repairs the local setup in one pass.

### Local or cloud — your choice

Any provider works. If you want no API key and no egress at all, point Muse at a model on your own
machine:

```bash
brew install ollama && ollama serve &
ollama pull gemma4:12b
muse setup local
```

Local-only is a supported posture, not Muse's identity. Turn it on explicitly with
`MUSE_LOCAL_ONLY=true` and every cloud provider becomes a hard error instead of a silent fallback —
including voice, so microphone audio can never reach a cloud API by accident.

---

## Continuity — the one thing Muse is for

Most assistants start from zero every time. Muse is built around the opposite: you tell it which
thread matters, and it gives that thread back to you later — where you stopped, what changed since,
the next step, and every source it used.

### 1. Start a thread and link what belongs to it

```bash
muse thread start "Plan a birthday" --kind life
muse thread link <thread-id> note birthday.md --role context
muse thread link <thread-id> task <task-id>   --role next-step
```

### 2. Get it back when you return

```bash
muse continue <thread-id>
```

You get a **pack**: the stopping point, the changes since, a proposed next step, and the receipts
behind each claim. Nothing is guessed — the pack is built only from sources you linked.

### 3. Tell it whether that helped

```bash
muse thread outcome <delivery-id> used     # or: adjusted, ignored, rejected
```

This is the loop that makes the next pack better. Outcomes are recorded, not inferred.

> **Muse doesn't remember apps. It remembers the state you meant to continue.**

---

## Everyday commands

| Command | What you get |
| --- | --- |
| `muse ask "when is the dentist?"` | An answer built from your own notes, each one cited and openable — and an honest *"I'm not sure"* when the evidence is weak. |
| `muse chat` | A conversation that carries over from the last one instead of starting from zero. |
| `muse today` · `muse digest` | Your day, and one evening summary instead of a stream of pings. |
| `muse remember` · `muse recall` · `muse forget` | Facts, preferences, goals and vetoes you can read, correct, and delete. |
| `muse notes` · `muse tasks` · `muse remind` · `muse calendar` | Plain files you own, with five calendar backends behind one interface. |
| `muse proactive watch` | Muse speaks first — inside a hard interruption budget, never as an autonomous send. |
| `muse mcp serve` | Other agents get read-only access to your grounded recall over MCP. |
| `muse doctor` | One-shot diagnosis and repair of a broken local setup. |

<p align="center"><img src="docs/images/cli-ask.png" alt="muse ask with an openable receipt, and muse today" width="880" /></p>

---

## How Muse answers

A personal assistant that invents a detail about your own life is worse than useless. So on the
grounded paths, retrieval is not a suggestion to the model — it is a gate in front of it.

| Step | What the code does |
| --- | --- |
| **Retrieve** | Ranks your local notes and memory for the question, across languages (a Korean question can reach an English note). |
| **Weigh** | Weak matches are lowered rather than promoted. Stale sources are marked, not silently trusted. |
| **Answer** | The reply must cite the sources it used. Citations that don't resolve are dropped from the answer. |
| **Abstain** | Below the confidence gate, Muse says it isn't sure instead of producing a confident guess. |
| **Correct** | You can contradict it. The correction is stored and decays the belief it replaced. |

**The honest limit:** this covers the supported grounded paths. Fast uncited chat is a documented
gap, not a solved problem — see [the grounding gate](docs/grounding-gate.md).

---

## Where this is going

> You stopped while comparing three places to stay. Since then the flight moved, one cancellation
> deadline came close, and an 18-minute gap opened in your day. Muse prepares only the changes,
> says why now, cites every source, shows exactly how far an action would go — and asks whether to
> hold one option. If you answer *"this evening instead"*, that becomes a visible rule for this
> trip, not a hidden global preference.

Three pieces have to work for that moment to exist:

| | Piece | What it decides |
| --- | --- | --- |
| 🌘 | **Shadow Muse** | When to speak and when to stay quiet — learned before it ever interrupts. |
| 💊 | **Continuity Capsule** | The restored stopping point: changes, evidence, next step, expected time. |
| 🪪 | **Policy Card** | What Muse proposes to learn about working with you — with trial, edit, reject, rollback. |

None of the three is finished. The next section says exactly how far each one got.

---

## Status — what's real today

### Working

| Area | Notes |
| --- | --- |
| Memory, grounded recall with citations, local personal stores | Encryption at rest for memory, episodes and the action log |
| Guarded tools and browser actions, traces, checkpoints | Fail-close guards, bounded loops, timeouts |
| Explicit continuity threads | `start → link → muse continue → outcome`, end to end |
| One runtime across CLI, web/API, messaging, scheduled jobs | Same guards, same approvals, same traces |

### Partly built

| Area | Where it actually stands |
| --- | --- |
| Attunement Graph engine | Exact projection, *"what changed since I stopped"*, content-addressed observation receipts, resume compiler and a durable projection journal — all verified, all still process-local substrate |
| Continuity Capsule | Render data returned from an explicit API call. No product UI, no automatic timing |
| Shadow Muse | The ledger records the decision. It does not surface anything on its own yet |

### Roadmap

Policy Card · automatic thread detection · a durable current-world graph · standalone release of the
graph engine · organic-use evidence.

<details>
<summary><b>The fine print on the graph engine (MAG)</b></summary>

<br/>

The [Muse Attunement Graph](docs/design/attunement-graph.md) is an agent-native temporal/provenance
graph and personal context compiler — not a third-party graph DB. RAG can find *likely* context; MAG
has to prove the exact thread, time, change, source and policy relation. It runs on an embedded
SQLite store behind an isolated worker, with no external graph server required
([blueprint](docs/design/agent-native-graph-core.md)).

It is deliberately built as an independently extractable module — Muse is its first consumer and
dogfood environment. The public interface, adapter boundaries and repository-split plan are fixed in
[ADR 0001](docs/adr/0001-mag-product-module-boundary.md); TypeScript-first with Rust only for
benchmark-proven hot kernels in [ADR 0002](docs/adr/0002-mag-language-runtime-boundary.md).

What is verified today, and what those words do **not** mean:

- The neutral lifecycle `openMag({ scope, store }) → project → execute → close`, plus a durable
  projection journal and typed worker boundary. Portable export/rebuild, backup, physical forget and
  the 10K/100K/1M benchmarks are still pending.
- Observation receipts are *caller-declared* integrity evidence. They prove bytes and boundaries —
  not that Muse observed you, and not your exact stopping point.
- Freshness is honest by construction: only exact endpoint equality under a bounded head
  revalidation becomes `fresh-at-assessment`. A single read stays `unassessed` and forces downstream
  abstention rather than a guess.
- Resume baselines are per-process, capped at 16 threads, and not persisted. None of this is action
  authority, automatic behaviour, or evidence that it is useful in real life.

Sequenced in the [wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md).

</details>

---

## Evidence and numbers

Two qualified controlled results, and nothing promoted past its evidence. Failed, unchanged and
diagnostic runs stay visible in the [evidence index](docs/benchmarks/EVIDENCE.md) instead of being
quietly dropped.

### Grounding

For the same fictional appointment question, grounding should cite the linked note instead of
answering from an assumption. Two independent controlled checks measured faithfulness:

| Check | Faithfulness (gate ON vs OFF) | Delta | False-refusal cost |
| --- | --- | --- | --- |
| Self-authored corpus | **16/17** vs **0/17** | **+0.94** | 0/12 vs 0/12 (**+0.00**) |
| SQuAD-2.0 slice | **5/8** vs **0/8** | **+0.63** | 0/8 vs 0/8 (**+0.00**) |

Different denominators; deliberately not aggregated into one headline number.

![Two independent qualified grounding checks with raw faithfulness counts and false-refusal cost](docs/benchmarks/readme-qualified-grounding-v1.svg)

Source: [closed README evidence manifest](docs/benchmarks/readme-qualified-evidence-v1.json)

### Synthetic integrity at scale

Four corpora — **1K / 10K / 100K / 1M** — produced **1,111,000/1,111,000** records generated,
serialized, parsed and schema-validated. A separate stratified runtime sample passed **768/768**
public Muse seams across **96** cells with **0 / 0 / 0** LLM, tool and network calls; owner state
stayed byte-stable.

![Full-corpus controlled synthetic integrity totals separated from the 768-case runtime sample](docs/benchmarks/readme-controlled-scale-v1.svg)

Source: [canonical scale JSON](docs/benchmarks/eval-datasets-scale-v1.json)

### What these numbers do not mean

- The agent aggregate is **10/11 FAILED**. Organic effectiveness is **NOT_PROVEN**. Recall
  correction remains **UNQUALIFIED**.
- Controlled synthetic integrity is not personal learning, and controlled evidence is not organic
  effectiveness.
- **1,111,000 records are not 1,111,000 agent runs.**

Sources: [grounding manifest](docs/benchmarks/readme-qualified-evidence-v1.json) ·
[scale JSON](docs/benchmarks/eval-datasets-scale-v1.json) ·
[evidence index](docs/benchmarks/EVIDENCE.md).

---

## What Muse will never do

| | Boundary |
| --- | --- |
| 🚫 | **Move money.** No bank or brokerage connections, no payments, no transfers. Permanently out of scope. |
| ✋ | **Send to a third party on its own.** Email, chat, forms and bookings are draft-first: you confirm the exact content and recipient, or nothing leaves. |
| 🧵 | **Guess your threads.** Continuity threads and their source links are yours to author. Automatic detection is later, opt-in work. |
| 👤 | **Pretend to be a workspace.** Single user, single environment — no multi-tenancy, no RBAC. |
| 📊 | **Promote evidence.** Tests, synthetic replays, diagnostics, agent trials and real outcomes stay separate ledgers. |

Enforced as deterministic code, never as a prompt instruction:
[outbound safety](.claude/rules/outbound-safety.md) · [Attunement design](docs/design/attunement.md).

---

## Architecture

### Any model, one boundary

`agent-core` never talks to a vendor SDK. Everything goes through one `ModelProvider` interface, so
swapping models does not touch agent logic.

```ts
interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

Adapters ship for OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio and any
OpenAI-compatible endpoint. Select one with `MUSE_MODEL=<provider>/<model>` plus its usual API-key
variable; override explicitly with `MUSE_MODEL_PROVIDER_ID`, `MUSE_MODEL_API_KEY` and
`MUSE_MODEL_BASE_URL`. Missing capabilities degrade explicitly — no native tool calling falls back
to a strictly parsed text protocol, no structured output falls back to a parser plus validator.

No vendor owns the runtime, and no vendor is required by it. Storage and processing placement are
explicit deployment choices, not the product's identity.

### Where your data lives

| What | Where |
| --- | --- |
| Notes | `~/.muse/notes/` |
| Tasks | `~/.muse/tasks.json` |
| Reminders | `~/.muse/reminders.json` |
| Memory | `~/.muse/user-memory.json` |
| Config | `~/.config/muse/config.json` |
| Run state | `.muse/runs/*.jsonl` |

Plain files. Memory, episodes and the action log are encrypted at rest; credentials live in the OS
keychain or an encrypted auth store, never in plain text.

### One runtime, every surface

CLI, web/API chat, messaging channels, scheduled jobs and delegated workers all share the same
composition root — the same guards, approvals and traces. Risky local execution goes through the
Rust `runner` as a child process. Tool output is treated as untrusted input, and every tool loop has
an explicit step limit and timeout.

### MCP in both directions

Muse consumes external MCP servers behind an allowlist, and `muse mcp serve` exposes read-only
grounded recall, search and user-model access to other agents.

---

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/agent-core` | The model-agnostic runtime: loops, guards, approvals, traces |
| `packages/model` | Provider adapters — the only place a vendor SDK is allowed |
| `packages/attunement`, `packages/attunement-graph` | Continuity threads and the MAG graph engine |
| `packages/recall`, `packages/memory`, `packages/stores` | Grounded recall, personal memory, file-backed stores |
| `packages/tools`, `packages/browser`, `packages/mcp` | Tool surface, browser control, MCP both ways |
| `apps/cli`, `apps/api`, `apps/web`, `apps/desktop` | The four surfaces, all on one runtime |
| `crates/runner` | Sandboxed local execution |
| `harness/` | The vendor-neutral agent operating harness used to build Muse |

39 workspace packages in total; [the system map](docs/SYSTEM-MAP.md) is the guided tour.

---

## Build and verify

```bash
pnpm typecheck:fast   # while editing
pnpm test:changed     # only the tests related to your change
pnpm check            # full build + test, before merge
pnpm lint             # 0 errors required
```

Agent-level gates, which a type checker cannot replace:

```bash
pnpm smoke:broad      # HTTP sweep against the diagnostic provider, no API key
pnpm smoke:live       # real round-trip against local Ollama
pnpm eval:tools       # does the local model pick the right tool in one shot?
pnpm eval:agent       # judge meta-eval, must-refuse battery, plan quality
```

`smoke:live` deliberately uses local Ollama and skips when it is unreachable — a skip is not a pass.
The latest recorded `eval:agent` aggregate is **10 passed, 1 failed, 0 unverified**, so it stands as
**FAILED**. `pnpm qualify:personal-agent` is a read-only, fail-closed check of current capability,
resident runtime and delivery safety. Test counts are not proof of agent effect.

---

## Documentation

| | |
| --- | --- |
| **Start here** | [System map](docs/SYSTEM-MAP.md) · [Local model setup](docs/setup-local-llm.md) · [Environment variables](docs/ENV.md) |
| **The product** | [Attunement contract](docs/strategy/attunement.md) · [Architecture and gaps](docs/design/attunement.md) · [Implementation plan](docs/goals/attunement-implementation-plan.md) |
| **The graph** | [Attunement Graph](docs/design/attunement-graph.md) · [Agent-native core blueprint](docs/design/agent-native-graph-core.md) · [Roadmap](docs/goals/attunement-wow-graph-roadmap.md) |
| **Trust** | [Grounding gate](docs/grounding-gate.md) · [Privacy and data](docs/privacy-and-data.md) · [Evidence index](docs/benchmarks/EVIDENCE.md) · [Security](SECURITY.md) |
| **Audits** | [Full feature audit](docs/feature-catalog/INDEX.md) — a dated 2026-06-14 snapshot, written in Korean · [Personal-agent qualification](docs/development/personal-agent-qualification.md) |

## Contributing

Questions, bugs and ideas go to [GitHub Issues](https://github.com/wlsdks/muse-agent/issues);
vulnerabilities go through [SECURITY.md](SECURITY.md), not a public issue. Before changing the
repository, read [CONTRIBUTING.md](CONTRIBUTING.md), [CLAUDE.md](CLAUDE.md) and the
[domain rules](.claude/rules/). Conventional Commits, English commit messages.

[MIT](LICENSE) — runtime, adapters and tooling.
