# Muse

A provider-neutral personal AI conductor for **one user, one private control plane, no shared
workspace**. One coherent reasoning loop across local, self-hosted, and cloud deployment choices;
provider-specific code stays at the edges. Local-only is an explicit fail-close privacy posture,
not the product identity.

This file is the cross-agent product brief (the open `AGENTS.md` standard). [`CLAUDE.md`](CLAUDE.md)
and the domain rules in [`.claude/rules/`](.claude/rules/) are auto-loaded for Claude Code and for
nothing else, so this file reproduces them verbatim in a generated appendix at the end — see
"If you are not Claude Code" below, including how to tell whether you received all of it. That
appendix is why this file is ~80 KB: budget roughly 20k tokens per session for it.

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

Everything else falls through to this file. The binding half is not prose in any case — the hooks
in `scripts/githooks/` run from `core.hooksPath`, which is plain git config, so every commit and
push faces the same checks whichever agent produced it.

## If you are not Claude Code

Claude Code is handed `CLAUDE.md` and every file under `.claude/rules/` automatically, on every
session. You are not — so they are reproduced verbatim in the generated appendix at the end of
this file.

**Check that you actually received it before relying on it.** This file is ~80 KB and codex
truncates a project doc at `project_doc_max_bytes` (default 32 KiB) *silently*, so a default
setup drops the last two thirds — outbound safety, the push policy, the testing gates — with no
warning at all. The check: the very last line of this file is `<!-- END GENERATED -->`. If your
copy ends anywhere else, you were truncated. This repo ships [`.codex/config.toml`](.codex/config.toml)
raising the budget, and codex applies it only once the project is TRUSTED — so being truncated
means the repo is untrusted here. Trust it, or set `project_doc_max_bytes = 200000` at the TOP
LEVEL of `~/.codex/config.toml` (appended at the end it lands inside the last `[projects."…"]`
table and does nothing). Until then, read every file in the table below directly.

If you were truncated, the table below is the minimum to read back; the appendix's own list of
all 12 projected paths is delivered even under truncation, so use that for the rest. Only the
first row is absent from the appendix — Claude Code does not auto-load `contract.md` either, so read it whatever you are:

| Before you… | Read |
| --- | --- |
| do any non-trivial multi-step work | [`.claude/harness/contract.md`](.claude/harness/contract.md) — risk tiers, the two mandatory roles, the fail-closed gates |
| commit or push | [`.claude/rules/engineering/commits.md`](.claude/rules/engineering/commits.md) |
| write or change a test | [`.claude/rules/verification/testing.md`](.claude/rules/verification/testing.md) |
| add or change a tool | [`.claude/rules/safety/tool-calling.md`](.claude/rules/safety/tool-calling.md) |
| send anything toward a third party | [`.claude/rules/safety/outbound-safety.md`](.claude/rules/safety/outbound-safety.md) |

The nested `AGENTS.md` files listed near the top of this file load automatically when you work in those
packages.

**You are held to all of it either way.** The hooks in `scripts/githooks/` run from
`core.hooksPath`, which is plain git config — every commit and push you make faces the same
deterministic checks as any other agent, whether or not you read a line of this.

### Two things in `.claude/` are Claude Code machinery, not documents

They are the one real capability gap, and the danger is reporting a step you had no way to run.

- **`.claude/skills/`** — invoked as `/improve-muse`, `/release` and so on. You cannot invoke
  them, but each is a plain `SKILL.md`: open it and follow it by hand. Nothing is lost but the
  shortcut.
