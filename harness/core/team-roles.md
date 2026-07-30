---
title: Agent Team Roles
audience: [planners, developers, AI agents]
purpose: Define the team's roles, boundaries, and handoffs in one place, so any agent that joins works the same way
status: draft
updated: 2026-06-13
sources_basis: [Anthropic building-effective-agents, Anthropic multi-agent research system, Anthropic 3-agent harness (InfoQ 2026-04), Addy Osmani — Code Agent Orchestra, Cognition multi-agents-working 2026-04 (clean-context reviewer)]
related: [team-roles.md, ../README.md]
---

# Agent Team Roles

> **What is this document?** The first piece of the harness: it defines the team's roles,
> boundaries, and exchange rules so that **whichever AI agent is put on the work collaborates the
> same way**. Vendor-neutral role definitions, bound to no specific model, tool, or framework — a
> new agent knows its place by reading this document alone.
>
> Basis: as of May 2026, only patterns on which Anthropic (building-effective-agents · multi-agent
> research system · 3-agent harness) and Addy Osmani (Code Agent Orchestra) **converge**. Sources
> at the end.

## 0. Two big principles (internalize these first)

- **Start simple.** If one agent suffices, do not build a team. Multiple agents use roughly
  **15× the tokens** of a single agent, so use them only where the work justifies the cost — when
  parallelization pays off heavily, the work does not fit one context, or many complex tools are
  involved. (How eagerly a given model delegates also differs — see the model-calibration section
  in [AGENTS.md §7](../AGENTS.md) for the current per-model delegation posture.)
- **Verification is the bottleneck.** The choke point now is not "making it" but "confirming it is
  right". So the core of the team structure is **separating the maker role from the judging role**
  (agents always grade their own work generously).
- **When results must interlock, a single thread wins (the counter-principle).** Parallel workers
  who **cannot see each other's full context** work under conflicting implicit assumptions, and
  merging at the end still yields mismatched results (e.g. one draws the bird, another the
  background — styles and rules disagree). So **work whose outputs must be mutually consistent is
  not split**; run it as one thread of context, and when the context gets too long, **compact**
  instead of splitting. Multi-agent is safe for **read-only parallelism** (information gathering,
  research — work that does not collide); the moment conflicting writes/decisions appear, prefer a
  single thread.
  - **2026 evolution (map-reduce-and-manage):** Cognition too pivoted to "Devin manages Devin",
    but the core stands — **keep writes (state changes) on a single thread**; extra agents add
    **intelligence, not action** (a manager decomposes → children execute in isolation → the
    manager synthesizes and reports). Parallelism for reads, exploration, and judging; converging
    writes go to one place.

## 1. Core roles — 2 mandatory + optional

The contract requires **exactly two roles**. The rest are **inline fields** filled by the
orchestrator/worker, or **optional roles** spawned as separate instances only for L-size or
security-grade slices. Blurred roles create coordination cost and debugging hell, so the boundary
between the two mandatory roles is held absolutely tight.

### Mandatory — worker · independent evaluator

- **Worker (builder)** — actually builds the delegated goal, **one thing at a time**. It treats
  the WHAT+WHY+acceptance criteria received at delegation (see "inline fields" below) as its plan,
  and produces better results the narrower its file scope. In a single session without an
  orchestrator, this role also covers delegation and planning.
- **Independent evaluator** — judges the built result in a **different instance** (the
  harness-evaluator subagent, or at minimum a fresh session with zero build-conversation history).
  **Maker ≠ judge is never compromised** — a self-graded PASS is void; if separation is truly
  impossible, record "unseparated self-evaluation" and request human review. A FAIL verdict names
  the concrete violation (which criterion, which input, what went wrong).

### Inline fields (planner and curator are not roles — they are content written in these two places)

- **Planner role → the header, before delegation.** No separate planner pass: the delegating side
  (orchestrator, or the worker itself) writes **WHAT + WHY + acceptance criteria** in the handoff
  header before starting ([handoff-template](handoff-template.md)).
- **Curator role → the commit body, after completion.** What worked, what was corrected, and what
  procedure is reusable go into the **commit-body write-back**, not a separate "learning" section
  ([muse-dev-patterns §8](../../.claude/skills/muse-dev-patterns/SKILL.md)).

### Optional (separate instances only for L-size · security-grade slices)

- **Orchestrator (lead)** — exists separately only when delegating across multiple workers. Owns
  the full context and plan, synthesizes results, never implements directly. A slice finished by a
  single worker needs no orchestrator.
