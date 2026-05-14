# 012 — `muse open <id-prefix>`

## Why

`muse history` / `muse status` / `muse remind list` all print
IDs (12-char prefixes). To inspect any one, the user has to know
which subcommand owns that ID space (followup vs episode vs
reminder vs task vs proactive). A unified `muse open <prefix>`
that scans all five stores + prints the matching record removes
that mental overhead.

## Scope

- New `apps/cli/src/commands-open.ts` (~120 LOC).
- Probe order: reminders → followups → episodes → patterns-fired →
  proactive-history → tasks. First hit wins; ambiguous matches
  print a disambiguation list.
- `--json` outputs the matched record verbatim.
- Test seeds three stores with overlapping prefixes, asserts
  correct dispatch + ambiguity message.

## Verify

- pnpm check / lint / smoke.
- cli +1 test.

## Status

open
