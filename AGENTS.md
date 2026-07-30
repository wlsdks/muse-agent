# Muse

A provider-neutral personal AI conductor for **one user, one private control plane, no shared
workspace**. One coherent reasoning loop across local, self-hosted, and cloud deployment choices;
provider-specific code stays at the edges. Local-only is an explicit fail-close privacy posture,
not the product identity.

This file is the cross-agent product brief (the open `AGENTS.md` standard). It does not duplicate
the Claude-specific contract in [`CLAUDE.md`](CLAUDE.md) or the domain rules in
[`.claude/rules/`](.claude/rules/) — read those alongside it.

## Mission and roadmap honesty

`Attunement` is the product north star: personal thread → Continuity Pack → outcome → adaptation.
The signature roadmap is **Shadow Muse → Continuity Capsule → Policy Card** — learn when to stay
quiet, restore the state the user intended to continue, make every proposed collaboration policy
visible and reversible. Optional Observe can later improve timing through rhythm and friction
evidence.

- **The full loop is a roadmap, not a shipped claim.** Current memory, pattern, proactivity,
  browser, trace and checkpoint systems are its substrates. Product contract:
  [`docs/strategy/attunement.md`](docs/strategy/attunement.md). Implementation:
  [`internal/goals/attunement-implementation-plan.md`](internal/goals/attunement-implementation-plan.md).
- **`@muse/attunement-graph` is a lightweight agent-native temporal/provenance graph** and personal
  context compiler — not a generic graph-DB claim. Existing personal stores remain authoritative;
  the graph is a rebuildable projection. Contract:
  [`docs/design/attunement-graph.md`](docs/design/attunement-graph.md). Program:
  [`internal/goals/attunement-wow-graph-roadmap.md`](internal/goals/attunement-wow-graph-roadmap.md).

Runtime invariants, always:

- Guard is fail-close. Hook is fail-open.
- Tool output is untrusted; tool loops have explicit limits and timeouts.
- Message-pair integrity is preserved. Trace every meaningful step.
- Model adapters may differ; `agent-core` stays provider-neutral.

## Stack

| Area | Choice |
| --- | --- |
| Language | TypeScript 7 native compiler; TypeScript 6 API compatibility alias for tooling |
| Runtime | Node.js >= 22.12 (24 LTS recommended) |
| Package manager | pnpm workspace |
| Server | Fastify |
| Database | PostgreSQL via Kysely (optional — runs in-memory by default) |
| Web UI | React + Vite + TanStack Query |
| CLI | commander + Ink TUI + clack-prompts wizards |
| Local runner | Rust separate process (`crates/runner`) |
| Model layer | `packages/model` ModelProvider adapters |
| Provider adapters | OpenAI (Responses API), Anthropic, Gemini, OpenRouter, Ollama + OpenAI-compat presets (Groq, DeepSeek, Together, Mistral, Moonshot, Cerebras). "LM Studio" = the OpenAI-compatible adapter pointed at a local `baseUrl` (no dedicated class/preset). |
| Calendar adapters | Local file, Google Calendar, CalDAV (iCloud / Fastmail / Proton), macOS Calendar.app |
| Observability | OpenTelemetry + pino + persisted trace events |
| Tests | Vitest 4.1 + Browser Mode/Playwright + opt-in fast-check + Testcontainers |

## Repository layout

Five apps, 39 workspace packages, one Rust crate. The packages worth knowing by name:

| Package | Owns |
| --- | --- |
| `agent-core` | Guard, Hook, ReAct + Plan-Execute loops, message integrity, context transforms |
| `model` | The `ModelProvider` interface and every provider wire adapter — the only place a vendor SDK may appear |
| `attunement` · `attunement-graph` | Continuity threads, exact source links, delivery/outcome receipts · the storage-neutral temporal/provenance graph kernel and Activation Subgraph compiler |
| `recall` · `memory` · `stores` | Grounded recall, conversation state and checkpoints, file-backed personal stores |
| `tools` · `mcp` · `mcp-shared` · `browser` | Tool registry and built-ins, MCP transport plus loopback servers, real-Chrome control |
| `policy` · `secrets` · `auth` | Approval, permissions, guardrails, credential handling |
| `calendar` | `CalendarProvider` plus Local / Local-ICS / Google / CalDAV / macOS adapters and a chmod-600 credential store |
| `proactivity` · `scheduler` · `messaging` · `voice` | Speaking first, cron and locks, channels, STT/TTS |
| `multi-agent` · `a2a` · `agent-specs` · `skills` | Supervisor and orchestrator, peer protocol, agent definitions, learned skills |
| `observability` · `runtime-state` · `resilience` · `db` | Spans and metrics, run history and traces, retry policy, Kysely queries and migrations |

