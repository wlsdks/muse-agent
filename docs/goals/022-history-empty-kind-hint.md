# 022 — `muse history --kind X` empty hint

## Why

JSON mode: `{"entries":[],"total":0}`. Formatted mode currently
prints "(no activity yet — JARVIS hasn't fired anything in the
configured stores)" — generic, doesn't acknowledge the kind filter.
When `--kind followup` returns empty, say "(no followup activity
yet — try `muse history` without the filter to see other kinds)".

## Scope

- One-line update in `commands-history.ts` formatted-mode empty
  branch.
- Per-kind hint copy: episode / pattern / reminder / proactive /
  followup each get a tailored message.

## Verify

- pnpm check / lint.
- cli +1 test (filtered empty case).

## Status

open
