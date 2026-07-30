---
title: Claude Code Integration (subagents · agent teams)
audience: [developers, AI agents]
purpose: How to actually operate this harness with Claude Code's native subagent and agent-team features
updated: 2026-06-13
sources_basis: [Claude Code Subagents official docs, Claude Code Hooks docs, 2026-05 subagent playbook]
related: [../AGENTS.md, ../core/team-roles.md, ../core/role-prompts.md, ../core/handoff-template.md, ../README.md]
---

# Claude Code Integration — subagents · agent teams

This harness is **Claude-Code-only**. So we do not build "parallel, isolated subagents"
ourselves — we operate with Claude Code's **native subagents**. The harness roles exist as real
subagent files.

## 1. The real subagent files (`.claude/agents/`)

The role prompts ([role-prompts](../core/role-prompts.md)) are pinned as **real subagents**
Claude Code reads (2026 format: `name` · `description` (auto-delegation criterion) · `tools`
(least privilege) · `model` + a body system prompt):

| File | Role | Tools (least privilege) | model |
|---|---|---|---|
| `.claude/agents/harness-planner.md` | Planner (acceptance criteria) | Read·Grep·Glob (read-only) | opus |
| `.claude/agents/harness-worker.md` | Worker (build) | Read·Grep·Glob·Write·Edit·Bash | sonnet |
| `.claude/agents/harness-evaluator.md` | Evaluator (independent verdict) | Read·Grep·Glob·Bash (no writes) | opus |
| `.claude/agents/harness-curator.md` | Curator (learning) | Read·Grep·Glob·Write | haiku |

Key point: **the evaluator is a different subagent from the worker** (no write permissions), so
"maker ≠ judge" is enforced by tool permissions too. The main thread (orchestrator) delegates to
them via the Task tool.

## 2. Parallel vs sequential (decided by dependency)

Claude Code runs **up to 10 subagents in parallel**. Our
[project.mjs](../runner/project.mjs)'s `shareContext` meshes exactly with that decision rule:

- **Independent subtasks → parallel.** If they don't use each other's results, the main thread
  launches several subagents at once (research, different files, independent components).
  Corresponds to our `shareContext:false`.
- **Dependent subtasks → sequential.** If an earlier output is a later input, the main thread
  waits one at a time. Corresponds to our `shareContext:true` (earlier output → later input) —
  [§subtask dependencies](../runner/README.md).

## 3. Constraints and rules (per the reference)

- **Delegation is one level deep (flat).** A subagent cannot spawn another subagent — **only
  the main thread** is the orchestrator. The orchestrator in our `runProject` = that main-thread
  role.
- **Cross-communication = disk.** Subagents have isolated contexts and cannot share state
  directly → the **handoff file** ([handoff-template](../core/handoff-template.md)) is that disk
  channel (the PLAN/BUILD/EVAL sections).
- **Aggregation in the SubagentStop hook.** Combining and logging parallel results happens in
  the deterministic `SubagentStop` hook (a fixed point, not a model choice). Same grain as the
  PostToolUse idea in our [hooks](hooks.md).
- **Least privilege · a crisp description.** Each subagent gets only the tools it needs, and
  the description states clearly "when to delegate" (auto-delegation accuracy). The 4 files
  above follow those rules.

## 4. Two operating modes

- **In-session (recommended, native):** in a Claude Code session, the main agent delegates to
  the subagents above via Task → isolated contexts, parallelism, and SubagentStop aggregation
  natively. The harness contract (gates, handoff) is applied on top.
- **Outside the CLI (`claude -p`):** [run.mjs](../runner/run.mjs) /
  [run-project.mjs](../runner/run-project.mjs) spawn a fresh `claude -p` per role — also an
  isolated context (same effect as a subagent) but sequential. For automation needing
  deterministic gates, traces, and session persistence, use this side.

## 5. Verification

The subagent files' frontmatter contract (lowercase-hyphen name · description · tools · model)
is structurally validated (separate from the runner suite in [runner/README.md]), and real
in-session delegation is confirmed with the Claude Code Task tool.

## 6. Agent Teams (collaborative, interdependent parallelism)

Where subagents are "delegate and get one report back", **Agent Teams** is the mode where
**peers collaborate with each other directly** (Claude Opus 4.6, experimental feature,
**v2.1.32+** — `claude --version`). Use it for parallel work with dependencies.

