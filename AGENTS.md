# Muse

A provider-neutral personal AI conductor for **one user, one private control plane, no shared
workspace**. One coherent reasoning loop across local, self-hosted, and cloud deployment choices;
provider-specific code stays at the edges. Local-only is an explicit fail-close privacy posture,
not the product identity.

This file is the cross-agent product brief (the open `AGENTS.md` standard). It deliberately does
not restate the Claude-specific contract in [`CLAUDE.md`](CLAUDE.md) or the domain rules in
[`.claude/rules/`](.claude/rules/) — those are auto-loaded for Claude Code and must be read
explicitly by any agent that is not.

A non-Claude agent resolves the **nearest** `AGENTS.md` walking up from the file it is editing,
and **composes** it with this one — verified by asking Codex CLI 0.145 to list its loaded context.
So the surfaces whose rules actually bind carry their own, and an agent gets them without
following any pointer:

| Directory | Carries |
| --- | --- |
| [`packages/messaging`](packages/messaging/AGENTS.md) | the outbound edge — draft-first, link-preview suppression |
| [`packages/secrets`](packages/secrets/AGENTS.md) | credentials, and that encryption at rest is opt-in |
| [`packages/model`](packages/model/AGENTS.md) | the only place a vendor SDK may appear; local-only throws |
| [`packages/tools`](packages/tools/AGENTS.md) | one-shot tool selection for a small local model |

Everything else falls through to this file. Note what a non-Claude agent does **not** get:
`CLAUDE.md` and `.claude/rules/` are not loaded for it. That is survivable because the binding
half is not prose — the hooks in `scripts/githooks/` run from `core.hooksPath`, which is plain git
config, so every commit and push faces the same 14 checks whichever agent produced it.

## If you are not Claude Code, read these before you work

They are auto-loaded for Claude Code and for nothing else, so for you they are an instruction,
not a footnote. Read by what the task touches — not all of them, every time:

| Before you… | Read |
| --- | --- |
| do any non-trivial multi-step work | [`.claude/harness/contract.md`](.claude/harness/contract.md) — risk tiers, the two mandatory roles, the fail-closed gates |
| commit or push | [`.claude/rules/engineering/commits.md`](.claude/rules/engineering/commits.md) — what is and is not authorized |
| write or change a test | [`.claude/rules/verification/testing.md`](.claude/rules/verification/testing.md) — which gate proves what |
| add or change a tool | [`.claude/rules/safety/tool-calling.md`](.claude/rules/safety/tool-calling.md) |
| touch a provider or the model layer | [`.claude/rules/engineering/architecture.md`](.claude/rules/engineering/architecture.md) |

**You will be held to them either way.** The hooks in `scripts/githooks/` run from
`core.hooksPath`, which is plain git config — every commit and push you make faces the same
deterministic checks as any other agent, whether or not you read a line of this.

## The floor — restated here on purpose

Everything else in this repository is a pointer. These are not, because they are the boundaries
whose breach cannot be undone by a revert, and a boundary must never depend on a link being
followed:

- **Nothing reaches a third party without the owner confirming the exact content.** Sending,
  replying, submitting, booking, posting: the agent drafts, the owner confirms, and the approval
  gate is fail-closed — a denied or undeliverable confirmation means the action does not happen.
  There is no autonomous send. → [`outbound-safety`](.claude/rules/safety/outbound-safety.md).
- **Banking, brokerage, payments and money movement are permanently out of scope.** Not deferred.
- **Never force-push, `--no-verify`, delete a remote ref, cut a tag or release, or push to an
  alternate remote.** A verified normal push to `origin` is pre-authorized; nothing else is.
- **`MUSE_LOCAL_ONLY=true` is enforced in code, not in a prompt.** Under it, a cloud provider
  throws rather than silently degrading.
- **Never commit live credentials.**

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
- **AttuneGraph is a lightweight agent-native temporal/provenance graph**, not a generic
  graph-DB claim. The neutral engine is `@attunegraph/core`; Muse consumes it through the
  explicit `@muse/attunegraph` Continuity/Shadow integration package. Existing personal stores
  remain authoritative and the graph is a rebuildable projection. Contract:
  [`docs/design/attunement/attunegraph.md`](docs/design/attunement/attunegraph.md). Program:
  [`internal/goals/attunegraph-roadmap.md`](internal/goals/attunegraph-roadmap.md).

Runtime invariants, always:

