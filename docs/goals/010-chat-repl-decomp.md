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

open
