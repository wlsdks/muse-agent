# 060 — Top-level muse with no args prints help instead of error

## Why

Running  alone currently exits with 'unknown command' or
similar. Should print --help.

## Scope

- commander default action.
- Verify in cli test.

## Verify

- cli +1 test.

## Status

done — bare `muse` invocation now triggers a `program.action(...)`
that calls `program.outputHelp()`, so the user sees the Usage
banner + Commands list instead of commander's confusing
"unknown command" / silent exit. cli +1 unit test asserts the
Usage banner + a couple of discoverable subcommand names
appear in stdout for `muse` with no args.
