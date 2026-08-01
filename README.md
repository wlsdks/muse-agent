<div align="center">

<img src="docs/assets/mascot.svg" alt="Muse" width="112" />

# Muse

### An AI that stays with you between conversations.

<p>Muse holds the threads you didn't finish, answers from your own notes with receipts you can open,<br/>
and asks before it does anything on your behalf. You choose the model and where it runs.</p>

<p><a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-22c55e.svg" /></a> <a href="package.json"><img alt="Node ≥ 22.12" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-43853d.svg" /></a> <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6.svg" /></a> <a href="#architecture-in-one-paragraph"><img alt="Provider-neutral" src="https://img.shields.io/badge/architecture-provider--neutral-6f42c1.svg" /></a></p>

```bash
git clone --recurse-submodules https://github.com/wlsdks/muse-agent.git && cd muse-agent
corepack enable && pnpm install:muse && muse onboard
```

</div>

<p align="center"><img src="docs/images/muse-continue.gif" alt="A real session: muse thread start, two muse thread link calls, then muse continue handing the thread back with its connected context, next step and receipts" width="900" /></p>

<p align="center"><i>A real session: you park a thread, and a week later Muse hands it back — with its sources.</i></p>

---

### Contents

| | |
| --- | --- |
| **Get going** | [Install](#install) · [Local or cloud](#local-or-cloud--your-choice) · [Everyday commands](#everyday-commands) |
| **The idea** | [Continuity, the one thing Muse is for](#continuity--the-one-thing-muse-is-for) · [How Muse answers](#how-muse-answers) · [Where this is going](#where-this-is-going) |
| **The truth** | [Status: what's real today](#status--whats-real-today) · [Evidence and numbers](#evidence-and-numbers) · [What Muse will never do](#what-muse-will-never-do) |
| **The code** | [Architecture](#architecture-in-one-paragraph) · [Build and verify](#build-and-verify) · [Documentation](#documentation) |

---

## Install

### Requirements

| | |
| --- | --- |
| **Node.js** | ≥ 22.12 (24 LTS recommended) |
| **pnpm** | 10 (`corepack enable`) |
| **A model** | [Ollama](https://ollama.com) on your machine, or credentials for a supported provider |
| **OS** | macOS, Linux, Windows (CLI, API, recall, Ollama, opt-in PowerShell actuators) |

### Install from source

```bash
git clone --recurse-submodules https://github.com/wlsdks/muse-agent.git
cd muse-agent && corepack enable
pnpm install:muse     # frozen install → build → link the `muse` CLI → verify
muse onboard
```

`pnpm install:muse` requires a clean `main`. Preview it with `pnpm install:muse -- --dry-run`,
update later with `muse update`, or watch the narrated tour with `pnpm demo`. If anything looks
wrong afterwards, `muse doctor` diagnoses and repairs the local setup in one pass.
For an existing source checkout, initialize the embedded engine with
`git submodule update --init --recursive`.

Muse consumes the independent
[`@attunegraph/core`](https://github.com/wlsdks/attunegraph) repository as the
exact `packages/attunegraph` Git submodule, currently pinned to standalone main
commit `4298c13`. Its dependency-free core, in-memory store, portable format,
and package dry-run are verified on Linux, macOS, and Windows. A separate
Ubuntu Node 24.15 clean-room job installs the tarball offline in a fresh project
and exercises every public export plus a real v2 Working Graph.
The opt-in durable local SQLite store and offline Admin currently require Node
24.15 or newer on reviewed Linux/macOS filesystems and fail closed elsewhere;
Muse does not silently replace them with an external graph database.

### Local or cloud — your choice

Supported choices include OpenAI, Anthropic, Gemini, OpenRouter, Ollama, and OpenAI-compatible
endpoints. If you want a local model with no model-provider API key, point Muse at one on your own
machine:

```bash
brew install ollama && ollama serve &
ollama pull gemma4:12b
muse setup local
```

Local-only is a supported posture, not Muse's identity. Turn it on explicitly with
`MUSE_LOCAL_ONLY=true` and remote model and cloud voice paths become hard errors instead of silent
fallbacks. This is a scoped egress policy, not a claim that Muse audits every network path on the
computer.

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

You get a **pack** — the shipped form of what the roadmap below calls the Continuity Capsule: the
stopping point, the changes since, a proposed next step, and the receipts behind each claim. Nothing is guessed — the pack is built only from sources you linked.

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

The same runtime drives a local web console — chat, notes, memory, continuity and the integration
status, on `muse serve`:

<p align="center"><img src="docs/images/web-home.png" alt="The Muse web console" width="840" /></p>

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
gap, not a solved problem — see [the grounding gate](docs/trust/grounding-gate.md).

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
| 🪪 | **Policy Card** | What Muse proposes to learn about working with you — first as an inert, evidence-separated preview; later with trial, edit, reject, and rollback. |

The complete three-part experience is not finished. The next section says exactly how far each
piece got.

---

## Status — what's real today

### Working

| Area | Notes |
| --- | --- |
| Memory, grounded recall with citations, local personal stores | Optional encryption at rest for memory, episodes and the action log |
| Guarded tools and browser actions, traces, checkpoints | Fail-close guards, bounded loops, timeouts |
| Explicit continuity threads | `start → link → muse continue → outcome`, end to end |
| One runtime across CLI, web/API, messaging, scheduled jobs | Same guards, same approvals, same traces |

### Partly built

| Area | Where it actually stands |
| --- | --- |
| [AttuneGraph engine](https://github.com/wlsdks/attunegraph) | Public standalone `@attunegraph/core` source consumed here as a pinned submodule: exact projection, fixed-profile `decision-query@1`, bounded AttuneQL, deterministic evidence-only receipts, *"what changed since I stopped"*, bounded resume compilation, canonical `.atgx`, a worker-isolated SQLite journal, an explicit opt-in Continuity Preview writer, and the offline read-only `muse attunegraph inspect` Lens. Proof-closed authority/conflict evaluation, registry publication, write/repair/live-web Admin, Agent Bridge/MCP, and default automatic ingestion/delivery remain roadmap |
| Continuity Capsule | The explicit Chat/API preparation path now keeps its verified comparison baseline in bounded local personal storage by default, so the first preparation after a Muse restart can compare instead of silently reseeding. Direct library/test construction without that store remains session-only. A compared task/note/reminder result may make one configured-provider call for a display-only draft whose claims cite exact current source keys. Citation membership is verified; exact stop capture, source freshness, authenticated request witness, semantic entailment, all-source support, automatic timing, and usefulness are not |
| Shadow Muse | The ledger records the decision and, after an explicit CLI Pack open, a bounded return association. The Continuity screen can now show that source receipt and whether its exact two-relation AttuneGraph pair is active. It does not record Web returns, surface automatically, or treat return as feedback, usefulness, outcome, causality, permission, or success |
| Policy Card | The authenticated Continuity Review now lets the owner explicitly choose summary density and next-step presentation for one exact organic learning opportunity. Muse runs a fixed ten-case boundary replay, revalidates a fresh local snapshot, and renders the English/Korean AttuneGraph card with experience, replay, graph proof, scope, and authority limits kept separate. The existing `muse.continuity.learning.policy-card.preview` tool reuses the same compiler service. The card is inert: no automatic surfacing, usefulness claim, approval, policy mutation, or action |

The shipped owner-taught path is deliberately narrow:

`explicit owner outcome → owner selects display policy → deterministic boundary replay → fresh AttuneGraph Policy Card`

The controls shown on the card are disabled evidence of the intended boundary, not decorative
buttons that secretly act.

### Roadmap

Automatic Policy Card surfacing and trusted write/undo controls · automatic thread detection · a durable
current-world graph · AttuneGraph Agent Bridge/MCP and registry release · organic-use evidence.

<details>
<summary><b>The fine print on the graph engine (AttuneGraph)</b></summary>

<br/>

The [AttuneGraph](docs/design/attunement/attunegraph.md) is an agent-native temporal/provenance
graph and personal context compiler — not a third-party graph DB. RAG can find *likely* context; AttuneGraph
has to prove the exact thread, time, change, source and policy relation. It runs on an embedded
SQLite store behind an isolated worker, with no external graph server required
([blueprint](docs/design/attunement/agent-native-graph-core.md)).

The first return seam is intentionally narrower than a usefulness claim: after either explicit CLI
`continue` spelling opens a Pack, Muse records a content-addressed timing receipt against the
latest strictly prior eligible Shadow candidate. When the explicit AttuneGraph database is
configured, Muse rebuilds a complete reserved-scope snapshot containing only the factual paths
`Decision → PRECEDED → Delivery` and `Evidence → OBSERVED_DURING → Thread`. The receipt remains
authoritative. The authenticated Continuity screen now reads at most 20 persisted receipts and
shows `linked | not-linked | incomplete | unavailable | not-configured`; only one complete,
untruncated Working Graph containing the exact active pair becomes `linked`. The card is
read-only and describes the interval from the earlier Shadow decision to the explicit CLI Pack
open—not “time saved” or a successful return. Automatic return detection, usefulness validation,
write/repair Admin, and physical journal erasure are still roadmap work.

It is deliberately built as an independently extractable module — Muse is its first consumer and
dogfood environment. The public interface, adapter boundaries and repository-split plan are fixed in
[ADR 0001](docs/architecture/adr/0001-attunegraph-product-module-boundary.md); TypeScript-first with Rust only for
benchmark-proven hot kernels in [ADR 0002](docs/architecture/adr/0002-attunegraph-language-runtime-boundary.md).
The monorepo already enforces that boundary: `@attunegraph/core` contains the dependency-free
engine, persistence, portable format, and conformance surface; `@muse/attunegraph` contains only
Muse's Continuity, Shadow, Capsule, evidence, and lineage integration.

What is verified today, and what those words do **not** mean:

- The neutral lifecycle `openAttuneGraph({ scope, store }) → head/project → execute/query → close`, plus a durable
  projection journal and typed worker boundary. New writes can use `canonical-projection@2`, whose
  canonical bytes name the exact thread root and whose admission rejects any disconnected assertion
  before storage; byte-compatible v1 data remains readable as legacy root-unverified evidence.
  Portable export/rebuild activation, backup, and physical forget remain roadmap work. A
  revision-bound measurement-only 10K/100K/1M harness now exists; clean 100K/1M evidence,
  qualification thresholds, and any 90/100 readiness verdict remain pending.
- `graph.query()` accepts the canonical `decision-query@1` object produced directly or by
  `parseAttuneQL()`. It fixes scope, exact/current head posture, canonical time, fresh-source
  requirement, and token budget while keeping relationship families out of model control. Its
  content-addressed receipt is evidence-only: authority and conflict closure are explicitly
  `not-performed`. Muse's fresh explicit Continuity resume path now cross-binds that exact receipt
  to its stricter receipt-bound witness/settlement layer and allows only Decision Query-witnessed
  current change and support assertions into model context. Caller-declared or unassessed evidence
  does not run the query or invent its required freshness.
- `MUSE_ATTUNEGRAPH_DATABASE=/absolute/path/attunegraph.sqlite` explicitly connects the existing
  provider-revalidated Continuity Pack Preview path to
  `@muse/attunegraph/continuity-durable-projection`. The configured composition revalidates current
  Attunement plus timing ledgers, declares the deterministic exact thread root through v2, writes a
  complete `muse.local-attunement-timing` scope, serializes
  writes, recovers the exact expected head after restart, treats receipt replay as idempotent, and
  records source freshness as `unknown`. An explicit CLI return triggers the same rebuild; failure
  remains separate and non-fatal to the opened Pack and recorded source receipt. The variable has no
  default; an invalid non-empty value fails assembly creation closed.
- The public `@attunegraph/core/admin` Interface and `muse attunegraph inspect` Lens can inspect
  summary, integrity, and one exact scope head from an explicitly attested closed/quiescent store.
  They do not inspect a live writer, repair data, expose raw SQL, or provide the future web Admin.
- `GET /api/attunement/shadow-returns` and the existing Continuity screen form a separate
  Muse-product inspector over the source timing ledger plus bounded Working Graph. They do not
  extend `@attunegraph/core/admin`, inspect physical SQLite state, record returns, mutate the
  graph, or infer that a Pack helped.
- Observation receipts are *caller-declared* integrity evidence. They prove bytes and boundaries —
  not that Muse observed you, and not your exact stopping point.
- Freshness is honest by construction: only exact endpoint equality under a bounded head
  revalidation becomes `fresh-at-assessment`. A single read stays `unassessed` and forces downstream
  abstention rather than a guess.
- Explicit Capsule preparation keeps at most 16 verified resume baselines in
  `~/.muse/continuity-resume-baselines.json` by default. This is bounded local personal data and
  serializes the verified Source receipt needed for exact comparison: artifact/provider IDs;
  thread title/kind; presentation policy/thread metadata; prior outcome; titles/summaries; generic
  `updatedAt`; and task/reminder/calendar/contact/run/checkpoint/browsing/conversation/work
  metadata, including tags, dates/times, locations, contact birthday/relationship, run tool names,
  browsing URL/`visitedAt`, conversation last owner prompt/origin/`updatedAt`, and work
  counters/status. Exact artifact IDs are retained verbatim and may themselves be provider-local
  paths or locator strings; exact serialized source strings are potentially sensitive. The store
  adds no separate whole-source snapshot, prepared Capsule draft, credential field, action
  authority, inferred usefulness, or policy promotion. Direct library/test construction may omit the store
  and remains process-local. A durable comparison baseline is not a durable current-world or
  timing claim, action authority, automatic behaviour, or evidence that the feature is useful in
  real life.
- Pack Preview and Capsule Prepare can update two bounded private, rebuildable stores: the
  comparison baseline and, when `MUSE_ATTUNEGRAPH_DATABASE` is configured, the AttuneGraph
  observation projection attempted before baseline compare-and-set. Both public tool definitions
  therefore declare `write` risk and report the effects separately, including an unknown outcome
  when a failed dependency cannot prove whether it committed. They never mutate a linked source,
  delivery, outcome, or policy. Model-driven API/inbound Chat exposes them only through the
  existing `MUSE_CHAT_WRITE_ENABLED` draft-first approval path; a denied proposal creates neither
  projection nor baseline bytes, and approval executes it once. The explicit local Capsule button
  calls the same service directly—the click is the owner action—so it does not add a second chat
  approval.
- `@muse/attunegraph/policy-card` and
  `muse.continuity.learning.policy-card.preview` compile one inert Policy Card only after a
  process-minted provider head revalidation is still fresh. The card keeps authoritative owner
  experience, structurally validated caller-supplied replay claims, and the locally derived
  AttuneGraph explanation in three visibly separate ledgers. It performs no write or approval;
  replay execution provenance is explicitly unverified, and apply remains a separate stale-safe
  approval flow.

Sequenced in the [wow + graph roadmap](internal/goals/attunegraph-roadmap.md).

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

- They are controlled results, not proof the agent helps in real life. The agent battery is not
  fully green today, and recall correction is not yet qualified — the per-battery record, including
  the failures, is in the [evidence index](docs/benchmarks/EVIDENCE.md).
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
| 👤 | **Pretend to be a workspace.** One user and one private control plane — no multi-tenancy, no RBAC. |
| 📊 | **Promote evidence.** Tests, synthetic replays, diagnostics, agent trials and real outcomes stay separate ledgers. |

Enforced as deterministic code, never as a prompt instruction:
[outbound safety](.claude/rules/safety/outbound-safety.md) · [Attunement design](docs/design/attunement/README.md).

---

## Architecture in one paragraph

`agent-core` never talks to a vendor SDK — everything goes through one `ModelProvider` interface, so
swapping models does not touch agent logic. Adapters ship for OpenAI, Anthropic, Gemini, OpenRouter,
Ollama and supported OpenAI-compatible endpoints (LM Studio is that adapter with a local
`baseUrl`, not a dedicated one); missing capabilities degrade explicitly rather than silently. Your data stays in plain files under `~/.muse/` — plaintext by default, with memory, episodes and
the action log encryptable at rest on request ([what is and is not
covered](docs/trust/privacy-and-data.md)) and credentials in the OS keychain. CLI, web/API chat, messaging channels,
scheduled jobs and delegated workers all share one composition root, so guards, approvals and traces
are identical on every surface; risky local execution goes through the Rust `runner` as a child
process. MCP works both directions — external servers behind an allowlist, and `muse mcp serve`
exposing read-only grounded recall to other agents.

**Full detail:** [architecture and repository layout](docs/architecture/README.md) — the provider contract,
where every file lives on disk, the one-runtime rule, and a map of the 39 workspace packages.

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
`eval:agent` is the nightly/manual battery and is not fully green today; its current per-battery
record lives in the [evidence index](docs/benchmarks/EVIDENCE.md). `pnpm qualify:personal-agent` is a
read-only, fail-closed check of current capability, resident runtime and delivery safety. Test counts
are not proof of agent effect.

---

## Documentation

| | |
| --- | --- |
| **Start here** | [Documentation index](docs/README.md) — the guided reading order · [System map](docs/product/SYSTEM-MAP.md) · [Local model setup](docs/setup/setup-local-llm.md) · [Environment variables](docs/setup/ENV.md) |
| **The product** | [Attunement contract](docs/strategy/attunement.md) · [Architecture and gaps](docs/design/attunement/README.md) · [Implementation plan](internal/goals/attunement-implementation-plan.md) |
| **The graph** | [AttuneGraph](docs/design/attunement/attunegraph.md) · [Agent-native core blueprint](docs/design/attunement/agent-native-graph-core.md) · [Roadmap](internal/goals/attunegraph-roadmap.md) |
| **Trust** | [Grounding gate](docs/trust/grounding-gate.md) · [Privacy and data](docs/trust/privacy-and-data.md) · [Evidence index](docs/benchmarks/EVIDENCE.md) · [Security](SECURITY.md) |
| **Audits** | [Personal-agent qualification](docs/development/personal-agent-qualification.md) — a read-only, fail-closed check of current capability |

## Contributing

Questions, bugs and ideas go to [GitHub Issues](https://github.com/wlsdks/muse-agent/issues);
vulnerabilities go through [SECURITY.md](SECURITY.md), not a public issue. Before changing the
repository, read [CONTRIBUTING.md](CONTRIBUTING.md), [CLAUDE.md](CLAUDE.md) and the
[domain rules](.claude/rules/). Conventional Commits, English commit messages.

[MIT](LICENSE) — runtime, adapters and tooling.