- **Reviewer** — a read-only, whole-picture reviewer before merge. Use a strong model.
  **A clean context with no task history is the feature** — Cognition measured (2026): a reviewer
  with no task history catches ~2 bugs per PR (58% of them severe). For the same reason, give the
  reviewer only the diff + criteria, and state "flag only gaps that affect correctness" (ask it to
  find gaps and it always will).
- **Feature lead** — takes a large feature, re-decomposes it, and spawns its own specialists. The
  layer that buys **3× deeper decomposition** without blowing one person's context.

> **The full ceremony (separate planner pass + heavy multi-stage handoff) is reserved for L-size
> or security-grade slices.** An ordinary slice finishes with worker + independent evaluator.
> Sense of scale (Osmani): even growing the team, **3–5 roles** is optimal — for more depth, scale
> as a **hierarchy** where a feature lead spawns its own sub-team, not one giant flat team.

## 1.5 Maker/evaluator permissions per work surface

`read-only evaluator` does not simply mean "no Edit tool". Evaluation commands or a browser can
write state, so: **the repo and owner state are read-only**, and any reproduction that needs
writes is allowed only against a **disposable fixture the evaluator created**. Maker and evaluator
never use the same checkout/file at the same time.

| Surface | Maker/worker and allowed writes | Independent evaluator: allowed reads/execution | Forbidden to the evaluator | Gate strength |
| --- | --- | --- | --- | --- |
| Runtime | A single worker writing only the active slice's runtime source/test/config. Runs the named narrow tests/traces. | From a fresh context, reads the handoff, acceptance slice, current diff/source, traces; reproduces normal/failure/cancel/retry in isolated processes and fixtures. | Editing the repo, reusing the worker's process/state, mutating owner daemon/scheduler state, fixing a FAIL directly. | Process/scheduler/concurrency boundaries that need Sol/high for both controller/maker and evaluator start at that strength. |
| Store / persistence | Writes only the active store/schema/migration and its migration tests; builds backup/restore/rollback acceptance alongside. | Reads schema/diff; runs round-trip, corruption, and rollback against a disposable database or a temp-HOME clone. | Modifying the owner DB, `~/.muse`, or backups; applying real migrations; promoting fixture results to organic evidence; fixing a FAIL directly. | Persistence/migration: Sol/high for both maker and fresh evaluator; the final release verdict follows its own gate. |
| Security / permission / credential | One Sol/high maker writes scoped guard/policy/tests. Real secrets never enter code or the handoff. | A fresh evaluator reads the artifact/diff and redacted fixtures; runs adversarial deny-paths in a sandbox. | Reading/copying credentials, issuing/changing grants/approvals/policy, external egress, editing the repo, fixing a FAIL directly. | The final security/credential gate is a fresh Sol/xhigh. |
| UI / browser | Writes only active UI source/tests and disposable state for the evaluator. | A fresh evaluator reads the current build and acceptance; observes via Chromium/Playwright in an isolated browser profile/test account, including accessibility and failure states. | Mutating the user's real browser profile, clipboard, downloads/uploads, account state; arbitrarily refreshing snapshot approvals; editing the repo; fixing a FAIL directly. | Ordinary UI: a fresh evaluator at matching risk; upload/download and computer-control boundaries start at Sol/high. |
| Release / publication | The controller prepares the verified commit candidate and provenance. Beyond a normal push within standing authorization, tag/release/publication is a separate permission. | From a fresh checkout, reads and reproduces HEAD/time/input hashes, required checks, rollback artifacts, remote state. | Modifying source; tag/release/publish/push; changing credentials/protection; using a stale artifact as green; fixing a FAIL directly. | The final release gate is a fresh Sol/xhigh; even an evaluator PASS is not publication permission. |

(`Sol/high` / `Sol/xhigh` are gate-strength shorthand — the strongest review model tier at
high/xhigh effort. Current mapping: [AGENTS.md §7](../AGENTS.md).)

Restrict the inputs handed to the evaluator to this allowlist:

1. the activation/handoff and the structured acceptance slice,
2. the current artifact or commit/diff to judge, with directly related source,
3. the verification commands, fixtures, and provenance to reproduce,
4. already-known blockers and the previous evaluator's **concrete verdicts** (re-evaluation cycles
   only).

Do not pass the maker's full conversation, hidden reasoning, self-evaluation, or unrelated dirty
files. The evaluator does not fix the permanent handoff or the repo; it returns PASS/FAIL with
per-criterion evidence, and the controller records it. If a fresh context is impossible, record
`unseparated self-evaluation`, not PASS.

## 2. Shapes of work (patterns)

