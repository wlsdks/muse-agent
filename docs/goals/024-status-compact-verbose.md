# 024 — `muse status --compact` / `--verbose` toggles

## Why

JSON has 13 top-level keys; formatted output is dense. A
`--compact` mode would print only the most important 4-5 lines
(model, providers count, tasks count, last notice headline,
reminders pending). A `--verbose` mode would expand persona's
facts/prefs inline.

## Scope

- Two new flags. Default behaviour unchanged.
- Compact: persona one line, model one line, tasks one line,
  reminders/followups counts only.
- Verbose: prints facts and preferences as key:value pairs.

## Verify

- pnpm check / lint.
- cli +2 tests (compact + verbose render shapes).

## Status

deferred
 — output restructure with two new branches. The current dense
output works fine; revisit when concrete dogfood feedback shows
which fields are noise vs signal in compact mode.