- **`.claude/agents/independent-evaluator.md`** — a subagent Claude Code spawns in a separate
  context. You cannot spawn it, and the requirement does not soften: `.claude/harness/contract.md`
  makes an independent evaluator unconditional on the surfaces listed there, and the commit-msg
  hook rejects those diffs unless the body records `review-tier: independent-evaluator`.
  **Get the separation a different way — start a second, fresh `codex exec` session**, give it
  the acceptance criteria, and tell it to judge and not to fix. A new invocation is a new
  context, which is what maker ≠ judge asks for. Never grade work in the session that built it.
  If separation is genuinely impossible, use the contract's own escape: record `unseparated
  self-evaluation`, do not claim PASS, and stop for human review.

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

<!-- BEGIN GENERATED — `pnpm agents:build`. Edit the source files, never this block. -->

# Appendix — the context Claude Code is given automatically

Claude Code auto-loads the files below on every session. You do not, so they are reproduced
here verbatim and they bind you the same way — provided you received all of them; see the
truncation warning near the top of this file. This block is generated by
`scripts/build-agents-md.mjs` from the paths listed; the pre-push hook fails if it is stale.
Edit the source file, then run `pnpm agents:build`.

- [`CLAUDE.md`](CLAUDE.md)
- [`.claude/rules/engineering/architecture.md`](.claude/rules/engineering/architecture.md)
- [`.claude/rules/engineering/cli-product.md`](.claude/rules/engineering/cli-product.md)
- [`.claude/rules/engineering/code-style.md`](.claude/rules/engineering/code-style.md)
- [`.claude/rules/engineering/codegraph.md`](.claude/rules/engineering/codegraph.md)
- [`.claude/rules/engineering/commits.md`](.claude/rules/engineering/commits.md)
- [`.claude/rules/engineering/harness.md`](.claude/rules/engineering/harness.md)
- [`.claude/rules/safety/outbound-safety.md`](.claude/rules/safety/outbound-safety.md)
- [`.claude/rules/safety/tool-calling.md`](.claude/rules/safety/tool-calling.md)
- [`.claude/rules/verification/agent-testing.md`](.claude/rules/verification/agent-testing.md)
- [`.claude/rules/verification/self-eval.md`](.claude/rules/verification/self-eval.md)
- [`.claude/rules/verification/testing.md`](.claude/rules/verification/testing.md)

---

<!-- source: CLAUDE.md -->

# Muse

**Muse learns how one person lives and works, and gets better at when and how to help.** Every slice
you land here makes one real owner's daily life smoother — that is who the work is for. North star —
Attunement: Shadow Muse → Continuity Capsule → visible Policy Card. Product contract:
[`docs/strategy/attunement.md`](docs/strategy/attunement.md).

- **The complete loop is ROADMAP, not a shipped claim** — memory, pattern, proactivity, browser,
  trace and checkpoint are its substrates. First vertical: user-chosen Personal Continuity over
  exact Muse-local artifacts plus optional browser history; Work Resumption is one mode, not the
  product boundary. Never reduce the whole product to a work assistant, a productivity tracker or a
  computer-use agent, and never make Observe a prerequisite for the user-invoked Continuity Pack.
- **AttuneGraph is a rebuildable temporal/provenance projection** and personal context
  compiler. The neutral engine is `@attunegraph/core`; Muse integration is
  `@muse/attunegraph`; existing stores stay authoritative.

## Trust floor — never traded for a feature

- **Provider/MCP-neutral.** Cloud, self-hosted and local models are all allowed (the rule that
  enforces it is under Non-negotiables).
- **Owner-controlled placement.** `MUSE_LOCAL_ONLY=true` is a strict opt-in posture that refuses
  cloud egress in code, not in a prompt.
- **Deterministic grounding.** Supported grounded personal-data paths cite sources, lower weak
  matches and drop invalid citations. Never claim universal citation coverage or fabrication=0 —
  fast uncited chat is a documented gap. Keep the per-surface grounding ratchets intact.
- **Correction and draft-first action.** The user can contradict Muse; nothing reaches a third
  party without their confirmation of the exact content.
- **Observe stays controllable** — visible, pausable, inspectable, forgettable; never persists raw
  keystrokes or continuous screen capture by default.

## Dev cycle (inner loop)

```bash
pnpm --filter @muse/<name> build       # one package
pnpm typecheck:fast                    # TypeScript 7 project graph, no test fan-out
pnpm test:changed                      # DEFAULT per-edit gate — only tests related to git-changed files
pnpm --filter @muse/<name> test        # one whole package (only when a change is broad)
pnpm --filter @muse/web test:browser   # real Chromium; required for React interaction/focus/keyboard
pnpm check                             # build + test every workspace — pre-commit gate, not per-edit
pnpm smoke:broad                       # broad HTTP smoke, diagnostic provider (no key)
pnpm smoke:live                        # real LLM round-trip — LOCAL OLLAMA ONLY, gemma4:12b default
pnpm lint                              # 0 errors / 0 warnings required
```

These commands are the ground truth; if one fails, stop and triage. Run the narrowest gate that
exposes your change. Tests are the only form of verification a claim can rest on, and `smoke:broad`
(diagnostic) is the start, not the finish — any request/response-path change needs `smoke:live`.

TypeScript/toolchain work follows [`docs/development/typescript-7.md`](docs/development/typescript-7.md):
builds use TS7, the `typescript` dependency stays the TS6 compiler-API alias for tooling, and
migration diagnostics are never masked with compiler-option relaxations.

**Deciding what to do next:** `improve-muse` for HARDENING (regression → failures → live pain probe
→ debt → subtraction), `grow-muse` for a NEW capability (owner's direction → dogfood friction →
north-star gap → parity). One slice end-to-end; "nothing to do" is forbidden.

## How to work — scope, delegation, effort, length

- Deliver what was asked, at the scope intended. Make routine judgment calls yourself; check in only
  when different readings lead to materially different work. If a request seems mistaken, say so in
  a sentence and continue as asked — never quietly narrow, widen or transform it. Finish the whole
  task; stop short of what is clearly beyond it.
- Stop and surface to the owner: destructive actions, scope changes, decisions that are his to make.
- **Opus 5** — delegate only large, genuinely independent, parallelizable tracks; never for work a
  handful of tool calls finishes; never a subagent to verify your own output; prefer one over several.
  Effort: `low`/`medium` liberally wherever quality holds, `xhigh` only for the most demanding work.
- **Fable 5** — delegate freely and keep subagents long-lived across subtasks. Effort: `high` is the
  everyday setting; `xhigh` for the hardest tasks.
- Keep responses concise. Written documents match length to what the task needs — no filler
  sections, redundant summaries or boilerplate.

## Non-negotiables

- `agent-core` is model-agnostic; provider SDKs live behind `packages/model` adapters only. Never
  make OpenAI / Anthropic / Vercel-AI-SDK / LangGraph the runtime owner.
- Guards are fail-close. Hooks are fail-open. Security is deterministic code, never prompt text.
- Tool output is untrusted; tool loops have explicit limits and timeouts.
- Risky local execution flows through `crates/runner` — one audited allowlist exception,
  `muse.skills.run`; every surface shares one `agent-core` runtime.
- Outbound to a third party (send, submit, book, post) is fail-close and draft-first per
  [`.claude/rules/safety/outbound-safety.md`](.claude/rules/safety/outbound-safety.md) — never an autonomous send. Banking /
  brokerage access and money movement are permanently out of scope.
- No force-push, `--no-verify`, tags/releases, remote-ref deletion, or alternate remote/refspec
  without explicit approval; verified normal pushes follow the standing authorization in
  [`.claude/rules/engineering/commits.md`](.claude/rules/engineering/commits.md). Never commit live workspace credentials.
- All documentation is English — every `.md`, new ones included (quoted UI strings excepted).
- **Docs are written for agents, not for a human reader.** One owner per fact; point at the gate
  that enforces a rule instead of restating it; delete a record that no longer matches the code
  rather than annotating it — an agent will ground on whatever is there. `README.md` is the one
  page written for a human visitor.

## Read further — `.claude/rules/` is auto-loaded, grouped by concern

- **safety/** — [`.claude/rules/safety/outbound-safety.md`](.claude/rules/safety/outbound-safety.md) the fail-close send gate · [`.claude/rules/safety/tool-calling.md`](.claude/rules/safety/tool-calling.md) one-shot tool choice on the local model.
- **verification/** — [`.claude/rules/verification/testing.md`](.claude/rules/verification/testing.md) the gate ladder · [`.claude/rules/verification/agent-testing.md`](.claude/rules/verification/agent-testing.md) grading the AGENT (outcomes, `pass^k`) · [`.claude/rules/verification/self-eval.md`](.claude/rules/verification/self-eval.md) the scoreboard that fails closed on a drop.
- **engineering/** — [`.claude/rules/engineering/architecture.md`](.claude/rules/engineering/architecture.md) package layout + ModelProvider · [`.claude/rules/engineering/commits.md`](.claude/rules/engineering/commits.md) push policy · [`.claude/rules/engineering/code-style.md`](.claude/rules/engineering/code-style.md) lint and comments · [`.claude/rules/engineering/cli-product.md`](.claude/rules/engineering/cli-product.md) CLI surface · [`.claude/rules/engineering/codegraph.md`](.claude/rules/engineering/codegraph.md) index before grep · [`.claude/rules/engineering/harness.md`](.claude/rules/engineering/harness.md) multi-step work.

This contract stays under 100 lines — depth goes in `.claude/rules/*.md`, and a recurring owner
correction is absorbed as a rule there. Read the cross-session learning index first:
`~/.claude/projects/-Users-jinan-side-project-Muse/memory/MEMORY.md`. Product brief: [`AGENTS.md`](AGENTS.md).

---

<!-- source: .claude/rules/engineering/architecture.md -->

# Architecture rules

## Model-agnostic core

`agent-core` calls a Muse-owned abstraction — never a vendor SDK directly.

```ts
interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

Each model declares its capabilities so the runtime can route safely:

- `streaming`, `toolCalling`, `structuredOutput`, `vision`, `reasoning`, `promptCaching`
- `maxInputTokens`, `maxOutputTokens`
- `local`, `cost`, `latencyProfile`

## Required provider families

`packages/model` ships adapters for:

- OpenAI (Responses API — `/v1/responses`). OpenRouter, LM Studio and other
  compat backends use `/v1/chat/completions` via `OpenAICompatibleProvider`.
  **Ollama is the exception**: `adapter-ollama.ts` overrides `generate` and
  `stream` onto the native `/api/chat` (stripping `/v1`), because the compat
  endpoint does NOT honour `think: false` — a reasoning model streams its
  thoughts and first-token went to 134 s. Only `listModels` stays on `/v1`.
- Anthropic
- Google Gemini
- OpenRouter
- Ollama
- LM Studio / OpenAI-compatible local
- Custom OpenAI-compatible endpoint

## Fallback rules

- If native tool calling is unavailable → fall back to a text tool protocol with strict parsing.
- If structured output is unavailable → fall back to parser + validator.
- If the context window is small → apply stronger trimming before invocation.
- If a provider fails → use the explicit fallback policy. **No hidden retry magic.**
- Retry classification: `ModelProviderError.retryable` is the source of truth.
  4xx (model-not-found, bad key) MUST fail fast. 5xx and unknown errors MAY retry.

## Local-only mode (no cloud egress) — opt-in

`MUSE_LOCAL_ONLY=true` is the OPT-IN privacy/security posture for running
Muse strictly on local open-source models — nothing may reach a third-party
cloud LLM/voice API. It is **off by default** (cloud is allowed); when
switched on it is deterministic, fail-close (`local-only-policy.ts`):

- `classifyProviderLocality(providerId, effectiveBaseUrl)` is the source
  of truth. Local = `ollama` / `lmstudio` / `diagnostic` on a loopback
  host, or an `openai-compatible` endpoint pointed at localhost. Cloud =
  any cloud-id provider (`openai`/`anthropic`/`gemini`/`openrouter`) OR an
  off-box host — a REMOTE Ollama/LM-Studio host counts as egress.
- The model router (`createModelProvider`) throws `LocalOnlyViolationError`
  (loud, not a silent disable) before instantiating a cloud provider.
- **Default model resolution.** Priority: explicit `MUSE_MODEL`/
  `MUSE_DEFAULT_MODEL` env → local-only forced local → the user's saved
  `defaultModel` in `~/.config/muse/config.json` → a cloud model inferred
  from an ambient credential (GEMINI → OPENAI → ANTHROPIC → OPENROUTER) →
  the local fallback (`ollama/gemma4:12b`, so a fresh box still boots).
  The config rung exists because a stale ambient key must never beat the
  user's explicit choice (dead-GEMINI hijack, fixed 2026-07-17). When `MUSE_LOCAL_ONLY=true`, the local model is forced and ambient
  cloud keys are IGNORED (so a stray `GEMINI_API_KEY` can never trip the gate).
- When local-only is on, the voice registry ignores an OpenAI key, so cloud
  STT/TTS never registers (mic audio cannot silently go to OpenAI).
- `muse doctor` reports the posture; embeddings are already localhost-only.
- **Image input needs no separate guard**: there is no standalone vision
  provider. `muse ask --image` / `muse chat --local --image` are Ollama-local by design, agent-run attachments
  are text-only, and image bytes only leave via a cloud provider's adapter
  — which the model-router gate already forbids under local-only. So the
  provider gate transitively closes vision egress; don't add a second one.

## What's allowed inside adapters

- Vendor SDK provider packages MAY be used inside `packages/model/src/adapter-<name>.ts`.
- They MUST NOT become the core runtime API.
- OpenAI Agents SDK, Vercel AI SDK, LangGraph.js may be studied but must not own Muse contracts.

## MCP server allowlist (goal 032)

`McpSecurityPolicy.allowedServerNames` controls which external MCP
server names are eligible for connection. Enforcement is two-layered:

- At register time, `McpManager.register` checks the allowlist + marks
  a denied server `disabled` without throwing.
- At connect time, `McpManager.connect` re-checks via
  `securityPolicyProvider.isServerAllowed(name)` so a policy change
  between register and connect still gates correctly. Returns `false`
  + status `"disabled"` on denial — no exception.

Empty `allowedServerNames` means everything's allowed (opt-in
posture). Populate it when you need a strict allowlist (multi-MCP
machines, shared workstations).

## Provider-specific schema quirks

- **Gemini**: tool inputSchemas pass through `sanitizeGeminiSchema` to strip
  JSON-Schema keywords Gemini's tool API rejects (`additionalProperties`,
  `$schema`, `$id`, `$ref`, `definitions`, `patternProperties`,
  `unevaluatedProperties`, `exclusiveMinimum`, `exclusiveMaximum`).
- **OpenAI strict mode**: requires `additionalProperties: false`. Don't strip it for that path.
- **Anthropic**: accepts standard JSON Schema with `additionalProperties: false`.

## Database

- PostgreSQL is the optional durable backend for server state; every store falls back to an
  in-memory implementation (`db ? new KyselyXStore(db) : new InMemoryXStore(env)`), which is what
  runs by default today.
- Kysely is used for typed SQL access.
- Prefer explicit SQL migrations over ORM-managed schema mutation.
- Run, message, tool-call, approval, checkpoint, and trace tables stay queryable.
- Don't hide critical agent state in opaque blobs unless it's an append-only event payload.

## Build graph (TypeScript project references)

Every TS workspace (all `packages/*` plus `apps/cli` / `apps/api`) is a
`composite` project and declares `references` to its internal `@muse/*`
dependencies; the root `tsconfig.json` is a solution file referencing them
all. Each package's `build` script is `tsc -b`, so an isolated
`pnpm --filter @muse/<x> build` rebuilds stale upstream `dist/` first — the
build graph is dependency-correct, not reliant on pnpm's topological order
alone. This is what closes the recurring "stale dist" failure class.

- A new internal dependency MUST be added to BOTH `package.json` and the
  project's `tsconfig.json` `references` (a Zod-style fail if you forget:
  `tsc -b` won't see the dep's fresh `.d.ts`). The acyclic invariant holds —
  do not introduce a reference cycle.
- `apps/web` is intentionally OUT of the reference graph (Vite island, no
  `@muse/*` deps); keep its `tsc -p tsconfig.json && vite build` script.

## Coding rules

- Core packages stay framework-independent.
- TypeScript strict mode.
- Zod (or comparable) for external input + config validation.
- Prefer small interfaces and explicit adapters over global service locators.
- Don't add framework abstractions until a real module boundary needs them.
- Snapshot-test prompt text and tool protocols when behavior matters.
- No provider-specific assumptions in `agent-core`.
- Deterministic code for policy, permissions, budgets, and stop conditions.

---

<!-- source: .claude/rules/engineering/cli-product.md -->

# CLI product surface

The CLI is not a wrapper afterthought. Server and CLI share the same
`packages/agent-core` runtime — same guard semantics, same hook
contracts, same approval gates.

## Stack

- Command parser: `commander`
- Interactive prompts: `@clack/prompts`
- Full terminal UI: Ink

## Storage paths

- User config: `~/.config/muse/config.json`
- Workspace run state: `.muse/runs/*.jsonl`
- Credentials: OS keychain or encrypted auth store

## Modes

- **Local**: execute `packages/agent-core` in the CLI process.
- **Remote**: connect to the API server over SSE.
- Risky local execution goes through `crates/runner` as a child process. **One
  audited exception:** `muse.skills.run` (`packages/tools/src/muse-tools-skills.ts`)
  spawns declared binaries with `node:child_process.spawn` directly, gated by an
  allowlist instead of the Rust sandbox. Do not add a second exception — route new
  execution through the runner.

## What not to do

- Don't fork agent behavior between CLI and server. Same runtime, same contracts.
- Don't store API tokens in plain text — use the keychain or the encrypted auth store.
- Don't ship a CLI feature without unit tests for the command parser and a smoke test for the run path.

---

<!-- source: .claude/rules/engineering/code-style.md -->

# Code style & lint

The repo runs ESLint with `typescript-eslint/recommended` via the
flat config at the repo root (`eslint.config.js`). The gate is
intentionally permissive at first — most stylistic rules are off so
the existing codebase passes — and tightens iteratively.

## Commands

```bash
pnpm lint          # report only (warnings allowed, 0 errors required)
pnpm lint:fix      # auto-fix what eslint can fix safely
```

CI must keep `pnpm lint` exit-0. Warning count is the cleanup
backlog — don't let it grow unchecked.

## Currently enforced as `error`

- `no-debugger` — no `debugger;` left in committed code
- `no-eval` / `no-with` — defense against unsafe code paths
- `@typescript-eslint/no-unused-vars` — unused imports, params, and
  caught errors. Prefix with `_` to silence intentionally
  (e.g. `(_event) => ...`). Promoted in round 174 after the sweep.
- `prefer-const` — flag `let` declarations that are never
  reassigned. Promoted in round 174. The autoconfigure
  scheduler-handle pattern (closure forward-reference into a value
  assigned later) uses a `const { current }` holder object instead
  of `let`; reach for the same pattern when this rule complains.
- `no-empty` (with `allowEmptyCatch: true`) — promoted in round 181.
  Empty `catch {}` is fine; other empty blocks are bugs in waiting.
- `no-empty-pattern` — destructuring that binds nothing is almost
  always a typo.
- `no-useless-escape` — over-escaped regex/string characters.
- `no-unsafe-finally` — `return` / `throw` inside `finally` swallows
  the original control flow.
- `no-async-promise-executor` — `new Promise(async ...)` is the
  classic forgotten-await pattern.
- `no-prototype-builtins` — direct `obj.hasOwnProperty(...)` breaks
  on null-prototype objects; `Object.hasOwn(obj, ...)` is the
  modern fix.
- `no-restricted-imports` — bans `@muse/attunement/host` outside the
  audited production composition roots. The host seam is the only way
  to mint `organic` evidence authority, so an unaudited import would
  let controlled-replay data pass as real usage.

## Off (but reconsider before tightening)

- `@typescript-eslint/no-explicit-any` — used in legitimate adapter
  shims; tightening requires per-file `eslint-disable` lines.
- `@typescript-eslint/no-empty-object-type` — JSON envelope types
  use `{}` legitimately.

## Adding a rule

When a recurring bug class shows up, add a single rule to
`eslint.config.js` and:

1. Run `pnpm lint --fix` if the rule has an autofixer.
2. Sweep remaining violations BEFORE merging the rule change.
3. Set the rule to `error` once the sweep is clean — `warn` is for
   the transition period only.

## Comments — only when the code cannot carry it

Default to **no comment**. One earns its place only by carrying a WHY a reader cannot derive:
a non-obvious constraint ("this API rejects 401 — never retry, it is permanent"), a workaround
whose reason is invisible, or a deliberate surprising choice. Narrating WHAT the code does,
restating a signature, or naming a task/PR/caller is deleted on sight.

**Round / iteration / goal markers are a hard no** — `// Goal 158`, `round 167`, `iter #57`.
History belongs to `git blame`, the commit message and `CHANGELOG.md`; goal context belongs in
`internal/goals/*.md`. This one is enforced, not requested: `pnpm lint:comments`
(`scripts/check-comment-markers.mjs`), which self-eval runs every time.

## Naming

- **Names earn their length.** A two-character abbreviation that
  saves typing is a bad trade if a reader has to scroll up to learn
  it. Single-letter names belong only to obvious loop indices and
  `(a, b) => ...` comparators.
- **Re-stating history in comments** (`round 167`, `iter #57`,
  `Goal NNN`) belongs in commit messages and `CHANGELOG.md`, not
  source. See the comment rule above.
- **Re-export-only imports go away.** If `import { X } from "./y"` is
  paired with `export { X } from "./y"` and `X` isn't used in the
  file body, drop the `import` line — `export-from` covers it.

---

<!-- source: .claude/rules/engineering/codegraph.md -->

# CodeGraph — the grep guard

The codegraph MCP server ships its own tool-selection guidance and injects it
alongside the tools, so this file does not repeat it. If the server is not
connected the tools do not exist and none of this applies.

What follows is the part that is specific to this repository, and the part that
keeps slipping in practice.

## The binary trigger

"Prefer CodeGraph" is easy to agree with and then break in the moment, so make it
mechanical. **Before typing `Grep` / `grep` / `rg`, or opening a file with `Read`
*to find something*, answer one question:**

> Am I searching for a **NAME** (a function / class / type / const / method /
> interface identifier) or for **LITERAL TEXT** (a log string, an env-var name, a
> comment, a JSON key, a config value)?

- **NAME → `codegraph_search "<name>"` first. No exceptions.** It returns kind,
  location and signature in one sub-millisecond call. Need the body too?
  `codegraph_node` / `codegraph_explore` — not `Read`.
- **LITERAL TEXT → grep is correct.** That is the one thing grep wins at here.

Smell test: **if the query is an identifier you would autocomplete in an IDE, it
belonged in `codegraph_search`.** `selectFireablePatterns`,
`resolvePatternsFiredFile`, `mergeSkillsIntoUmbrella`, "where is helper X
exported" — all names. `PROACTIVE_POLL_MS`'s *value*, an env-var string, a quoted
UI string — literal, grep is fine.

`Read` is for a file you are about to **edit**, or one CodeGraph could not fully
surface. Never for discovering where a symbol lives.

## Index lag

The index lags writes by about a second through the file watcher. When a response
opens with a staleness banner, `Read` those specific files — files not in the
banner are fresh and CodeGraph is authoritative for them.

## When `.codegraph/` is absent

Not every worktree has an index (it is per-checkout, and a fresh `/tmp` worktree
will not have one). Then every rule above is inert and grep is the only option —
say so rather than reporting a symbol as missing. Offer `codegraph init -i`.

---

<!-- source: .claude/rules/engineering/commits.md -->

# Commits & push policy

## Conventional Commits

- `feat:` user-visible feature or new project capability
- `fix:` bug fix
- `refactor:` behavior-preserving restructuring
- `test:` test-only change
- `docs:` documentation-only change
- `chore:` tooling, config, dependency, repository maintenance

Subjects and bodies are written in English.

Make small commits after coherent milestones. One iteration goal
per commit (or two when a `feat:` naturally pairs with a `test:`).
Don't mix unrelated work into one commit.

## Push policy

- **Standing authorization (Jinan, 2026-07-17):** after evaluator PASS,
  intended/clean commit scope, tier-appropriate green gates, `git fetch` +
  rebase, and the unskipped versioned pre-push hook, publish a normal push from
  the current Muse task branch (or verified local `main`) to its configured
  `origin` upstream without asking again. A verified slice is not complete
  while this allowlisted push remains pending.
- The standing authorization does **not** include alternate remotes or arbitrary
  refspecs, remote deletion, tags/releases, force/force-with-lease,
  `--no-verify`, skipped hooks, credentials, or branch-protection changes. On
  hook, authentication, protection, or unresolved divergence failure, make at
  most one safe fetch/rebase retry, then stop and report; never escalate to a
  destructive bypass.
- Scheduled/autonomous loops keep their declared Tier. A Tier that forbids push
  stays forbidden until separately opted in. Git publication does not weaken
  `.claude/rules/safety/outbound-safety.md`: sending/submitting/booking/posting toward a
  third party remains draft-first and explicitly confirmed.
- Don't commit live Jira / Confluence / Bitbucket / Slack-workspace credentials.
- Don't commit `.claude/scheduled_tasks.lock` or other transient session-state files.
- **Rebase onto `origin/main` before starting a slice AND again immediately
  before every push**: `git fetch origin && git rebase origin/main`. Several
  agents push from this repo on the same machine; a branch that's stale
  relative to origin is the #1 cause of a non-fast-forward rejection or a
  silent revert of someone else's just-landed work.

## Worktree & branch lifecycle

- **One slice = one branch with a FRESH descriptive name.** Never reuse a
  previous slice's branch for a new slice — reuse makes "is this merged
  yet?" ambiguous for anyone auditing branch state later.
- **Work in a dedicated worktree OUTSIDE the main checkout**
  (`~/muse-worktrees/<slice>`), never inside it — the main worktree belongs
  to the owner. A failed `cd` into that worktree is a **HARD STOP**: never
  run a git command after a `cd` you haven't confirmed succeeded — a stray
  git mutation lands in the owner's live main checkout instead.
- **On completion (evaluator PASS + pushed/merged to `origin/main`), delete
  the branch and remove the worktree IMMEDIATELY**: `git worktree remove
  <path>` and `git branch -d <branch>`. A finished worktree left behind is
  rot — it goes stale, a cleanup pass can GC it mid-use by someone else, and
  it confuses future merged-state audits.
- **Abandoned or blocked work is never silently left in a dangling
  worktree.** Either commit a WIP to its branch with a defer note explaining
  why, or remove the worktree/branch outright.
- **Sweep check after each batch of slices**: `git branch --merged
  origin/main` should list no leftover slice branches — any that show up
  are cleanup debt, not history.

## `review-tier:` is required, and checked

A `feat`/`fix`/`refactor`/`perf` commit body must carry one line:
`review-tier: independent-evaluator | thin-review | n/a`. `guard-review-tier.mjs`
(commit-msg) blocks the commit without it, and REFUSES the thin tier when the diff
touches a surface where the evaluator is unconditional — migrations, SQL,
credential/auth/approval/consent/policy/guard sources, `scripts/githooks/`, or the
policy/secrets/quarantine-eval packages.

A mandatory surface demands the tier **whatever the subject says** — the commit type is the
author's own claim about risk, and this gate exists because a claim about risk is not
evidence.

It cannot verify that an evaluation happened. It forces the claim to exist in a fixed
vocabulary so a reader can check it against the diff — "the evaluator passed" used to be
a claim no script could audit. When editing the surface list, check it against
`git ls-files`: the first version anchored each keyword to the start of the basename and so
missed `channel-approval-gate.ts`, while blocking an `approval-gate.ts` that does not exist.

## Versioned git hooks

Hooks are checked into `scripts/githooks/` and wired via `core.hooksPath`, which is
shared across every worktree of the repo. `pre-push` runs, in order: a push-window lock,
a fail-closed scope classifier, the documentation reference gates, the deterministic
compile/lint gates, and an opt-in grounding tripwire. Mechanism and per-stage detail:
[`scripts/githooks/README.md`](scripts/githooks/README.md).

The escape hatches are greppable — prefer them to `--no-verify`:

- `MUSE_RUN_PREPUSH_GROUNDING=1` — opt INTO the grounding tripwire for a push that
  touches grounding.
- `MUSE_SKIP_PREPUSH=1` — suppresses the grounding tripwire only; every other gate still
  runs. Kept for compatibility with existing automation.
- `MUSE_SKIP_PREPUSH_ALL=1` — skips every stage including the compile gate. Genuine
  emergencies only.

## After-correction protocol

When the user corrects Claude on a recurring mistake, end the
iteration by adding the rule to the matching `.claude/rules/*.md` (or
open a new rules file). The goal is for the rule set to absorb every
correction so the same mistake doesn't recur.

---

<!-- source: .claude/rules/engineering/harness.md -->

# Agent operating harness

The operating contract for multi-step agent work — roles, handoff, fail-closed
gates, verification — is [`.claude/harness/contract.md`](.claude/harness/contract.md).
**Read it before any non-trivial, multi-step task and follow it.** Muse's own
slice-selection loop is [`dev-loop.md`](.claude/harness/dev-loop.md).

Skip it for a one-line answer or a trivial single edit; it is overhead there.

This file stays deliberately short because it is loaded into every session. It
carries only the two things an agent must know *before* it decides whether to
open the contract at all.

## 1. Maker ≠ judge is never waived

The evaluator is a **different instance** from the worker. A self-graded PASS is
void; if separation is genuinely impossible, record `unseparated
self-evaluation` and ask for human review — never PASS.

## 2. When an independent evaluator is MANDATORY

Unconditionally required when the diff touches any of: user-visible
strings/i18n, an on-disk/persisted format (stores, checkpoints, credentials),
an advertised flag/CLI/API/UI contract, a security/permission/outbound path,
process/scheduler/concurrency, harness gates, release, or anything
irreversible.

Otherwise — internal refactors, type plumbing, pure test changes — a thinner
tier is enough: the builder runs an explicit adversarial self-check ("find an
input where this is wrong") and the controller skims the diff. **Record which
tier was used in the commit body.**

Evidence for the cost: in one session all 4 real evaluator catches were
**silent-failure classes** (data corruption, a dead locale string, a lying flag,
a timing bug) — exactly what a green test suite does not surface.

---

<!-- source: .claude/rules/safety/outbound-safety.md -->

# Outbound-to-human safety (fail-close)

Muse may read the world freely. **Acting on the world toward another
human is different** — a wrong autonomous send is not a bug you can
roll back, it is a message your user did not write arriving in
someone else's inbox. This file is the non-negotiable contract for
every capability that *transmits content to a person* or *performs a
state-changing external action*. It is enforced as deterministic code
and tested checks — never as a prompt please-be-careful.

## What this governs

Normal source-control publication to Muse's configured `origin` is governed by
[`.claude/rules/engineering/commits.md`](.claude/rules/engineering/commits.md), including its narrow standing authorization. It is
not authorization for any human-facing send or external action below.

Any action that:

- sends / replies / forwards a message to a **third party** (email,
  chat, DM, SMS, social post, comment),
- submits a form, books, orders, publishes, or otherwise causes an
  effect in someone else's system,
- acts under a standing objective on the user's behalf toward a third
  party.

Replying to the **user themselves** on their own channel is the
low-risk path for the *approval gate* (it already runs the channel
approval gate for risky tools) — but see "Passive-fetch mitigation"
below: low approval risk is not the same as zero output risk.
Everything toward a third party is high-risk and gated.

## The rules (all MUST hold)

1. **Draft-first, never auto-send.** The agent produces the exact
   content and the **user explicitly confirms that content** before
   it leaves. Generated text is never transmitted to a third party
   on the agent's own judgement.
2. **Approval gate is fail-closed.** Reuse the existing
   `createChannelApprovalGate` / `toolApprovalGate` seam. If the
   approval prompt cannot be delivered or is denied / times out, the
   action does **not** happen. A send never proceeds because the
   confirmation step failed.
3. **Recipient is resolved, never guessed.** The destination
   (address / handle / person) must resolve unambiguously (P13
   contacts). An ambiguous or unknown recipient triggers a clarifying
   question (the clarify-directive) — never a best-guess address.
4. **Recorded + reversible-where-possible.** Every outbound action —
   sent OR refused — appends a rationale-bearing entry to the action
   log with the exact content, and is subject to undo / veto /
   learned-avoidance like any other autonomous action.
5. **Standing objectives need recorded scoped consent** for the
   specific send class before they may act toward a third party
   (`performConsentedAction`); absent or scope-mismatched consent is
   fail-closed.

## Passive-fetch mitigation on every channel reply (fail-close, deterministic)

An indirect prompt injection (planted in a page / note / email / MCP
result Muse reads) can make the model end a reply with an attacker URL
carrying a secret in the query string. The moment that reply lands in
a chat platform, the PLATFORM's own server-side crawler can fetch that
URL to build a link preview — no click, no approval, secret
exfiltrated (EchoLeak CVE-2025-32711 / CamoLeak CVE-2025-59145 class).
This holds **regardless of approval status**: even an approved,
human-confirmed reply must not trigger a passive server-side fetch of
attacker-controlled text the model produced.

So every channel-reply send carries the provider's link-preview /
unfurl suppression parameter:

- **Telegram** — `link_preview_options: { is_disabled: true }` on `sendMessage`.
- **Discord** — `flags: 4` (`SUPPRESS_EMBEDS`) on the message-create body.
- **Slack** — `unfurl_links: false, unfurl_media: false` on `chat.postMessage`.
- **LINE** — no equivalent field exists on the text message object.
  Accepted residual risk.
- **Matrix** — no sender-side suppression field exists in the spec
  (`m.hint.no_preview` is an open proposal, matrix-org/matrix-spec#1588).
  Accepted residual risk; whether a preview is generated at all depends
  on the recipient's client/homeserver, not the sender.

A new outbound channel provider ships with its suppression parameter
wired — or, if genuinely unavailable, the gap recorded here — never a
provider that echoes the model's raw text into a platform capable of
crawling it.

## Out of scope — never built

- **Banking / financial-account access, payments, money movement, or
  trading.** Muse must not connect to bank/brokerage accounts,
  initiate transfers, or move money. The blast radius is
  irreversible and uninsurable for a single-user assistant; this is a
  hard product boundary, not a deferral.

## How a new outbound capability ships

A "send" / "act" capability is delivered ONLY when its acceptance
check proves the gate, not just the happy path: the test must show
that **deny / timeout / ambiguous-recipient / absent-consent produces
no external effect** (contract-faithful HTTP fake, never a fake
registry), alongside the confirmed-path send. A send capability whose
test only asserts the happy path is not delivered.

---

<!-- source: .claude/rules/safety/tool-calling.md -->

# Tool-calling reliability — the local model must pick the RIGHT tool in ONE shot

Muse runs on a **local model (gemma4:12b default, reasoning/thinking off)**,
never an expensive cloud model. On a small local model every extra reasoning round is
slower AND less reliable — coherence degrades after 2–3 steps. So the
design goal is not "let the model think its way there"; it is **make
the FIRST tool call correct**. Every tool Muse exposes is designed so
the model selects it and fills its arguments in a single inference.

This is a first-class concern: a capability whose tool the local model
can't reliably call in one shot is not delivered, however good the
underlying code.

## The rules (apply to every `MuseTool` and MCP tool projection)

1. **Keep the exposed set small (≤ ~5–7 per turn).** Each extra tool
   raises the wrong-selection probability. Muse already has a
   relevance filter / `planForContext` — keep it tight; never dump the
   whole registry at the model. If a surface needs many tools, split
   by context instead of widening one prompt.

2. **Names are unambiguous and single-purpose.** `home_state`,
   `web_action`, `knowledge_search` — verb_noun, one job each. NEVER
   ship two tools the model could confuse (no `find` + `search`, no
   `remove` + `delete` for the same intent). Homonyms in
   names/descriptions are the #1 wrong-selection cause.

3. **Rich, constrained parameter schema.** Always declare `required`;
   never lean on optionals for mandatory data. Use explicit types,
   `enum` for fixed choices, `minimum`/`maximum`/`pattern` where they
   apply. Every property `description` carries a CONCRETE example —
   `"Target entity_id, e.g. 'lock.front_door'"`, not `"the entity"`.
   No abbreviated param names (`product_name`, not `pn`). "Invalid
   arguments" is the second-biggest failure mode and is fixed here.

4. **Each tool description says WHEN to use AND when NOT.** A one-line
   "use when … ; do not use for …" in the tool description prevents
   eager invocation (calling a tool on a greeting / when intent is
   absent) and sharpens selection. Pairs with the casual-prompt
   detector.

5. **One tool per response unless the task is genuinely multi-step.**
   Don't design flows that need the small model to chain 3+ calls;
   prefer one tool that does the whole job, or split across turns.

6. **Local-model specifics.** The Ollama adapter uses Ollama's **native
   `tool_calls`** API (works for gemma4:12b and qwen alike — no hand-rolled
   text parsing); keep reasoning/think **off** (the adapter's default). Do NOT
   use ReAct / stopword-template prompting — a thinking-capable model (gemma4
   and Qwen both have a thinking mode) can emit the stopword inside its thoughts
   and break parsing, which is the other reason think stays off.

7. **Validate + repair deterministically, don't re-reason in a loop.**
   Parse tool args against the schema in code; on an invalid call,
   the deterministic layer repairs or re-prompts at most once. Never
   let the model burn rounds guessing the shape — the schema + parser
   are the contract.

## When you add a tool (the per-slice checklist)

- Distinct verb_noun name, no overlap with an existing tool.
- ≤ a few `required` params, each with an example-bearing description
  + the tightest type/enum/range that fits.
- A "use when / not when" line in the description.
- Correct risk classification (read / write / execute) — fail-close
  for state-changing actions per `outbound-safety.md`.
- **Verify the model actually SELECTS it**: a `smoke:live` (local
  model, gemma4:12b default) round-trip that asserts the tool was called with the right
  args — not a unit test of the handler alone. A handler that works
  but is never selected is not delivered. The lean, repeatable gate
  for this is `pnpm eval:tools` (a golden prompt→expected-tool dataset
  incl. negative no-tool cases and the confusable real-tool sets) —
  add a case there when you ship a tool, and run it (with
  `MUSE_EVAL_REPEAT` for stochastic confidence) after touching any
  tool name/description/schema.

## Sources

- [Tool Calling with Local LLMs: A Practical Evaluation (Docker)](https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/)
- [Function Calling — Qwen docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html)
- [Best Local LLMs for Function Calling (InsiderLLM)](https://insiderllm.com/guides/function-calling-local-llms/)
- [Tool Calling Guide for Local LLMs (Unsloth)](https://unsloth.ai/docs/basics/tool-calling-guide-for-local-llms)

---

<!-- source: .claude/rules/verification/agent-testing.md -->

# Agent-level testing — evaluating the AGENT, not just the code

Unit tests prove a function is correct; they do **not** prove the *agent*
is good — that the model picks the right tool in one shot, abstains when
it should, and reaches the real goal state *reliably*. That is
**evaluation (evals)** — ship it with every agent-facing capability. Full
method and sources live in the strategy doc below. The dated
Muse inventory, gaps, library decisions, and implementation order live in
[`docs/development/ai-agent-testing-strategy.md`](docs/development/ai-agent-testing-strategy.md).

**Three principles, if you read nothing else:** (1) **Error-analysis
FIRST, imagination never** — evals GROW from real misses. (2)
**Deterministic code is the GATE; the LLM-judge is a DEBUGGER** — code
decides pass/fail on the safety-load path, the judge never gates a
safety claim alone. (3) **Grade OUTCOMES, `pass^k`, all-pass** — score
terminal state not the path; reliability is every repeat passing.

## The non-negotiables (every agent capability)

1. **Agent-level check, not just a unit test.** A tool the model never
   SELECTS is not delivered — prove it live (`smoke:live`), not `tsc`.
2. **Grade the terminal state, not the exact path.** Assert the resulting
   world state + final answer; pin trajectory order only where a step
   genuinely depends on a prior one.
3. **No partial side-effects.** A failed/invalid action mutates
   **nothing**, and a write never damages *unrelated* state — the
   deny/invalid-arg/tool-failure test path asserts an unchanged store.
4. **Reliability is `pass^k`, not one green run.** Run a grounding- or
   safety-critical case k times, require **all k** to pass
   (`MUSE_EVAL_REPEAT`); pre-verify a new live case STABLE 3/3. Never
   report `pass@k` ("at least once") as reliability.
5. **Security/safety is CODE, never a passing prompt.** A must-refuse battery
   proves the model refuses; the deterministic gate (injection patterns,
   approval gate) is the real protection — doubly so where refusal is
   language-asymmetric (an observed KO/EN gap) — and gets the regression test.
6. **Tool-calling and multi-agent hand-offs get their own asserts** —
   run `pnpm eval:tools` after touching any tool schema/description
   (selection is the binding constraint on an 8B model); validate every
   multi-agent hand-off against a typed schema and assert bounded,
   verification-backed termination. Full breakdown: the strategy doc.

## The layered method (cheapest grader first)

| Layer | Proves | Grader |
|---|---|---|
| Unit | a function is correct | `vitest` (deterministic) |
| Tool-calling | model SELECTS + fills the right tool in one shot | `eval:tools` (deterministic) + `smoke:live` |
| Task-completion | terminal world state reached, no collateral damage | terminal-state/trajectory tests (deterministic) |
| Multi-agent seams | hand-offs validate, loop terminates, failures surface | schema parse + bounded-step asserts |
| Production | holds on REAL traces, not fixtures | human trace-reading → new golden cases |

(1) **deterministic scorers** — selected? args present? terminal state
matches? (`toolScorers` in `eval-harness.mjs`, every case). (2)
**LLM-as-judge only for what code can't grade** — binary PASS/FAIL at
T=0 (`llmJudge`); a 1–5 rubric is an anti-pattern. (3) **Human
trace-reading, regularly** — catches a broken eval before a scorer does.

**maker ≠ judge.** One local model means the judge IS the maker, so a
safety claim is never gated by the judge alone. Compensating controls:
deterministic graders own the safety verdict; `eval:judge` meta-evaluates
the judge first; verdicts are binary and must NAME a concrete violation
("seems off" is not grounds to reject); periodic fault-injection drills
prove the judge still rejects bad work. Evidence: the strategy doc.

**Reliability discipline:** `MUSE_EVAL_REPEAT` (k=3 for local/self-hosted
reliability gates, k≥5 grounding/safety-critical), strict all-pass; T=0 is a
cheap gate, not a statistical guarantee. `eval:agent`/`eval:self-improving`
aggregate live local-Ollama batteries; they are not GitHub CI gates and a skip
is unverified. `self-eval` fails closed on regression. Error-analysis is FIRST — read
20–50 real traces before writing a scorer (Muse's "production" is n=1 dogfooding).

## Evaluation accounting vocabulary

Large synthetic corpora must keep semantic coverage separate from prompt volume.
A **semantic family** is one canonical objective/setup/expected/forbidden contract;
a **surface variant** changes factors or expression without becoming an independent
truth. Report both, and never relabel synthetic surface variants as independent
semantic cases.

Synthetic scale is not evidence quality. A **synthetic profile** shapes generated
conditions; a **journey** is an ordered state-linked sequence; a **turn** is one case
within it. Longitudinal transition coverage may be named `realismProxy.v1`, but that
proxy is neither organic usage nor proof of realistic user behavior.

Dataset accounting and agent-execution accounting are different ledgers:

- `generated = valid + invalid`; `sampled <= valid`. Generated/validated/sampled
  artifacts prove corpus integrity, **not** agent PASS.
- A **case** is one eval specification. A **trial** is one execution of a case. An
  **inference request** is one model request inside a trial; retries increase requests
  and may increase trials according to the runner contract, but never create cases.
- `pass^k` runs the same case for `k` trials and requires all `k` to pass. It increases
  trial and inference-request counts, not case, semantic-family, or surface-variant
  counts. Do not report it as `pass@k`.
- Until trials actually run, agent results remain `UNVERIFIED`/`NOT_RUN`; generated or
  validated data cannot be booked as agent passed/failed signal.
- Provenance and execution are independent axes. Immutable case `dataOrigin`
  (`synthetic | consented_trace_derived`) answers where a case came from;
  `executionEvidence` (`not_run | live_executed`) answers whether it ran. Never infer
  one from the other.
- **Controlled replay** exercises a public interface against synthetic state. It is
  not organic production evidence. `organic` authority is minted only by the
  production composition root; `unclassified` is fail-closed. A factual interaction
  receipt is not outcome feedback and cannot promote policy.

Every report names the ledger explicitly: semantic families, surface variants,
synthetic profiles/journeys/turns, immutable `dataOrigin`, independent
`executionEvidence`, controlled replay/organic evidence, generated/valid/invalid/sampled
cases, executed cases, trials, inference requests, and agent passed/failed/unverified.
Consented trace-derived promotion requires explicit consent and privacy validation;
live-executed organic evidence requires actual production execution. Reconciliation
identities are fail-closed.

## Where each gate lives (Muse mapping)

| Concern | Muse gate |
|---|---|
| Tool selection + args + irrelevance | `pnpm eval:tools` |
| Terminal-state / trajectory (deterministic) | `*-terminal-state.test.ts`, `*-trajectory.test.ts` (agent-core) |
| Plan quality (valid∧complete∧ordered∧efficient) | `pnpm eval:plan-quality` |
| LLM-judge + its meta-eval | `pnpm eval:judge` |
| Must-refuse + over-refusal controls | `pnpm eval:adversarial` |
| Memory/playbook promotion (report-only) | `pnpm eval:shadow-trial` |
| Self-improving LLM paths (one gate) | `pnpm eval:self-improving` |
| All harness batteries as one local/self-hosted aggregate | `pnpm eval:agent` |
| Real-LLM request/response round-trip | `pnpm smoke:live` |
| Regression scoreboard | `pnpm self-eval` |

**Anti-patterns (reject on sight):** skip-as-pass; vacuous stub (confirm
with MUTATION-RED); floor instead of ratchet (fail close on a DROP, not
just clearing a floor); counting code artifacts as agent signal;
`pass@k` reported as reliability; trajectory pinning over terminal-state
grading; same-family judge over-trust. Full rationale: the strategy doc.

Method and sources in full — the evidence behind every rule above, the named
anti-patterns, the multi-agent seam breakdown, and the reflection-schedule guard's
calibration data: [`ai-agent-testing-strategy.md`](docs/development/ai-agent-testing-strategy.md).

---

<!-- source: .claude/rules/verification/self-eval.md -->

# Self-eval scoreboard — the loop's fitness signal

`pnpm self-eval` aggregates the deterministic gates into ONE persisted
scoreboard so the autonomous loop can measure whether the system is
improving or regressing over time, instead of only verifying each change
in isolation. This is the "self-development" feedback signal.

```bash
pnpm self-eval          # quick: lint + capabilities-drift + test-file & capability counts
pnpm self-eval -- --full   # also runs the whole test suite (slow)
pnpm self-eval:test     # node:test for the pure helpers (zero deps, no Ollama)
```

## What it records

A timestamped entry appended to `docs/self-eval-scoreboard.json` (local,
gitignored — the trend lives on disk across loop fires; it is rebuildable
and deliberately NOT committed so parallel loops don't churn/conflict on
it). Each entry holds the gate results:

- `lint` — `pnpm lint` exit (pass/fail)
- `capabilities` — `pnpm check:capabilities` drift guard (pass/fail)
- `testFiles` — count of `*.test.ts(x)` across `packages/` + `apps/` (numeric)
- `verifiedCapabilities` — lines in a CAPABILITIES ledger under `internal/goals/` citing a real
  proof (numeric). **Conditional**: emitted ONLY when that ledger exists — it
  was intentionally removed (f4c195df) so the agent discovers work itself, and a
  missing file would otherwise read as a permanent `→0` regression every run. The
  count auto-resumes if a ledger is restored.
- `tests` — full suite pass/fail (only with `--full`)

## Declaring an intentional drop

Subtraction is first-class work, but every tracked number ratchets against its high-water
mark — so deleting a dead test would otherwise make the next ORIENT permanently red. Declare
it in the commit body: `[ratchet: testFiles -3]`. The declaration lives in git history where
a reviewer can check it against the diff, it is per-gate, and a drop LARGER than declared is
still a regression that names both numbers. It never excuses a `pass→fail` gate.

The accepted drop is written onto the scoreboard entry (`ratchetReset`) so the gate's
high-water mark restarts there. Without that the declaration cured nothing: it is read from
the LATEST commit, so the peak returned the moment HEAD advanced past it.

## Fail-close on regression

Exit 1 when any gate fails OR a previously-passing gate now fails OR a
tracked count drops vs. the previous entry. So "regression-first" is
mechanical: the loop runs `pnpm self-eval` at the TOP of a fire and, if it
exits non-zero, **fixing that regression is the whole iteration** — before
any new capability.

## Scope (honest bounds)

This is INFRA, not an outward capability — it is built by human direction,
never as a loop iteration (the loop is outward-only). It measures progress
under the fixed guardrails; it does NOT let the loop rewrite its own goals
or honesty machinery (`IMMUTABLE-CORE` + `guard-immutable.mjs` still
apply). Self-development here = measured capability gain inside the gates,
not unbounded self-modification.

---

<!-- source: .claude/rules/verification/testing.md -->

# Testing & verification

Tests are the only form of verification. New behavior gets the
narrowest useful test first — direct unit test before integration
test before HTTP smoke.

This file is the **gate list** (which command proves what). For HOW to
test Muse as an *agent* — grade outcomes not paths, `pass^k`
reliability, tool-calling + irrelevance, multi-agent hand-off asserts,
binary LLM-judge — see [`agent-testing.md`](.claude/rules/verification/agent-testing.md) (the method).

## Verification gates (cheapest first)

1. **Single-package narrow check** while developing:
   ```bash
   pnpm --filter @muse/<name> test
   ```
2. **Full check** before commit:
   ```bash
   pnpm check                         # build + test for every workspace
   ```
3. **Diagnostic-provider HTTP smoke** (broad endpoint sweep, no API key):
   ```bash
   pnpm smoke:broad
   ```
4. **Live-LLM HTTP smoke** (real LLM round-trip):
   ```bash
   pnpm smoke:live
   ```
   **LOCAL OLLAMA ONLY by policy** — probes
   `${OLLAMA_BASE_URL:-http://localhost:11434}` and uses the local
   default model (gemma4:12b). Cloud APIs (GEMINI/ANTHROPIC/OPENAI) are
   never used; do not re-add them. Skips only if local Ollama is
   unreachable, and a skip is **not** a substitute for the round-trip —
   fixing the environment so it runs is itself priority work.
5. **Tool-selection reliability gate** (local one-shot tool choice):
   ```bash
   pnpm eval:tools
   ```
   A golden dataset (synthetic capabilities + Muse's REAL built-in
   tools + the confusable time-tool set) run straight against the
   local model and scored against a threshold (85% default). This is
   the lean, repeatable check for `tool-calling.md`'s first-class
   concern — the model picking the right tool in ONE shot — between
   static schema tests and the heavy `smoke:live`. **LOCAL OLLAMA
   ONLY**; skips (exit 0) when Ollama is unreachable. Run it after
   touching tool names/descriptions/schemas, the projection layer, or
   the Ollama adapter.
6. **Self-improving regression gate** (the 4 LLM live batteries as one):
   ```bash
   pnpm eval:self-improving
   ```
   Runs `verify-pattern-suggestion` (③), `verify-preference-inference`
   (②), `verify-skill-merge` + `verify-playbook-merge` (①) against the
   local Qwen in one pass and fails if ANY regresses — so the
   self-improving slices can't silently rot between individual battery
   runs. **LOCAL OLLAMA ONLY**; skips (exit 0) when Ollama is
   unreachable (a skip is not a pass). Run it after touching any of
   those LLM paths (pattern synthesis, preference inference, skill /
   playbook merge) or their prompts.
7. **Agent-eval gate** (the harness-based agent batteries as one):
   ```bash
   pnpm eval:agent
   ```
   Runs every battery in the `CAPABILITY_MATRIX` registry of
   `scripts/eval-agent.mjs` in one pass and fails if ANY required one
   regresses. **That registry is the authority — read it rather than a
   copy here**, because a hand-maintained list drifts (it did: this gate
   named `eval:judge` and `eval:shadow-trial`, which `eval-agent.mjs`
   never calls, and omitted six batteries it does). **LOCAL OLLAMA ONLY**;
   each battery skips (exit 0) when Ollama is unreachable. Run after
   touching tool names/descriptions/schemas, the eval harness, or any
   battery's cases.
8. **Grounded-vision gate** (image → grounded extraction → routed action):
   ```bash
   pnpm eval:vision
   ```
   Feeds checked-in document fixtures (`apps/cli/scripts/fixtures/vision/`:
   receipt / flyer / business card) to the multimodal default (gemma4) and
   asserts each routes to the right draft-first action with the key fields
   extracted (`muse ask --image --auto`). **LOCAL OLLAMA ONLY**; skips
   (exit 0) when Ollama is unreachable. Run after touching the vision
   extraction primitive, the `--auto`/`--extract` routing, or the Ollama
   image path.
9. **Lint gate**:
   ```bash
   pnpm lint
   ```
   ESLint flat config; every rule it sets is at `error`
   ([code-style](.claude/rules/engineering/code-style.md) owns the rule list).
   New violations block exit-0.

## `MUSE_REQUIRE_LIVE=1` — a skip is not a pass

Live batteries exit 0 when Ollama or Chrome is missing, and print the reason. An unattended
fire reads the aggregate, not the prose, so a box with no model made every live gate green.
Set `MUSE_REQUIRE_LIVE=1` in any autonomous context: `pnpm eval:agent` then FAILS the
capability instead of recording it `unverified`, and `pnpm eval:self-improving` classifies
the battery as a failure. Off by default so an interactive run on a laptop without Ollama
still works.

`eval-skip.mjs` also exports `skipExitCode` (0 normally, 75 = `EX_TEMPFAIL` under the flag)
for a battery that wants to signal a skip through its own exit code. **No battery calls it
yet** — the aggregates above are where the flag currently bites.

## Test placement

- Unit tests for policy, trimming, message pairing, capability logic.
- Contract tests per model provider adapter (mocked fetch).
- Integration tests for API run lifecycle and approval flows.
- CLI smoke tests for config, auth, local run, remote run.
- Playwright for UI flows.
- Testcontainers for PostgreSQL query behavior.
- Direct unit tests for every export of every helper module — no implicit-only coverage.
- Factual agent evidence and user judgments are separate test dimensions. For
  Continuity, prove exact source/event binding and unchanged bytes on rejected
  or replayed interaction receipts; never assert that task completion implies
  `used`, feedback coverage, permission, or promotion.

## Which runner

- **Vitest** is the TypeScript runner. `node:test` is only for dependency-free
  `scripts/*.mjs`.
- **`*.browser.test.tsx`** (Vitest Browser Mode + Playwright) for React focus,
  keyboard, hooks and DOM events; static markup contracts stay in fast Node tests.
- Everything else about the stack — when property-based testing is warranted, when
  MSW earns its place over an injected fetch fake, and why the `forks` pool and
  worker count are not to be changed without an A/B — is decided in
  [`testing-strategy.md`](docs/development/testing-strategy.md), which owns
  the measurements. Do not restate its numbers here; they drifted once already.

## Run only the narrowest test that proves THIS change (Jinan, 2026-06-22)

Running hundreds/thousands of tests "to be safe" is noise — Muse has
**thousands of `*.test.ts(x)` files across `packages/` + `apps/`** (`pnpm self-eval`
prints the live count; do not hand-copy a number here — three different
counts of it have already disagreed). The count is healthy; running ALL of
it per edit is the waste. A full package suite per edit proves nothing
about the specific change and only saturates the machine. Run the tests
**vitest decides are RELATED to the files you changed** and nothing more:

```bash
pnpm test:changed                 # ★ DEFAULT per-edit gate: git-changed files → vitest related (the tests whose module graph touches them), per affected package
pnpm test:changed --uncommitted   # tighter inner loop: uncommitted changes only
pnpm --filter @muse/<pkg> test -- <file>        # one explicit file
pnpm --filter @muse/<pkg> test -- -t "<name>"   # one test by name
```

`pnpm test:changed` (scripts/test-changed.mjs) is the operationalized form
of this rule — it uses vitest's `related` (Vite module-graph dependency
tracking) so editing a leaf file runs a handful of tests, editing a central
one runs more, and a clean tree runs nothing. Reach for it FIRST.

- Don't run a whole package suite, the whole repo, or `pnpm check` (full
  workspace build+test) for a small change. `pnpm check` is a pre-merge /
  human gate, NOT a per-edit step — autonomous loops especially must use
  narrow per-package filters, never `pnpm check`.
- Build only the package(s) you touched (`tsc -b` resolves stale upstream).
- The gate ladder above still applies, but pick the **single rung that
  exposes your change** — not every rung.

## Verify UI/web changes in a real browser (Jinan, 2026-06-22)

The macOS desktop app renders the bundled `apps/web` in a WKWebView, so a
web layout change *is* a desktop-app change. CSS layout bugs (scroll,
overflow, element sizing) do NOT show up in `vitest` — they only appear in
a real render. After any `apps/web` UI/layout change:

1. `pnpm --filter @muse/web build`, serve `dist` on a local port.
2. Drive it with the Playwright MCP (`mcp__plugin_playwright_playwright__*`)
   and **measure** — a headless browser is a sufficient proxy for the
   WKWebView (WebKit) render.
3. Assert numbers, not vibes: the changed view's `.content` is bounded to
   the viewport and `scrollTop > 0` after a tall probe; no container
   overgrows the viewport; icons/images render at their intended size.

Recurring scroll/blowout regression classes to check first: missing
`html, body { height: 100% }` (breaks the `%`-height chain), a grid row
left at `auto` instead of `minmax(0, 1fr)`, a flex child without
`min-height: 0`, and viewBox-only SVGs with no intrinsic/CSS size (fall
back to ~300×150 and blow up the layout).

## Anti-patterns

- Don't replace a real test with a comment.
- Don't disable a failing test to ship.
- Don't skip the verification gate above the cheapest one that exposes the change you made.
- Don't claim "tested" when the only thing that ran was `tsc`.
- Don't accept fall-back assertions on tool-using flows — assert the tool was actually called.
- Don't run the full suite / `pnpm check` for a small change; run the narrowest related test.
- Don't claim a UI/layout fix works without a real-browser measurement.

The decision table, TS7 compatibility audit, performance measurements, and
official sources behind these rules live in
[`docs/development/testing-strategy.md`](docs/development/testing-strategy.md).

<!-- END GENERATED -->
