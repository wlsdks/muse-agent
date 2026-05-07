# .claude/

Claude-Code-specific configuration, checked into git so it scales
with the team.

## Layout

```
rules/      domain-specific rules auto-loaded next to CLAUDE.md
commands/   reusable slash commands (invoke via /<name>)
agents/     subagent definitions (invoke via the Task tool)
```

## Adding a new rule

1. Create `.claude/rules/<topic>.md` with a clear one-line summary at the top.
2. Reference it from `CLAUDE.md`'s "Domain rules" section.
3. Keep `CLAUDE.md` itself under 100 lines. The whole point of this
   directory is so the contract file can stay lean.

## Adding a new slash command

`commands/<name>.md` with frontmatter:

```markdown
---
name: <name>
description: <one-line summary, shown in Claude's command picker>
---
<the body of the command — what should happen when invoked>
```

## Adding a new subagent

`agents/<name>.md` with frontmatter:

```markdown
---
name: <name>
description: <when to use this agent (the picker uses this to choose)>
---
<the agent's prompt — its role, process, and rules>
```

## After-correction protocol

When the user corrects Claude on a recurring mistake, end the
iteration by adding the rule to the matching `.claude/rules/*.md` (or
open a new rules file). The goal is for the rule set to absorb every
correction so the same mistake doesn't recur. Reference:
[Boris Cherny's CLAUDE.md best practices](https://howborisusesclaudecode.com/).

## What stays out of git

- `.claude/scheduled_tasks.lock` — transient session state, listed in `.gitignore`.
- Anything written by the runtime at session start (auto-memory state, plan files, monitor output).
