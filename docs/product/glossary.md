---
title: Muse glossary
audience: [AI agents, developers, product]
purpose: One definition per Muse-specific term, so a new agent understands without grepping
updated: 2026-07-30
related: [../strategy/attunement.md, ../design/attunement/attunegraph.md, SYSTEM-MAP.md, ../trust/grounding-gate.md]
---

# Muse glossary

Definitions for the **Muse-specific terms** that recur across the docs, code and commits.
For the architecture-grade register — the same domain language stated as invariants, plus the
one-way dependency direction between modules — see [`CONTEXT.md`](../../CONTEXT.md); this file is
the plain-English entry point, that one is the precise one. Generic
terms (RAG, embedding …) are left out; this collects only what carries *a particular meaning inside
Muse*. Each entry is one definition plus where it lives. Exact verification evidence is in the
[evidence index](../benchmarks/EVIDENCE.md); the end-to-end flow is in
[grounding-gate](../trust/grounding-gate.md).

## 1. Identity — what Muse is

- **Attunement** — the product direction: not just memorising facts about you, but learning how to
  fit help into your life, improving from outcomes about when to stay quiet and what kind of help
  lands. The full loop is **roadmap**.
- **Shadow Muse** — the **roadmap** layer that learns timing by recording `silent|digest|offer`
  candidates, their evidence, bounded counterfactuals and your actual return, all before it ever
  interrupts or acts.
- **Continuity Capsule** — the richer product form of today's Continuity Pack: the stopping point,
  what changed since, the exact evidence, the next step, prepared work and expected time, in one
  view. A shipped explicit Chat slice now invokes the assembly-owned preparation service only
  after the owner selects Prepare. The assembled host keeps a bounded durable-local comparison
  baseline with at most 16 entries, allowing a fresh process to compare with an earlier
  observation; direct library or test construction without a baseline store uses a process-local
  fallback. When no earlier baseline exists it reports a truthful seeded state, and otherwise shows
  a closed English/Korean display card. It verifies citation membership for current
  task/note/reminder evidence and exposes timing, freshness, entailment, and action caveats. Exact
  stop capture, current freshness, all-source parity, authenticated evidence witness, automatic
  timing/surfacing, semantic entailment, and organic usefulness remain **roadmap**.
- **Policy Card** — the surface that shows how Muse proposes to change the way it works with this
  person, with evidence and scope. An authenticated owner-taught product UI and the lower-level
  tool can now render one inert AttuneGraph-backed preview for an exact organic opportunity;
  automatic surfacing, usefulness qualification, and trusted trial, edit, reject, apply, and
  rollback controls remain **roadmap**.
- **AttuneGraph** — the official name for the standalone open-source agent-native graph product Muse
  consumes and dogfoods. It does not replace existing personal stores; it
  links time, relationships, provenance, change, return and policy, and compiles only the relations
  one turn needs into a Working Graph. Its neutral engine package is `@attunegraph/core`;
  Muse-specific composition lives in `@muse/attunegraph`.
- **AttuneGraph Engine** — the execution layer combining AttuneGraph's ontology, receipt projection,
  temporal/relationship indexes, bounded operators, completeness/abstention and the Working Graph
  compiler.
- **Decision Query** — the shipped fixed-profile `decision-query@1` boundary that compiles one
  exact/current-head, fresh-source, token-bounded evidence frontier. Its receipt is evidence-only;
  `complete` means the fixed traversal completed, not that an action is authorized or every conflict
  is closed. Muse's fresh Continuity resume path uses its witness as a membership boundary for
  current change/support context and cross-binds it to a separate stricter Muse proof receipt.
- **AttuneQL** — the bounded textual spelling of the same Decision Query. It lets an agent name the
  seed, scope, time, head posture and budget, but exposes no arbitrary predicates, joins, traversal,
  analytics or writes. Text and typed objects normalize to the same canonical query.
