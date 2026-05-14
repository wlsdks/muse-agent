# 051 — muse memory diff [<since>]

## Why

Show what's changed in user-memory.json since a given checkpoint (file
mtime or commit hash). Useful for 'what did Muse learn about me today?'

## Scope

- New subcommand under muse memory.
- Diff strategy: compare current snapshot vs git-blame or mtime-based
  fallback.
- Render as { added, changed, removed } per slot kind.

## Verify

- cli +1 test.

## Status

open
