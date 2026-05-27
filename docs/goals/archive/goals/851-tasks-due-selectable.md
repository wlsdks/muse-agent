## 851 — feat: the tasks list tool is selectable for "what's due today?"

## Why

832 gave the tasks `list` tool a `dueWithinDays` filter so it answers
"what's due today / this week / overdue" — but, like calendar
availability before 850, it was UNREACHABLE for those prompts: the
tasks DOMAIN keywords are `task/todo/reminder/할일` and none match
"due"/"overdue"/"deadline", so `DefaultToolFilter` dropped every task
tool for "what's due today?" and the local model never saw `list`.
The 850 per-tool-keyword infra makes this fixable.

## Slice

`@muse/mcp` loopback-tasks.ts — the `list` tool declares
`keywords: due / overdue / deadline / 마감`. Per-tool (using 850's
loopback keyword projection), so a generic "due" ("the rent is due to
the landlord") exposes ONLY `list`, not `add`/`complete`/`search` —
keeping the exposed set small (tool-calling.md rule 1).

## Verify

`@muse/autoconfigure` tasks-due-relevance.test.ts (4), the REAL
`createLoopbackMcpMuseTools(createTasksMcpServer(…))` → REAL
`DefaultToolFilter`:
- "what's due today?", "anything overdue?", "what's due this week?" all
  surface `muse.tasks.list`;
- a plain "show my tasks" still surfaces it (domain heuristic intact);
- a "due" false-positive ("the rent is due to the landlord") exposes
  ONLY `list`, not `add`/`complete`;
- a clearly-unrelated prompt surfaces no task tools.
- **Mutation-proven**: removing the `due/overdue/deadline` keywords
  drops the due/overdue prompts (the surfacing test fails) while "show
  my tasks" still works (domain control). `@muse/mcp` 905/905, `pnpm
  check` EXIT 0 (0 non-voice failures), `pnpm lint` 0/0.
- Model-facing catalog changed (list now exposed for due-queries).
  EXPOSURE verified end-to-end; live SELECTION (Qwen picks `list` +
  fills `dueWithinDays` for "what's due?") is `[UNVERIFIED-LIVE]` —
  Ollama down.

## Decisions

- **Per-tool keywords on `list`** (not the tasks domain) — adding
  "due"/"overdue" to the domain would surface all 4 task tools on any
  "due" prompt; per-tool limits a generic-word false-positive to the
  one due-aware tool. Second use of the 850 infra (after availability),
  confirming it's the right general seam for "tool exists but its
  natural vocabulary isn't in the domain heuristic." CAPABILITIES line
  under P18 tool-calling reliability.
