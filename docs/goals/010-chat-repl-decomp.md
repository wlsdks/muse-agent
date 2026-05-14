# 010 — chat-repl.ts seam decomp (629 LOC)

## Why

Just under the 700-LOC threshold but recently has been touched
multiple times (`f6e5df2` extracted slash-command handler).
Survey for one more natural seam — input pipeline (stdin / piped /
TTY detection), mode resolver (react / plan_execute), or session
persistence.

## Scope

- Read the file, identify a single cluster (~150 LOC) with one
  clear responsibility.
- Extract to a sibling file, re-export the public symbol.

## Verify

- chat-repl.ts < 500 LOC.
- pnpm check / lint / smoke.
- cli 213+ tests pass.

## Status

deferred — under the 700-LOC big-file threshold (629). Recent
slash-command extraction (f6e5df2) already split the most cohesive
seam. Remaining structure is intertwined REPL state +
agent/runtime wiring; further extraction earns little. Re-open
if the file regrows past 700.
