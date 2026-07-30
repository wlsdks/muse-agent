# `.claude/`

**How the repository splits its two documentation roots.**

- **`.claude/` is instruction** — how to work here. Some of it the agent runtime
  resolves at a fixed path; the rest is the operating contract those files point into.
- **`docs/` is knowledge** — what is true about the product and why the engineering
  decisions were made. Nothing loads it; an agent opens it when the task needs it.

The test for a new file is not its topic but its role: *does it tell an agent how to
work, or does it tell an agent what is true?* Both roots are read by agents; only this
one changes behavior on every task.

## Layout

```
rules/     auto-loaded into EVERY session alongside CLAUDE.md, recursively,
           grouped by concern: engineering/ safety/ verification/
harness/   the operating contract — read on demand, linked from rules/engineering
agents/    subagent definitions, resolved by the `name:` in each file's frontmatter
skills/    invocable skills, resolved by directory name via SKILL.md
```

`rules/` is the only directory that costs tokens on every request. Everything else is
paid for only when it is used. That difference decides where a fact belongs.

## The rule/rationale split

A binding rule lives in `rules/`; the evidence behind it lives in `docs/`. So
`rules/verification/testing.md` states which gate proves what, and
`docs/development/testing-strategy.md` holds the decision table and the benchmark
numbers. Keep doing this — it is what lets the always-loaded set stay small without
losing the reasoning.

## One owner per fact

If a fact appears in two files, one of them is wrong eventually. Pick the owner by
where the fact is *needed*: a decision made before opening the contract belongs in
`rules/`; a detail needed only while doing the work belongs in `harness/` or `docs/`.
The other becomes a pointer, or dies.

## Adding a rule

1. Put it in the matching `rules/<concern>/` file. A new file needs a new line in
   CLAUDE.md's "Read further" index.
2. Prefer promoting it to a gate. A rule stored away from the request survives
   multi-step work poorly (`.claude/harness/contract.md` §4 has the measurements), so a
   check that fails closed is worth more than a paragraph.
3. Keep CLAUDE.md under 100 lines — that cap is the reason this directory exists.

## Adding a subagent

`agents/<name>.md`, where `<name>` matches the frontmatter `name:` exactly — the host
resolves `subagent_type` against the frontmatter, not the filename, and
`pnpm check:agent-registry` fails closed on drift.

```markdown
---
name: <name>
description: <when to use it — the picker chooses on this line alone>
tools: <the narrowest set that does the job>
---
<the agent's prompt>
```

Only add one when the behavior cannot come from the contract the session already has.
Three agents were deleted on 2026-07-30 after never being invoked once, and one of them
had drifted into instructing a policy violation that no gate could see.

## Gates that keep this directory honest

`check:doc-links` (references and cited paths resolve) · `check:doc-claims` (every
documented `pnpm` command exists) · `check:agent-registry` (agent names resolve) ·
`check:refs` (project references match dependencies). All run in the pre-push hook.

## What stays out of git

- `.claude/scheduled_tasks.lock` — transient session state, in `.gitignore`.
- Anything the runtime writes at session start (auto-memory state, plan files, monitor
  output).
