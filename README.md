<p align="center">
  <img src="docs/assets/mascot.svg" alt="Muse — the bluebird mascot" width="120" />
</p>

<p align="center"><i>Meet Muse — a personal AI project built to understand the life you are already living.</i></p>

<h1 align="center">Muse</h1>

<p align="center">
  <b>A personal AI that learns how you live and work—and gets better at knowing when and how to help.</b><br/>
  <i>Local-first, provider-neutral, and honest about what is not built yet.</i>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg" /></a>
  <a href="package.json"><img alt="Node ≥ 22.12" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-43853d.svg" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg" /></a>
  <a href="#what-muse-will-not-do-boundaries"><img alt="Local-first" src="https://img.shields.io/badge/privacy-local--first-6f42c1.svg" /></a>
  <a href="https://ollama.com"><img alt="Runs on Ollama" src="https://img.shields.io/badge/runs%20on-Ollama-000000.svg" /></a>
  &nbsp;·&nbsp; <b>English</b>
  &nbsp;·&nbsp; <a href="README.ko.md">한국어</a>
  &nbsp;·&nbsp; <a href="README.ja.md">日本語</a>
  &nbsp;·&nbsp; <a href="README.zh-CN.md">简体中文</a>
</p>

Muse is a continuing personal agent for one person's life and work, not only a work assistant. Its north star is **Attunement**: learning when help fits, when quiet is better, and whether the last suggestion actually helped.

The first proof point is **Personal Continuity**. You choose a life or work thread and link its exact local tasks and notes; Muse can then help you resume it without reconstructing everything. Automatic thread detection, observation, and timing remain roadmap work.

> **What works today:** personal memory, grounded recall, local personal stores, guarded tools and browser actions, traces, checkpoints, and the first explicit Personal Continuity path. See the [product contract](docs/strategy/attunement.md) and [implementation plan](docs/goals/attunement-implementation-plan.md).

## The Muse moment we are building

You stopped while comparing three places to stay. Since then, the flight changed, one
cancellation deadline moved close, and an 18-minute gap opened in your day. Muse prepares
only the changes, explains why now, cites every source, shows exactly how far an action
would go, and asks whether to hold one option.

If you answer “this evening instead,” Muse proposes a visible rule scoped to that trip—not
a hidden global preference. That experience has three parts:

- **Shadow Muse** learns when to help or stay quiet before it interrupts.
- **Continuity Capsule** restores the stopping point, changes, evidence, next step,
  prepared work, and expected time.
- **Policy Card** shows what Muse proposes to learn about collaborating with you, with
  evidence and trial/edit/reject/rollback controls.

> **Muse does not remember apps; it remembers the state you intended to continue.**

The full signature experience remains a roadmap, not a shipped claim. Its first
library-level substrates now live in the partially implemented, lightweight
[Attunement Graph Engine](docs/design/attunement-graph.md): an agent-native
temporal/provenance graph and personal context compiler, not merely a third-party graph DB.
Its intended advantage is a small set of bounded, verified personal-temporal operators:
the model asks what changed, what evidence supports a policy, or what forgetting would
invalidate; Muse computes the exact path, completeness, and authority boundary in code.
The [Agent-Native Graph Core blueprint](docs/design/agent-native-graph-core.md) defines the
proposed next architecture: scope-safe snapshots, proof-closed Working Graphs, typed
completeness, an immutable logical journal, and a lightweight local storage Adapter with no
external Graph DB requirement.
The first `changesSince`-style operator is shipped as an I/O-free library contract. A
separate process-local runtime now also applies the verified Graph path to explicit
`muse.continuity.pack.preview` calls: the first qualifying call seeds one exact per-thread
baseline and later calls return a bounded semantic `resume` comparison while keeping Pack
open/delivery separate. A caller may also explicitly request the verified English/Korean
Continuity Capsule render-data presentation on that same preview; copied or unrelated
Pack/result pairs fail closed to a bounded unavailable response. This is an API/tool
presentation, not a Capsule UI, automatic timing, durable graph, or action authority.
Muse can now also seal one exact caller-declared projected observation as a bounded,
content-addressed **Observation Receipt** without copying its personal source text. This
preserves the previous observation's recorded next step; it does not prove the user's exact
stopping point.
The same library subpath can purely capture one caller-supplied raw Continuity snapshot
through the shared projector and return that receipt without source I/O or persistence.
The existing state-to-state query now delegates to one reusable internal prepared-observation
comparison core. The observation subpath can also verify that receipt, derive its exact
boundary, project one caller-supplied current snapshot, and return the same explained-change
result as the raw state-to-state query.
That receipt remains caller-declared integrity evidence—not proof of an external
observation, automatic stop-point detection, or persistence. The runtime uses verified
Source/Graph pairs without exposing their raw receipts in the ordinary Pack Preview
response.
Muse now also has a bounded trusted-host Provider that reads one configured local
Attunement file and mints a process-local, content-addressed snapshot capture. Its
serializable receipt proves integrity only; exact Provider provenance belongs to the
in-process capture, freshness remains `unassessed`, and missing data never becomes an
absence claim. This closes the first real-source boundary for the Agent Graph without
making the graph read files or depend on an external Graph DB.
The private Agent Graph seam can now verify that exact process-local mint before reading
state, independently recompute its bytes and digest, project it into a verified Continuity
Observation Receipt, and compile receipt-bound graph evidence with truthful Provider
snapshot provenance. It never fabricates a graph commit or generation: a single read is
explicitly `unassessed`, which forces downstream settlement to abstain while still
preserving exact evidence links and bounded nomination accounting. This is process-local
engine substrate. The later bounded-head path, rather than this single-read seam, now feeds
the explicit Pack Preview runtime; neither path is a durable graph, continuous/current
freshness proof, action authority, or automatic user-visible behavior.
Muse now also has an independently verified, Provider-owned **bounded head
revalidation** seam. The same configured Provider instance captures the subject and then
its head under an explicit span bound; only exact endpoint equality can become
`fresh-at-assessment` Graph evidence. Per-Provider process ownership, two-phase
mint-before-hidden-state verification, five scope guards, and a closed binding-receipt
parser prevent cross-owner, cross-scope, forged-authority, and forged-seed reuse. This is
still private process-local substrate: it does not prove uninterrupted or current
freshness, add persistence, or ship the Capsule/Shadow/Policy experience.
The thread-rooted compiler retains its complete bounded pre-settlement witness pool behind
the exact in-process compilation object. The verified resume compiler and runtime now
consume that pool under a fixed six-axis budget, verify an exact previous boundary plus
current Source/Graph pair, and expose only frozen semantic facts. Runtime baselines are
per-instance, process-local, limited to 16 threads, and guarded by bounded concurrency,
capture span, timeout, generation, and monotonic-observation checks. This is real
Graph-backed Pack Preview dogfooding. An optional explicit request now turns only the exact
compared result into a verified bilingual Capsule presentation with source-drawer receipt
IDs and caller-declared prepared work. It is not persistence, an exact observed stopping
point, automatic surfacing, organic usefulness evidence, or the Capsule product UI.
See the separate [wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md).