- **AttuneGraph Store** — the engine's embedded persistence layer, with `node:sqlite`
  selected as the default physical store and synchronous work isolated from the application
  thread. PostgreSQL is an optional future adapter; an external graph DB, Redis and MySQL are
  not required.
- **AttuneGraph Source Adapter** — a replaceable module that reads an authoritative source and produces
  bounded observations with exact identity. Markdown/Obsidian/Notion adapters are planned source
  connections, not AttuneGraph Stores. The existing Markdown notes and Notion providers do **not** mean a
  AttuneGraph round-trip adapter is finished.
- **Receipt** — input evidence binding a point-in-time source observation, decision or interaction
  into a bounded immutable envelope with a content ID. A receipt is not itself a graph DB; AttuneGraph
  projects verified receipts into nodes and relations of the Evidence Graph.
- **Evidence Graph** — the long-lived layer of facts, time, provenance and relationships,
  regenerable from receipts and authoritative sources.
- **Working Graph** — the short-lived layer compiled out of the Evidence Graph, within a token
  budget, for one agent decision. Not the whole personal graph, not chain-of-thought, and not by
  itself proof of permission or conflict closure.
- **Activation Subgraph** — the short-lived graph handed to the agent carrying only the current
  thread, changes, evidence, policy and authority boundary within the token budget. Not the whole
  personal graph, and not chain-of-thought.
- **Observe** — the screens and commands that let you see what is being collected, pause it, inspect
  it and delete it (**roadmap**). Keystrokes and continuous screen recording are not default
  collection targets.
- **Personal Rhythm Model** — a summary of life and work flow built from minimal records such as
  time spent in an app and activity transitions (**roadmap**). Not a model that diagnoses
  personality or psychology.
- **Friction Discovery** — the step that surfaces candidates for where work keeps breaking, with
  evidence, and lets the user correct whether it was "normal flow", "exploration" or "stuck"
  (**roadmap**).
- **Intervention outcome / adaptation** — recording whether help was used, adjusted or rejected, and
  changing only the timing and shape of the next help (**roadmap**). It never widens authority or
  collection scope.
- **Personal Continuity** — the first user experience: preparing the relevant memory and the single
  next step for an unfinished thread the user picked (**roadmap**). It can cover work, schedule and
  life planning alike.
- **Muse Work / Work Resumption** — Personal Continuity used in a work-specialised mode. It does not
  mean Muse as a whole is a work assistant, nor that it automates the whole computer.
- **Deployment-flexible** — local, self-hosted and cloud providers sit behind the same adapter
  boundary, and the user explicitly chooses where storage and processing happen. It does not imply
  sync or hosted storage, neither of which is implemented.
- **Local-only mode** — a strong privacy posture the user selects, not Muse's product identity. An
  "always local" guarantee is claimed only when `MUSE_LOCAL_ONLY=true` is in use.
- **MUSE_LOCAL_ONLY** — the fail-close policy flag for cloud egress. When on, the model router
  throws `LocalOnlyViolationError` *before* instantiating a cloud provider. Voice and embeddings are
  forced local too.
- **Provider-neutral / model-agnostic** — `agent-core` never calls a vendor SDK directly, only
  Muse's own `ModelProvider` abstraction. Vendor code lives at the edge, in
  `packages/model/adapters/*`.
- **Grounding floor** — the trust floor on supported paths that use personal evidence: verify the
  real source, downgrade weak evidence, reject invalid citations. It does not mean every free-form
  chat sentence is verified.
- **fabrication = 0 (a battery metric)** — the release metric that a specific grounding evaluation
  battery must emit zero unsupported outputs. Not a universal no-hallucination guarantee across the
  product and every chat sentence.

## 2. Grounding and recall — the trust floor

The full flow is in [grounding-gate.md](../trust/grounding-gate.md); this section is terms only.

