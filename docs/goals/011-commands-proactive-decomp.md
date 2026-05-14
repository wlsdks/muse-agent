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

open