<p align="center"><img src="docs/images/web-home.png" alt="Muse console home — model chip, integrations, and what Muse has learned" width="860" /></p>

---

## 📊 Muse in numbers

The README publishes two qualified controlled results. Failed, unchanged, and diagnostic evidence remains visible in the [evidence index](docs/benchmarks/EVIDENCE.md), not promoted into charts here.

### Qualified grounding

**Example:** for the same fictional appointment question, grounding should cite the linked note instead of answering from an unsupported assumption. Two independent controlled checks measured faithfulness: self-authored cases were **16/17 ON vs 0/17 OFF** (**+0.94**), and squad cases were **5/8 ON vs 0/8 OFF** (**+0.63**). False-refusal cost was unchanged in both checks: **0/12 vs 0/12** and **0/8 vs 0/8**, each **+0.00**. The checks have different denominators and are not an aggregate.

![Two independent qualified grounding checks with raw faithfulness counts and false-refusal cost](docs/benchmarks/readme-qualified-grounding-v1.svg)

Source: [closed README evidence manifest](docs/benchmarks/readme-qualified-evidence-v1.json) · [full evidence index](docs/benchmarks/EVIDENCE.md)

### Controlled synthetic integrity at scale

**Example:** fictional correction records test whether a current appointment can remain distinguishable from an older time without touching personal data. Four independent corpora—**1K / 10K / 100K / 1M**—produced a full-corpus total of **1,111,000/1,111,000** generated, serialized, and parsed + schema-validated records. A separate stratified runtime sample passed **768/768** named public Muse seams across **96** cells, with **0 / 0 / 0** LLM, tool, and network calls; owner state remained **byte-stable**.

![Full-corpus controlled synthetic integrity totals separated from the 768-case runtime sample](docs/benchmarks/readme-controlled-scale-v1.svg)

Source: [canonical scale JSON](docs/benchmarks/eval-datasets-scale-v1.json) · [closed README evidence manifest](docs/benchmarks/readme-qualified-evidence-v1.json) · [full evidence index](docs/benchmarks/EVIDENCE.md)

Boundaries: the agent aggregate is **10/11 FAILED**; organic effectiveness is **NOT_PROVEN**; recall correction remains **UNQUALIFIED**. Controlled synthetic integrity is not personal learning. Controlled evidence is not organic effectiveness. **1,111,000 records are not 1,111,000 agent runs.**

---

## ⚡ Install and quick start

```bash
# Requirements: Git + Node.js >= 22.12 (24 LTS recommended) + pnpm 10
git clone https://github.com/wlsdks/muse-agent.git
cd muse-agent
corepack enable
pnpm install:muse
muse onboard
```

The supported source install uses a clean `main`, performs a frozen dependency install, builds the workspace, links the CLI, and verifies it. Preview with `pnpm install:muse -- --dry-run`, update with `muse update`, or run the narrated local demo with `pnpm demo`.

Start an explicit continuity thread:

```bash
muse thread start "Plan a birthday" --kind life
muse thread link <thread-id> note birthday.md --role context
muse thread link <thread-id> task <task-id> --role next-step
muse continue <thread-id>
muse thread outcome <delivery-id> used
```