- Guard is fail-close. Hook is fail-open.
- Tool output is untrusted; tool loops have explicit limits and timeouts.
- Message-pair integrity is preserved. Trace every meaningful step.
- Model adapters may differ; `agent-core` stays provider-neutral.

## Stack

TypeScript 7 (with the TS6 API alias for tooling) on a pnpm workspace: Fastify, React + Vite,
commander + Ink, Vitest, OpenTelemetry + pino, and a Rust `crates/runner` for risky execution.
`package.json` and the imports are authoritative for anything more specific.

The parts you would guess wrong: PostgreSQL is **optional** and every store falls back to
in-memory, so the default run has no database. "LM Studio" is not a dedicated adapter — it is the
OpenAI-compatible one pointed at a local `baseUrl`. OpenAI uses the Responses API while
compat backends use `/v1/chat/completions`. All of that, plus the rule that a vendor SDK may only
appear inside `packages/model/src/adapter-<name>.ts`, is owned by
[`.claude/rules/engineering/architecture.md`](.claude/rules/engineering/architecture.md).

## Repository layout

`ls` answers the shape of the tree. The packages worth knowing by name, and what each owns:

| Package | Owns |
| --- | --- |
| `agent-core` | Guard, Hook, ReAct + Plan-Execute loops, message integrity, context transforms |
| `model` | The `ModelProvider` interface and every provider wire adapter — the only place a vendor SDK may appear |
| `attunement` · `attunegraph` · `muse-attunegraph` | Continuity threads and receipts · the dependency-free temporal/provenance engine · Muse-only Continuity/Shadow graph integration |
| `recall` · `memory` · `stores` | Grounded recall, conversation state and checkpoints, file-backed personal stores |
| `tools` · `mcp` · `mcp-shared` · `browser` | Tool registry and built-ins, MCP transport plus loopback servers, real-Chrome control |
| `policy` · `secrets` · `auth` | Approval, permissions, guardrails, credential handling |
| `calendar` | `CalendarProvider` plus Local / Local-ICS / Google / CalDAV / macOS adapters and a chmod-600 credential store |
| `proactivity` · `scheduler` · `messaging` · `voice` | Speaking first, cron and locks, channels, STT/TTS |
| `multi-agent` · `a2a` · `agent-specs` · `skills` | Supervisor and orchestrator, peer protocol, agent definitions, learned skills |
| `observability` · `runtime-state` · `resilience` · `db` | Spans and metrics, run history and traces, retry policy, Kysely queries and migrations |

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
Operational rules: [`.claude/rules/verification/testing.md`](.claude/rules/verification/testing.md). Stack decision and
rationale: [`docs/development/testing-strategy.md`](docs/development/testing-strategy.md).

**Agent behaviour is graded separately, outcome-first**: isolated trials, deterministic
terminal-state graders, trace invariants only where ordering is a real contract, strict `pass^k`,
adversarial and fault tests, and local trace review. See
[`docs/development/ai-agent-testing-strategy.md`](docs/development/ai-agent-testing-strategy.md).

## Repository publication

The owner grants **standing authorization for a verified normal Git push** from the current Muse
task branch (or verified local `main`) to its configured `origin` upstream, after the applicable
risk-tier completion gate and required checks pass. The full contract — what is *not* authorized
(alternate remotes/refspecs, remote deletion, tags/releases, force-push, `--no-verify`, credentials,
branch-protection), the retry-once-then-stop rule on failure, and the loop tiers — lives in
[`.claude/rules/engineering/commits.md`](.claude/rules/engineering/commits.md) and is not restated here.

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

### Model routing

The 300-task productization program routes work across model tiers (controller/evaluator vs
implementation vs low-risk transformation) and records maker, effort, risk tier and escalation
trigger in every task activation header. That routing table lives with the program it governs:
[`internal/goals/personal-agent-productization-roadmap.md`](internal/goals/personal-agent-productization-roadmap.md).

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

- [`docs/README.md`](docs/README.md) — the documentation index, and the order to read it in.
- [`CLAUDE.md`](CLAUDE.md) — the Claude Code contract: trust floor, inner-loop commands,
  scope/delegation/effort calibration.
- [`.claude/rules/`](.claude/rules/) — domain-specific rules, loaded on demand.
- [`CHANGELOG.md`](CHANGELOG.md) — running development log (Keep a Changelog format).
- [`docs/design/`](docs/design/) — multi-iteration design docs.
