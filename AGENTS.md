# Muse

A provider-neutral personal AI conductor for **one user, one private control plane, no shared
workspace**. One coherent reasoning loop across local, self-hosted, and cloud deployment choices;
provider-specific code stays at the edges. Local-only is an explicit fail-close privacy posture,
not the product identity.

This file is the cross-agent product brief (the open `AGENTS.md` standard), and it carries the
binding contract rather than pointing at it. `CLAUDE.md` and `.claude/rules/` are auto-loaded for
Claude Code and for nothing else, so they are projected here — inlined where a breach is
irreversible, and in [`.agents/skills/`](.agents/skills/) otherwise. The generated block below
explains both halves and lists every skill.

**Check you received all of it.** Codex truncates a project doc at `project_doc_max_bytes` and
says nothing. This file is sized to fit the 32 KiB default, and [`.codex/config.toml`](.codex/config.toml)
raises the budget further once the repo is TRUSTED — but the last line of this file is an
`END OF AGENTS.md` comment, so if your copy stops anywhere else you were truncated: read
`CLAUDE.md` and `.claude/rules/safety/outbound-safety.md` directly before doing anything.

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
push faces the same checks whichever agent produced it, and whether or not it read a line of this.

## The one thing you cannot run

`.claude/agents/independent-evaluator.md` is a subagent Claude Code spawns in a separate context.
You cannot spawn it, and the requirement does not soften: the harness contract makes an independent
evaluator unconditional on the surfaces listed there, and the commit-msg hook rejects those diffs
unless the body records `review-tier: independent-evaluator`. **Get the separation a different way
— start a second, fresh `codex exec` session**, give it the acceptance criteria, and tell it to
judge and not to fix. A new invocation is a new context, which is what maker ≠ judge asks for.
Never grade work in the session that built it. If separation is genuinely impossible, use the
contract's own escape: record `unseparated self-evaluation`, do not claim PASS, and stop for human
review.

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
- **Never skip the versioned hooks.** `MUSE_SKIP_PREPUSH_ALL=1` disables even the compile gate;
  it is for a genuine emergency the owner asked for, never for getting a push through.
- **A scheduled or autonomous loop keeps its declared Tier.** If its Tier forbids pushing, that
  holds until the owner separately opts in — the standing push authorization does not reach it.
- **`MUSE_LOCAL_ONLY=true` is enforced in code, not in a prompt.** Under it, a cloud provider
  throws rather than silently degrading.
- **Never commit live credentials, and never write one to disk in plaintext** — the OS keychain
  or the encrypted auth store, never a config file or a log line.

<!-- BEGIN GENERATED — `pnpm agents:build`. Edit the source files, never this block. -->

# The contract — reproduced because you are not Claude Code

The files below are reproduced verbatim, which means they still address the reader they were
written for. **Where an inlined file says `.claude/rules/` is auto-loaded, or cites a rule by
its `.claude/rules/...` path, read that as the matching skill below** — for you those rules
are on-demand, not automatic, and the path is where the skill's text comes from rather than
somewhere you must go.

Everything down to the closing marker is generated by `scripts/build-agents-md.mjs` — edit the
source file, then run `pnpm agents:build`. The pre-push hook fails if it is stale.

## The rest of the rules — skills in `.agents/skills/`

Each is a rule file, verbatim, behind a description that says when it applies. An agent that
resolves the open agent-skills standard is given every name and description at session start
and loads the body when one matches; any other agent opens the path directly. They are not
optional reading material — they are the same contract, indexed by task.

| Skill | Read it before |
| --- | --- |
| [`muse-harness-contract`](.agents/skills/muse-harness-contract/SKILL.md) | any non-trivial multi-step work — risk tiers, maker ≠ judge, the fail-closed gates |
| [`muse-testing`](.agents/skills/muse-testing/SKILL.md) | writing or running a test, or choosing which gate proves a change |
| [`muse-agent-evaluation`](.agents/skills/muse-agent-evaluation/SKILL.md) | grading the agent itself — tool selection, `pass^k`, judges, the scoreboard |
| [`muse-commit-and-push`](.agents/skills/muse-commit-and-push/SKILL.md) | committing, pushing, or creating and removing a worktree |
| [`muse-architecture`](.agents/skills/muse-architecture/SKILL.md) | adding a package, a provider adapter, a database call, or a project reference |
| [`muse-tool-design`](.agents/skills/muse-tool-design/SKILL.md) | adding or reshaping a tool the local model must select in one shot |
| [`muse-code-style`](.agents/skills/muse-code-style/SKILL.md) | writing source — the lint rules that are errors, and the comment policy |
| [`muse-codegraph`](.agents/skills/muse-codegraph/SKILL.md) | searching for a symbol, instead of reaching for grep |
| [`muse-cli-surface`](.agents/skills/muse-cli-surface/SKILL.md) | adding or changing a `muse` CLI command |

The same directory carries this repo's hand-written workflow skills too, projected from
`.claude/skills/` by the same build:

`grow-muse`, `improve-muse`, `loop-creator`, `muse-dev-patterns`, `release`, `scout-rivals`.

## Inlined here, in full

- [`CLAUDE.md`](CLAUDE.md)
- [`.claude/rules/safety/outbound-safety.md`](.claude/rules/safety/outbound-safety.md)

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

<!-- END GENERATED -->

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
- [`.agents/skills/`](.agents/skills/) — the rest of the binding rules, listed in the block above.
- [`CHANGELOG.md`](CHANGELOG.md) — running development log (Keep a Changelog format).
- [`docs/design/`](docs/design/) — multi-iteration design docs.

<!-- END OF AGENTS.md — if this line is missing, your copy was truncated. -->
