# Goal 879 — shell completion completes subcommands, not just the verb

## Outward change

`muse completion bash|zsh` now completes the **second-level
subcommand**, not only the top-level verb. Typing `muse calendar
<TAB>` offers `add delete edit events show free import …`; `muse
tasks <TAB>`, `muse contacts <TAB>`, `muse proactive <TAB>`,
`muse followup <TAB>` likewise. Before, tab at the second word
produced nothing, so a daily user had to remember every subcommand
by heart.

## Why this, now

The completion script was authored at goal 066 when the CLI was a
flat list of verbs; its header explicitly deferred subcommand
completion as "diminishing returns." That trade-off has since
inverted — the daily-driver surface now has deep subcommand trees
(calendar, tasks, contacts, reminders, proactive, followup), and
recall-by-memory is exactly the friction a JARVIS-style assistant
should remove. This is the smallest real UX gap on a fresh,
not-recently-touched surface.

## How

- `collectSubcommandMap(program)` enumerates `cmd.commands` for each
  top-level command and maps the parent → its sorted subcommand
  names, omitting leaf commands. Live from the tree, so a newly
  added subcommand appears with no edit here (no staleness seam —
  the same property the top-level list already had).
- `renderBashCompletion` gains a `COMP_CWORD == 2` branch: a
  `case "${COMP_WORDS[1]}"` that `compgen`s the typed group's
  subcommands.
- `renderZshCompletion` gains a `CURRENT == 3` branch: a
  `case "${words[2]}"` that `_describe`s the group's subcommands.
- Both extra params default to an empty map, so the old single-level
  call shape still renders valid (catch-all) scripts.

## Verification

`apps/cli` `commands-completion.test.ts` (new): builds a real
program with the actual `registerCalendarCommands` +
`registerCompletionCommand`, asserts `collectSubcommandMap` surfaces
calendar's real `add/delete/edit/show`, that leaf commands are
omitted, that both rendered scripts branch at the second word and
list the subcommands, and an end-to-end `muse completion bash` run
emits `calendar) COMPREPLY=(… delete …`. Mutation-proven: removing
the bash second-level branch fails 3 of the 6 tests. No LLM path →
no smoke:live. `pnpm check` exit 0, `pnpm lint` 0/0.

## Decisions

- Enumerated from the live command tree rather than a hand-kept
  list — the top-level completion already worked this way and the
  whole point of the original deferral was avoiding a maintenance
  burden; a static subcommand list would reintroduce exactly that.
- Flag/value (third-level) completion still deferred — it needs
  per-shell `_arguments`/`complete -W` machinery with genuinely
  diminishing returns, and the verb→subcommand jump captures the
  bulk of the value.