```
apps/     api (Fastify) · cli (commander + Ink) · web (React + Vite) · desktop (macOS) · mac-helper
crates/   runner — Rust sandbox for shell/process/file execution
docs/     strategy · design · goals · development · benchmarks · feature-catalog
harness/  the portable agent operating harness
.claude/  rules (auto-loaded with CLAUDE.md) · agents · skills
```

`ls packages` is the authoritative list; this table is a map, not an inventory.

## Testing contract

Muse picks a test technique by the failure it must detect, never by a target test count:

| Failure to catch | Technique |
| --- | --- |
| An exact contract breaking | deterministic example tests |
| A high-risk invariant breaking | property tests (fast-check, opt-in) |
| React interaction, focus, keyboard | real Chromium (Browser Mode) |
| PostgreSQL query behaviour | Testcontainers |
| A critical end-to-end journey | Playwright |

Keep the edit loop narrow with `pnpm test:changed`; run the full cross-platform gate before merge.
Operational rules: [`.claude/rules/testing.md`](.claude/rules/testing.md). Stack decision and
rationale: [`docs/development/testing-strategy.md`](docs/development/testing-strategy.md).

**Agent behaviour is graded separately, outcome-first**: isolated trials, deterministic
terminal-state graders, trace invariants only where ordering is a real contract, strict `pass^k`,
adversarial and fault tests, and local trace review. See
[`docs/development/ai-agent-testing-strategy.md`](docs/development/ai-agent-testing-strategy.md).

## Repository publication

The owner grants **standing authorization for a verified normal Git push** from the current Muse
task branch (or verified local `main`) to its configured `origin` upstream: after the applicable
risk-tier completion gate and required checks pass, fetch, rebase, run the unskipped versioned
pre-push hook, and publish without asking again.

- **Not authorized**: alternate remotes/refspecs, remote deletion, tags/releases,
  force/force-with-lease, `--no-verify`, credentials, branch-protection changes.
- On hook, auth, protection, or unresolved divergence failure: at most one safe fetch/rebase retry,
  then stop and report.
- Autonomous scheduled loops keep their own push tiers; third-party human/action sends remain
  draft-first under [`.claude/rules/outbound-safety.md`](.claude/rules/outbound-safety.md).

**Commit boundary = product-behavior change**, not every roadmap checkbox. A completed slice that
changes runtime/source code, tests, executable scripts, build/package configuration,
schemas/migrations, UI contracts, or enforced security policy runs its required checks and
risk-tier gate, then commits and pushes. Documentation-, evidence-, ledger-, and status-only
updates batch at the next phase exit, related source commit, branch/worktree transition,
long-session handoff, or release-readiness checkpoint. Mixed slices follow the source-change rule
and must not absorb unrelated accumulated records.

## Working a roadmap

Task IDs are stable references, not instructions to implement every checkbox in numeric order. The
roadmap's own execution-order table and scope-specific gates outrank raw task numbering.

- **Classify before you build.** Inspect current source (CodeGraph first) and mark the task
  `missing`, `partial`, `built-unverified`, `verified-current`, `monitoring`, `blocked`,
  `deferred`, `rejected` or `superseded`. Reuse and verify what exists; code only the missing delta.
- **No duplicate contracts.** A later task repeating an earlier acceptance contract must name a
  distinct domain or recurring-operation delta, or be marked superseded and left undone.
- **One at a time.** At most one source-changing BUILD slice plus one non-mutating
  EVIDENCE/MONITOR activity. Elapsed-time organic evidence must never block unrelated safety,
  reliability or repair work.
- **Deliver the asked scope.** Make routine judgment calls yourself; check in only when different
  readings lead to materially different work. If a task seems mistaken, say so briefly and continue
  as specified — never silently narrow, widen or transform it.

### Model routing for [`personal-agent-productization-roadmap.md`](internal/goals/personal-agent-productization-roadmap.md)

Do not hand that unsliced 300-task program to one default worker configuration. The roadmap's own
model-routing section is authoritative for fallbacks, escalation and stage-specific defaults.