Other useful local flows:

```bash
muse chat --local --user me
muse status --user me
muse proactive watch --user me --interval 60
```

`muse ask` returns grounded answers with cited, openable receipts:

<p align="center"><img src="docs/images/cli-ask.png" alt="muse ask — grounded, cited answer with an openable receipt" width="860" /></p>

---

## 🔧 Core capabilities

- **Provider-neutral reasoning:** one `ModelProvider` boundary for OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, and OpenAI-compatible endpoints.
- **Personal continuity and memory:** explicit life/work threads, exact local source links, outcomes, facts, preferences, vetoes, and goals.
- **Grounded recall:** ranked local notes retrieval, confidence gating, freshness handling, citations, and no confident answer on weak evidence.
- **Personal tools:** local notes, tasks, reminders, contacts, and five calendar backends behind provider-neutral interfaces.
- **Guarded action:** fail-close guards, fail-open hooks, explicit approvals, untrusted tool-output handling, bounded loops, timeouts, and traces.
- **One runtime:** CLI, API/web chat, messaging, scheduled jobs, and delegated workers share the same composition root.
- **MCP both ways:** built-in local `muse.*` tools plus `muse mcp serve` for read-only grounded recall, search, and user-model access from other agents.
- **Local-first operation:** file-backed personal stores work without a cloud account; strict `MUSE_LOCAL_ONLY=true` refuses cloud model providers.

## What Muse will not do (boundaries)

- **No money movement.** Muse does not connect to financial accounts, initiate payments, or move money.
- **No autonomous third-party sends.** Email, chat, forms, and bookings are draft-first; you confirm exact content and recipient before anything leaves.
- **No hidden continuity guessing.** Current continuity threads and source links are user-authored. Automatic detection is later, opt-in work.
- **Single user, single environment.** Muse is not a multi-tenant workspace and has no shared-account or RBAC model.
- **No evidence promotion.** Software tests, synthetic replays, component diagnostics, agent trials, and organic outcomes stay separate.

See [outbound safety](.claude/rules/outbound-safety.md) and the [Attunement design](docs/design/attunement.md) for the enforced boundary.

---

## 🧩 Providers and local path

Select a provider with `MUSE_MODEL=<provider>/<model>` and its normal API-key environment variable. `MUSE_MODEL_PROVIDER_ID`, `MUSE_MODEL_API_KEY`, and `MUSE_MODEL_BASE_URL` provide explicit overrides. Cloud providers are incompatible with `MUSE_LOCAL_ONLY=true`.

Free, offline path with Ollama:

```bash
brew install ollama
ollama serve &
ollama pull gemma4:12b
muse setup local
```

Personal data stays file-backed by default: notes in `~/.muse/notes/`, tasks in `~/.muse/tasks.json`, reminders in `~/.muse/reminders.json`, and memory in `~/.muse/user-memory.json`. Run `muse setup calendar` for Local, Local-ICS, Google, CalDAV, or macOS Calendar. Windows supports the CLI, API, recall, Ollama, and opt-in PowerShell actuators; macOS-only mirrors disable automatically.

See [local model setup](docs/setup-local-llm.md) for model tiers, licenses, latency, and troubleshooting.

## ✅ Verification

Use the narrow gate while editing and the full gate before merge:

```bash
pnpm typecheck:fast
pnpm test:changed
pnpm check
pnpm smoke:broad
pnpm smoke:live
```

`smoke:live` deliberately uses local Ollama and skips when it is unreachable. The longer `pnpm eval:agent` suite is nightly/manual. The latest recorded live aggregate is **10 passed, 1 failed, 0 unverified**, so it remains **FAILED**. Run `pnpm qualify:personal-agent` for a read-only, fail-closed check of current capability, resident runtime, and delivery safety. Software test counts are not agent-effect proof.

## 📖 Documentation

- [Attunement product contract](docs/strategy/attunement.md)
- [Attunement architecture and current gaps](docs/design/attunement.md)
- [Attunement Graph Engine](docs/design/attunement-graph.md)
- [Agent-Native Graph Core blueprint](docs/design/agent-native-graph-core.md)
- [Attunement implementation plan](docs/goals/attunement-implementation-plan.md)
- [Attunement wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md)
- [Personal-agent qualification](docs/development/personal-agent-qualification.md)
- [System map](docs/SYSTEM-MAP.md)
- [Verified feature catalog](docs/feature-catalog/INDEX.md)
- [Evidence index](docs/benchmarks/EVIDENCE.md)
- [Security posture](SECURITY.md)
- [한국어 README](README.ko.md) · [日本語 README](README.ja.md) · [简体中文 README](README.zh-CN.md)

## 💬 Community and support

Use [GitHub Issues](https://github.com/wlsdks/Muse/issues) for questions, bugs, and feature ideas. Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CLAUDE.md](CLAUDE.md), and the [domain rules](.claude/rules/) before changing the repository. Use Conventional Commits and write commits and PR descriptions in English.

## License

[MIT](LICENSE). The runtime, adapters, and tooling are open source; contributions are accepted under the same terms.