- **Grounding gate** — `verifyGrounding` in `packages/agent-core/src/grounding-verifier.ts` (re-exported
  through `knowledge-recall.ts`; called from `recall-verdict.ts` and `chat-answer-gate.ts`), which takes an answer plus its evidence and returns a deterministic
  three-way verdict with no model call. The trust floor that stops
  Attunement inventing hypotheses about a person.
- **Three-way verdict** — **grounded** (enough evidence) / **weak** (only weakly supported → "I'm
  not sure") / **ungrounded** (no evidence, forged citation, or a claim beyond the evidence →
  dropped). Evaluated in fail-close order.
- **Four-criterion rubric** — the inputs to the verdict: `confidence` (retrieval cosine confidence, CRAG-style,
  `DEFAULT_CONFIDENT_AT = 0.55` in `recall-confidence.ts`) · `coverage` (share of answer tokens present in the evidence, floor 0.5) ·
  `answerability` (share of question tokens the evidence covers, floor 0.34) · `citationValidity`
  (whether cited sources were actually retrieved — one forged citation means ungrounded).
- **Citation (receipt)** — the *actual source* an answer points at. If a citation does not resolve
  to a retrieval result (forged), the gate drops the answer. This is the source receipt the user
  sees.
- **grounded ≠ true** — the gate checks *claim against source*, not whether the source is true. So a
  poisoned note, episode or MCP result can produce a "confident grounded lie" → the `untrustedOnly`
  marker warns when an answer rests solely on `trusted:false` (external MCP/web) sources. A known
  limit, actively defended.
- **Recall** — semantic search across the note and episode indexes (`muse recall`). `--expand`
  (1-hop wiki-link GraphRAG), `--adaptive` (marginal-value stopping rule).
- **Knowledge corpus** — per question, notes + tasks + calendar + contacts + mail + reminders +
  episodes + memory fused into one ranked corpus (`assembleKnowledgeCorpus`). Every chunk carries a
  source tag (`task/<id>` …). Opt-in.

## 3. Memory — long and short term

- **User memory** — the persistent personal model (`~/.muse/user-memory.json`), with separate
  namespaces for facts and preferences. An LLM hook extracts automatically on every chat turn
  (**on by default**), and model-invented values are removed by `dropModelAssertedValues`.
- **Typed user model** — richer typed slots than flat memory (preferences, schedule, vetoes, goals).
  *Inferred* slots carry a confidence and decay on a half-life (30 days by default); *asserted* slots
  (typed by the user) and vetoes are never decay-dropped.
- **Episode / episodic memory** — a summary of a past session. Recorded automatically when the REPL
  exits, but `MUSE_EPISODIC_MEMORY_ENABLED` is **off by default** (it is the substrate for
  reflection, themes and dreaming).
- **Reflection** — higher-level insight the LLM synthesises across episodes. Each insight *cites the
  episode IDs it rests on* and goes through **RGV reverification** (a one-shot judgement of whether
  it matches the cited episode text) so confabulation is dropped.
- **Dreaming** — recall-usefulness promotion (`memory promote`): memories used often and recently
  become always-on persona.
- **Sleep consolidation** — `memory consolidate`: promote salient memories, demote fading ones,
  **never delete**.

## 4. Self-improvement — the third pillar

(Self-learning distill/author is **off by default** — `muse learned` shows the env var that enables
it.)

- **Whetstone** — README principle 3. The weakness ledger recording what Muse *could not answer or
  did not actually do* (`~/.muse/weaknesses.json`). Inspect with `muse doctor --weaknesses`
  (verified working on real data).
- **Weakness ledger** — Whetstone's store, and the input to its four stages: monitor → detect →
  classify → remediate.
- **Playbook** — *strategy* memory learned from past feedback. Reward = `reinforcements − decays`.
  **Asymmetric credit**: DECAY demands a stronger cue↔strategy match (0.62) than reinforcement does,
  because wrongly decaying a grounded or manual strategy costs more.