**Enabling & starting:** the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` environment variable →
the `/agent-team` slash command. (Experimental flag, so off by default.)

**Structure (the key differences from subagents):**
- **Lead** = the session I talk to. It splits work and assigns it on the **shared task list**
  (= our orchestrator).
- **Teammates** = each an **independent Claude Code session** (isolated context). They load the
  project context but do not inherit the lead's conversation history.
- **Shared task list** = anyone can read/update directly. → Our
  [handoff-template](../core/handoff-template.md) corresponds to that shared-on-disk structure
  (PLAN/BUILD/EVAL sections + status log).
- **Direct peer messages (P2P)** = they notify each other without passing through the lead
  ("API done → UI picks it up"). The biggest difference from subagents (central routing, one
  final message, no P2P).

**Reusing our subagents as teammates (officially supported):** Claude Code can spawn
`.claude/agents/` subagent definitions **as teammates too** ("spawn a teammate of type
harness-evaluator"). So our `harness-{planner,worker,evaluator,curator}` are reused as-is
**both as subagents and as agent-team teammates** (the definition's `tools` allowlist and
`model` apply, the body is added to the system prompt; note `skills` · `mcpServers` frontmatter
does not apply when running as a teammate — loaded from project/user settings).

**Team quality-gate hooks:** `TeammateIdle` (just before exit — exit 2 gives feedback and keeps
it working) · `TaskCreated` (block creation) · `TaskCompleted` (exit 2 blocks completion +
feedback) let us enforce our fail-closed gate spirit at the team level.

**Scale & conflicts:** usually **3–5 teammates** (5–6 tasks per teammate); beyond that,
coordination cost rises and returns diminish. **Each teammate owns different files** (no
simultaneous edits of the same file = no overwrites) — when decomposing subtasks, split along
file boundaries.

**Limits (experimental):** in-process teammates aren't restored by `/resume` · `/rewind`, one
team at a time, no nested teams, task state can lag. With strong dependencies or the same
files, sequential/subagents beat a team.

**When to use what (decision):**

| Mode | Use when | Our mapping |
|---|---|---|
| **Single session** | Tight sequencing · same-file edits | Small tasks · strong dependencies |
| **Subagents** | Clear boundaries · "do and report" repetition | `.claude/agents/harness-*` (per-role isolation) |
| **Agent Teams** | Collaborative, interdependent **parallelism** (exchanging results as they go) | Multiple branches needing `shareContext`, in parallel |

**Cost discipline (Anthropic evidence — must keep):** multi-agent is **~15× the tokens** of
chat (a single agent alone ~4×). So spin up a team only for **high-value, highly parallel,
beyond-one-context** work. "Scale to complexity" — one for simple, several for complex (meshes
with the [loop-budget](loop-budget.md) budget).

**Delegation quality is the biggest leverage (Anthropic multi-agent research lesson):** the
lead must give each teammate/subtask a clear **goal, output format, tool guidance, and task
boundaries** (vague → duplication and gaps). Teammates are stateless and cannot see the lead's
full conversation, so a **detailed task description** is essential. Our `run-project.mjs`
decomposition prompt and [role-prompts](../core/role-prompts.md) follow this principle.

> Relation to our harness: Agent Teams is a **runtime feature** (not defined in files), so we
> provide only the *contract for using it* — shared task list = the handoff form, maker ≠ judge
> = separate build teammate and evaluation teammate, cost gate = loop-budget. With strong
> dependencies or the same files, prefer sequential (`shareContext`) over a team.

## 7. Dynamic Workflows (scripted orchestration — new feature)

**Dynamic Workflows** is a research-preview feature released 2026-05-28 with Opus 4.8 (Claude
Code **v2.1.154+**). It moves orchestration from **conversation (turn by turn) to a JavaScript
script Claude writes**. Loops, branches, and intermediate results live in the script; **only
the work inside each `agent()` call is the model's**. A background runtime executes it
deterministically and the session stays responsive.

- **Triggers:** the word `workflow` in a prompt / `/effort ultracode` / bundled·saved workflows
  (`/deep-research`). Manage with `/workflows` (pause·stop·save); saved location
  `.claude/workflows/` (project) — re-run via `/<name>`.
- **Limits:** 16 concurrent · **1000 agents/run** total, no user input during execution (only
  agent permission prompts pause it), the script itself has no fs/shell (only agents
  read/write/execute), in-session resume (completed agents are cached).
- **Harness binding:** our [project.mjs](../runner/project.mjs)'s "decompose → drive subtasks →
  synthesize" is precisely the **hand-rolled version** of that fan-out→reduce→synthesize.
  **Large-scale, repetitive, deterministic** orchestration (codebase sweeps, mass migrations)
  properly moves up to Dynamic Workflows — consistent with our deterministic-gate spirit.

## 8. Selection contract — just work / subagents / team / workflow

**The default is a single session.** Go multi only when the work *decomposes into independent
threads* (Anthropic: "architecture follows task structure"). Cost: a single agent ~4×,
multi-agent research ~15× tokens → high-value only. **Pin scale with numbers (effort
scaling)** — simple query = 1 agent · 3–10 tool calls / comparison·research = 2–4 subagents ·
10–15 calls each / complex multi-faceted work = 10+ subagents (the rule Anthropic's
multi-agent research built into its prompt) — explicit per-complexity ceilings prevent
overspending on trivial work.

| Situation | Choice | Why |
|---|---|---|
| Trivial, single-step (one file · quick fix · direct answer) | **Just work** | One context suffices; orchestration is pure waste |
| Isolating/compacting one noisy subtask (library research · auditing one module), only the result needed | **Subagent** | Isolated context returns just a summary; parent context stays clean |
| A few independent delegations within one turn (results flow into my context) | **Subagents** | Fits Claude's per-turn "do and report" |
| Workers **collaborating, challenging each other, exchanging results** (multi-perspective review · competing-hypothesis debugging · cross-layer contract negotiation) | **Agent team** | Needs shared task list + P2P; when the ~3–4×+ cost is justified |
| **Deterministic, repetitive, large-scale** multi-step (codebase bug sweep · security audit · 500+-file migration), tens to hundreds of agents | **Workflow** | Orchestration as a script (resume · reuse), 1000 agents/run |
| Orchestration itself needs **audit, versioning, identical re-runs** | **Workflow** | Orchestration becomes a reusable artifact (`.claude/workflows/`) |
| **Strict sequencing** (earlier dependency) or **same-file simultaneous edits** | **Just work** | Interdependence/shared state breaks parallelism → a single session avoids conflicts and context loss |
| Routine · low value | **Just work** | Multi-agent is 4–15× tokens; only when result value exceeds cost |

**Our harness mapping:** just work = one `runCycle` / subagents = `.claude/agents/harness-*` /
agent team = the same harness-* definitions as teammates / workflow = the codified
`project.mjs`, at scale Dynamic Workflows. In every mode the **gate, handoff, and verification
contract applies unchanged**.

> Versions/models (as of 2026-06): Claude Code **v2.1.158**, latest model **Opus 4.8**. Agent
> teams v2.1.32+, Dynamic Workflows v2.1.154+. "Workflows" is a **separate new feature** from
> teams/subagents (do not confuse them).

## 9. The right tool in the right layer (layer-selection principle)

The **#1 mistake** in harness design named by 2026 references: putting "the right tool in the
*wrong* layer" — writing a behavioral constraint that should be a hook into the system prompt,
pasting a reusable workflow that should be a skill into every conversation, or running work
that should be isolated in a subagent in the main session. Separately from mode (§8), **what
goes into which layer** must also match.

| What to put | Right layer | Claude Code form | Our harness |
|---|---|---|---|
| Deterministic **behavioral constraints** (block/enforce) | Hooks | PreToolUse/PostToolUse · Teammate/Task hooks | [hooks](hooks.md) · `hooks.mjs` |
| Reusable **procedure/workflow instructions** (the same job every time) | Skills | `.claude/skills/<name>/SKILL.md` (in-context, same context) | Self-authored skills ([skills-and-mcp](skills-and-mcp.md)) |
| Noisy **isolated work** (only the result retrieved) | Subagents | `.claude/agents/` | `.claude/agents/harness-*` |
| Connecting **external capability** | MCP | MCP servers (allowlist) | [skills-and-mcp](skills-and-mcp.md) |
| **Large-scale, deterministic orchestration** | Workflows | Dynamic Workflows | [project.mjs](../runner/project.mjs)→Workflows |

> The point: skills (same-context instructions), subagents (isolated context), hooks
> (deterministic code), and workflows (scripted orchestration) are **different layers**.
> Putting the same purpose in the wrong layer neutralizes good roles and gates.

## Sources

- Claude Code — [Subagents](https://docs.claude.com/en/docs/claude-code/sub-agents) (the `.claude/agents` format · isolated context · tool permissions · auto-delegation)
- Claude Code — [Dynamic Workflows](https://code.claude.com/docs/en/workflows) (scripted orchestration · v2.1.154+ · 16 concurrent/1000 total · `.claude/workflows/`)
- Anthropic — [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) · [Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8) (2026-05-28)
- Claude Code — [Agent Teams](https://code.claude.com/docs/en/agent-teams) (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` · `/agent-team` · lead/teammates · shared task list · P2P)
- Claude Code — [Skills](https://code.claude.com/docs/en/skills) (`.claude/skills/<name>/SKILL.md`, same-context in-context instructions — a different layer from subagents/hooks) + the layer-selection principle (the right tool in the right layer)
- Anthropic — [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (orchestrator-workers · multi-agent ~15× tokens · delegation quality as the biggest leverage · scale to complexity)
- Claude Code — [Hooks](https://docs.claude.com/en/docs/claude-code/hooks) (deterministic lifecycle hooks like `SubagentStop`)
- [Claude Code Agent Teams & Subagents 2026 Playbook](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026) (max 10 parallel · parallel/sequential · one-level delegation · disk communication)