Pick the shape that fits the work (Anthropic's five + the agreed composite pattern). Do not cling
to one; combine.

- **Prompt chaining** — split into fixed-order steps where each output feeds the next, with check
  gates between steps. (Fixed procedures.)
- **Routing** — classify the input and send it to the matching specialist path. (Heterogeneous
  request kinds.)
- **Parallelization** — split independent subtasks and run them concurrently (sectioning), or run
  the same task multiple times and collect votes (voting). (Speed / multiple perspectives.)
- **Orchestrator-workers** — a conductor **dynamically** decomposes work that cannot be
  pre-partitioned and delegates. (Unpredictable decomposition — multi-file code changes.)
- **Planner-generator-evaluator** — the 3-agent harness of those three core roles. (Long
  autonomous work.)
- **Consensus/debate** — several agents see each other's reasoning, refine positions, and
  converge. (Complex decisions.)

## 3. Exchange rules (handoffs)

- **Tell a subagent "you are a subagent."** Otherwise it believes it is an independent agent and
  addresses the user directly. Always state its role and boundaries.
- **Delegate concretely.** Give each worker ① the goal ② the output format ③ tool/source guidance
  ④ clear task boundaries. Vague delegation makes workers duplicate or misread the work.
- **Return results compressed.** A worker returns a **distilled summary** (intelligent filter),
  not the raw bulk. If it is large, write it to an **external file** instead of conversation
  history to avoid information loss.
- **Reset context, don't merge it.** Cut context cleanly between handoffs and let the next role
  pick up "from a defined state" via structured artifacts (JSON specs, feature lists,
  commit-grained progress) — avoiding both forgetting and near-limit timidity.
- **Agents message each other directly.** Routing everything through the conductor becomes a
  bottleneck. Build flow with a dependency-based task list (backend marks the API done → the
  blocked frontend/tests unblock automatically).

## 4. Safety & verification gates

- **Plan approval gate** — review the plan once before implementation. Fixing a bad plan is far
  cheaper than fixing bad code.
- **Maker ≠ judge** — the evaluator is independent and uses explicit grading criteria (quality,
  originality, completeness, behavior) calibrated with a few examples.
- **Automated verification on completion** — run tests automatically via a completion hook. A
  human does the final full-context review before merge.
- **Isolation** — concurrent work happens in separate workspaces (e.g. git worktrees) — no
  trampling.
- **Resumable checkpoints** — long autonomous work carries state, so a minor failure must not
  cascade into a large behavior change: **resume from a checkpoint**, not a restart.

## 5. Shared context

- **The team rules document is curated by humans.** Style, pitfalls, architecture decisions, and
  test strategy are written by people. **LLM-auto-generated rules documents bring no benefit and
  actually lower success rates by ~3%** — no auto-generation.
- **Clear ownership** — one file per role. Dependencies are exchanged as reports.
- **Cumulative learning** — let patterns accumulate across sessions in the shared context file.

## 6. Common failure modes (avoid)

- Over-spawning subagents for simple work.
- Endlessly searching for something that doesn't exist (queries too long and narrow from the start
  → start broad, then narrow).
- Picking shallow top-of-search content over authoritative sources (source-quality bias).
- Role boundaries blurring until coordination cost explodes.
- Non-deterministic behavior making debugging intractable → observe decision patterns with
  **end-to-end tracing**.

## 7. When a new agent joins (checklist)

1. Pick **one role** from above (no overlap).
2. Confirm the **goal, output format, tools, and boundaries** given by the orchestrator.
3. Know you are a subagent; do not address the user directly.
4. When done, report upward with a **compressed summary** (+ an external file if needed).
5. State changes and outbound sends go through their gates.

---

> The pieces once planned are now filled: role prompts are [role-prompts](role-prompts.md), the
> handoff format is [handoff-template](handoff-template.md), and the executable form of the
> verification gates is [../runner/](../runner/). This document is the agreed baseline for "who
> does what", updated as the harness concretizes.

## Sources (verified basis)

- Anthropic — [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) (5 workflow patterns + simplicity/transparency/ACI principles)
- Anthropic — [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (lead/subagent delegation · compressed returns · token economics · failure modes)
- InfoQ — [Anthropic Designs Three-Agent Harness](https://www.infoq.com/news/2026/04/anthropic-three-agent-harness-ai/) (planner/generator/evaluator + context reset · handoff artifacts, 2026-04)
- Addy Osmani — [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) (3–5 team · human-curated AGENTS.md · verification bottleneck · worktree isolation)
- Cognition — [Multi-Agents: What's Actually Working](https://cognition.ai/blog/multi-agents-working) (2026-04; clean-context reviewer ~2 bugs/PR, 58% severe — freshness is the feature)