| Model | Role |
| --- | --- |
| `gpt-5.6-sol`, `high` | Program controller, planner and independent gate evaluator. Complex refactors, architecture, security, permissions, credentials, persistence migrations, external effects, process/concurrency control, self-modification and release decisions all start here — `xhigh` for the hardest security/release evaluations. |
| `gpt-5.6-terra`, `high` | Default everyday implementation worker, but only once a task is activated with a clear missing delta, bounded S/M scope, deterministic acceptance and no high-risk boundary. |
| `gpt-5.6-luna` | Clear, repeatable, low-risk record or transformation work only. No required roadmap step may depend on Luna being available. |

Claude-model effort and delegation calibration (Opus 5 / Fable 5) lives in
[`CLAUDE.md`](CLAUDE.md). Every task activation header records the maker model, reasoning effort,
selection reason, risk tier and escalation trigger; FULL also records evaluator model/effort, FAST
records evaluator `n/a — thin-review`. Maker/evaluator separation in FULL needs a fresh agent
context and role — changing only the model name is not independent evaluation.

## Agent operating harness

For non-trivial multi-step work, operate under the portable harness in [`harness/`](harness/):
entrypoint [`harness/AGENTS.md`](harness/AGENTS.md), risk tiers included. Qualifying FAST S/M uses
its compact card and `thin-review`; FULL uses planner / worker / evaluator with maker ≠ judge and
the handoff template. Both use the fail-closed plan / completion / permission gates and golden-set +
`pass^k` verification. The folder is self-contained — copy it into another project and point that
project's `AGENTS.md`/`CLAUDE.md` at it ([`harness/INSTALL.md`](harness/INSTALL.md)). Muse-runtime
mapping: [`harness/host/muse-mapping.md`](harness/host/muse-mapping.md).

## TypeScript 7 toolchain

Muse compiles its project graph with the TypeScript 7 native compiler. The `typescript` package
name remains an alias to Microsoft's `@typescript/typescript6` compatibility package for tooling
that consumes the TypeScript compiler API (notably typescript-eslint) until that tooling supports
the stable TS7 API. Do not replace that alias with TS7 or use `tsc6` for normal builds without an
explicit compatibility review.

Use `pnpm typecheck:fast` for the normal TS7 graph check and `pnpm typecheck:ts7-fast` only when
measuring parallel TS7 checkers/builders. Keep project references aligned with workspace runtime
dependencies, preserve real type predicates at `unknown`/JSON boundaries, and do not suppress
diagnostics through `ignoreDeprecations`. Migration procedure:
[`docs/development/typescript-7.md`](docs/development/typescript-7.md).

## Personal-domain primitives

The agent ships file-backed personal loopback MCP servers (notes, tasks, calendar, reminders,
episode, followup, status, history, …), all local by default. Contacts are a first-class personal
store + CLI (`muse contacts`) surfaced via a tool, not a `muse.contacts` server namespace.

- `muse.notes.*` → `~/.muse/notes/` markdown directory (drop-in compatible with an Obsidian vault).
- `muse.tasks.*` → `~/.muse/tasks.json` todo list.
- `muse.reminders.*` → `~/.muse/reminders.json` store.
- `muse.calendar.*` → provider-neutral, **five backends** (Local, Local-ICS, Google, CalDAV, macOS)
  behind one registry; `muse setup calendar` walks the user through OAuth / app-password setup.

User-memory auto-extraction (`MUSE_USER_MEMORY_AUTO_EXTRACT=true`, default `true`) runs an extra
structured-output LLM call after each turn to persist newly stated facts / preferences into the
`UserMemoryStore`. Personal memory is a required Attunement substrate, so the per-turn cost is on
by default; set `false` only for offline runs, cheap-model budgets, or disabled-memory test rigs.

Continuity factual interaction receipts are intentionally separate from
`used|adjusted|ignored|rejected`: an exact linked local task transition may corroborate progress,
but it never becomes feedback, permission, or promotion. Test this distinction through the public
Attunement Interfaces; details in
[`docs/development/ai-agent-testing-strategy.md`](docs/development/ai-agent-testing-strategy.md).

## Where to look next

- [`CLAUDE.md`](CLAUDE.md) — the Claude Code contract: trust floor, inner-loop commands,
  scope/delegation/effort calibration.
- [`.claude/rules/`](.claude/rules/) — domain-specific rules, loaded on demand.
- [`CHANGELOG.md`](CHANGELOG.md) — running development log (Keep a Changelog format).
- [`docs/design/`](docs/design/) — multi-iteration design docs.
