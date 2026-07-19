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
  &nbsp;·&nbsp; <a href="README.ko.md">한국어</a>
</p>

Muse is a continuing personal agent for one person's life and work, not only a work assistant. Its north star is **Attunement**: learning when help fits, when quiet is better, and whether the last suggestion actually helped.

The first proof point is **Personal Continuity**. You choose a life or work thread and link its exact local tasks and notes; Muse can then help you resume it without reconstructing everything. Automatic thread detection, observation, and timing remain roadmap work.

> **What works today:** personal memory, grounded recall, local personal stores, guarded tools and browser actions, traces, checkpoints, and the first explicit Personal Continuity path. See the [product contract](docs/strategy/attunement.md) and [implementation plan](docs/goals/attunement-implementation-plan.md).

<p align="center"><img src="docs/images/web-home.png" alt="Muse console home — model chip, integrations, and what Muse has learned" width="860" /></p>

---

## 📊 Muse in numbers

Every retained chart answers a different question. Test counts are **not agent-effect proof**; controlled synthetic evidence is not organic evidence. The live agent baseline is 10/11 and its aggregate remains **FAILED**. Organic personal effectiveness is **NOT_PROVEN**.

### Component effect deltas

**What:** isolated changes when a component is enabled. **How to read:** positive means better, but each row has a different outcome and its own scale. **Current:** grounding changed by +0.94 and +0.63 in two controlled local-model corpora; recall correction changed by +0.00. **Limit:** these rows are neither comparable nor aggregatable, and they do not establish whole-agent or organic impact.

![Component effect deltas in three full-width independent rows](docs/benchmarks/evidence-effect-deltas.svg)

Source: [canonical dashboard JSON](docs/benchmarks/evidence-dashboard.json) · reproduce with `pnpm evidence:dashboard:render` · validate with `pnpm evidence:dashboard:validate`.

### Evidence coverage

**What:** the amount of evidence available inside four separate evidence classes. **How to read:** each bar is numerator over its own denominator; bar lengths across rows must not be compared. **Current:** the agent baseline is 10/11, raw top-4 retained both correction sources in 8/80 model-cases, controlled provenance isolation is 10,080/10,080, and organic classification is 0/1,000. **Limit:** coverage and implementation assurance are not effectiveness.

![Evidence coverage ratios with independent denominators](docs/benchmarks/evidence-coverage.svg)

Source: [canonical dashboard JSON](docs/benchmarks/evidence-dashboard.json) · reproduce with `pnpm evidence:dashboard:render` · validate with `pnpm evidence:dashboard:validate`.

### Production recall

**What:** recall exercised through the production `prepareGroundedRecall` seam. **How to read:** each colored bar is a pass count out of 20 within one model. **Current:** ordinary and absent cases largely pass, but correction pair retention is 0/20, 0/20, 1/20, and 1/20; current top-1 is 0/20 for all four models. **Limit:** frozen synthetic v1 is not held-out or organic evidence, repeats are collapsed, and zero generative requests were made.

![Recall results through the production prepareGroundedRecall seam](docs/benchmarks/recall-production-path.svg)

Source: [canonical production-path JSON](docs/benchmarks/recall-production-path.json) · reproduce with `pnpm eval:recall-production-path` · validate with `pnpm eval:recall-production-path:validate`.

<details>
<summary><b>Detailed diagnostics</b></summary>

### Freshness ablation

**What:** raw retrieval versus Muse freshness reordering on the same top-4 candidates. **How to read:** paired bars show within-category pass counts for each model. **Current:** **UNCHANGED** across all four models, each with delta 0; 72/80 correction observations were `PAIR_MISSING`. **Limit:** this is a local-live retrieval component over synthetic cases, not an agent evaluation; reordering cannot restore candidates retrieval already removed.

![Recall freshness ablation across four local embedding models](docs/benchmarks/recall-freshness-ablation.svg)

Source: [canonical freshness JSON](docs/benchmarks/recall-freshness-ablation.json) · reproduce with `pnpm eval:recall-freshness-ablation` · validate with `pnpm eval:recall-freshness-ablation:validate`.

### Candidate-pool diagnostic

**What:** whether increasing topK from 4 to 8 or 12 retains more correction pairs. **How to read:** a correction pass requires the pair to be retained and the current source to rank top-1. **Current:** retention generally rises with topK, while raw and Muse correction-pass counts remain equal. **Limit:** this isolates a retrieval component, collapses repeat trials, and makes no whole-agent or organic claim.

![Candidate-pool pair retention and correction pass at top K four, eight, and twelve](docs/benchmarks/recall-candidate-pool.svg)

Source: [canonical candidate-pool JSON](docs/benchmarks/recall-candidate-pool.json) · reproduce with `pnpm eval:recall-candidate-pool` · validate with `pnpm eval:recall-candidate-pool:validate`.

### Project surface

**What:** inventory, software-assurance snapshots, and live-command availability. **How to read:** every card has its own unit; `NOT_RUN` is a status, not a score. **Current:** the chart records endpoints, packages and apps, MCP servers, provider families, a historical passing-test snapshot, and the available live command. **Limit:** size and test volume do not demonstrate agent effect.

![Project inventory, assurance snapshots, and live-command status](docs/benchmarks/evidence-project-surface.svg)

Source: [canonical dashboard JSON](docs/benchmarks/evidence-dashboard.json) · reproduce with `pnpm evidence:dashboard:render` · validate with `pnpm evidence:dashboard:validate`.

</details>

Full evidence classes, source selectors, and non-promotion rules live in the [evidence index](docs/benchmarks/EVIDENCE.md). Canonical JSON is the only metric truth; CSV, Markdown, and SVG are derived and validated byte-for-byte.

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

`smoke:live` deliberately uses local Ollama and skips when it is unreachable. The longer `pnpm eval:agent` suite is nightly/manual. The latest qualified agent result is **10 passed, 1 failed, 0 unverified**; the aggregate remains **FAILED**. Software test counts are not agent-effect proof.

## 📖 Documentation

- [Attunement product contract](docs/strategy/attunement.md)
- [Attunement architecture and current gaps](docs/design/attunement.md)
- [Attunement implementation plan](docs/goals/attunement-implementation-plan.md)
- [System map](docs/SYSTEM-MAP.md)
- [Verified feature catalog](docs/feature-catalog/INDEX.md)
- [Evidence index](docs/benchmarks/EVIDENCE.md)
- [Security posture](SECURITY.md)
- [Korean overview](README.ko.md)

## 💬 Community and support

Use [GitHub Issues](https://github.com/wlsdks/Muse/issues) for questions, bugs, and feature ideas. Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CLAUDE.md](CLAUDE.md), and the [domain rules](.claude/rules/) before changing the repository. Use Conventional Commits and write commits and PR descriptions in English.

## License

[MIT](LICENSE). The runtime, adapters, and tooling are open source; contributions are accepted under the same terms.