- **Correction-decay (SUBTRACTIVE)** — a correction decays an injected strategy only when it
  *genuinely contradicts* the stored one (LLM polarity gate `classifyCorrectionContradiction`). If
  that cannot be confirmed, nothing happens (conservative).
- **Skill authoring** — distilling a reusable skill from the procedural corrections in the last chat.
  An authored skill is **execution-gated** (it cannot run until a human promotes it) and every body
  passes `scanSkillBodyForRisks` (injection, dangerous shell, secrets); anything caught is
  **quarantined** (the OpenClaw pattern, MIT, deterministically re-implemented).
- **RGV (Rubric-Gated grounding Verifier)** — the grounding verifier evolved past a single cosine
  into the four-criterion rubric. Reused for reflection and answer verification.

## 5. Proactivity and outbound safety

- **Proactivity / earned** — the delivery substrate for Muse speaking first. "Earned" is not a
  heuristic but a *fail-close gate*: a proactive notification goes out only after passing
  ratchet-backed eligibility.
- **Daemon** — the opt-in background process that runs reflection (dreaming), check-ins and
  follow-ups while idle.
- **Objectives / consent / scope** — standing objectives the user delegates. Acting toward a third
  party requires *recorded scoped consent* (`performConsentedAction`); absent or scope-mismatched
  consent fails closed.
- **Outbound safety** — the fail-close contract for anything sent to, or done to, a third party.
  Details in [outbound-safety.md](../../.claude/rules/safety/outbound-safety.md).
- **Draft-first** — generated content never reaches a third party until *the user explicitly
  confirms that content*. No autonomous sends. Banking and transfers are permanently out of scope.
- **Action log / hash chain** — the tamper-evident chain every autonomous action (sent **or**
  refused) is appended to with its rationale. Subject to undo, veto and learned avoidance.
- **fail-close vs fail-open** — **guards fail close** (refuse when uncertain); **hooks fail open**
  (an auxiliary feature failing must not block the flow). Security is deterministic code, not a
  polite request in a prompt.

## 6. Runtime and architecture

- **agent-core** — the model-agnostic core runtime. CLI and server share the *same* `agent-core`, so
  behaviour never forks.
- **ModelProvider** — Muse's own model abstraction interface (capabilities: streaming, toolCalling,
  vision …), which each provider (OpenAI, Anthropic, Ollama …) adapts to. Without native tool
  calling it falls back to a text protocol.
- **runner** — the separate Rust process (`crates/runner`) that risky local execution goes through.
- **MCP loopback** — local-only MCP servers (notes, fetch, fs, search …) managed by `McpManager`.
  External MCP must pass the allowlist.
- **Tool risk level / approval gate** — tools are classified read/write/execute. State-changing calls
  go through a fail-close approval gate (`createChannelApprovalGate` / `toolApprovalGate`).
- **Council / orchestration modes** — multi-agent orchestration: `sequential`, `parallel`, `race`.
  **Race is parked as of 2026-06**: on a single local GPU "take whichever finishes first" is fiction
  because Ollama serialises workers → falls back to sequential.
- **Model tiering** — a cost lever for *the agents driving the development loop* (routine = Sonnet,
  scout/judge = Opus). Unrelated to Muse's product runtime model (gemma4), which is fixed.

## 7. Verification gates

- **self-eval** — aggregates the deterministic gates (lint, capabilities drift, test counts …) into
  one scoreboard. Fails closed on regression.
- **eval:\*** — agent-level live batteries (`eval:tools`, `eval:agent`, `eval:self-improving`,
  `eval:adversarial` …). Most need local Ollama and skip without it (a skip is not a pass).
- **smoke:broad / smoke:live** — broad is an HTTP sweep against the diagnostic provider (no key);
  live is a real LLM round-trip (**local Ollama only**, gemma4).
- **precheck:grounding** — the pre-push tripwire for the fabrication-critical battery (the grounding
  ratchet).
- **pass^k** — reliability for a stochastic agent: run one case k times and require *all* of them to
  pass (one green run is not proof).
