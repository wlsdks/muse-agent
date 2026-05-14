# 011 — commands-proactive.ts subcommand split (572 LOC)

## Why

CLI proactive command surface (test / scan / watch / list / history).
Each subcommand is independent; the file mixes registration with
implementation. Split per-subcommand for clarity.

## Scope

- Move each subcommand's `.action` body into its own helper file
  under `apps/cli/src/proactive/<subcommand>.ts`.
- `commands-proactive.ts` becomes thin: register + call into each
  module.

## Verify

- commands-proactive.ts < 200 LOC.
- pnpm check / lint / smoke.
- cli tests unchanged.

## Status

deferred — under the 700-LOC big-file threshold (572). Subcommand
split is clean but earns little per-iter: each subcommand is
< 80 LOC and they share helpers that would all need re-export
glue. Re-open if the file regrows or if a new subcommand pushes
past 700.
