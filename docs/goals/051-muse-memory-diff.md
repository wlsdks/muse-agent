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

done — `muse memory diff [--baseline <path>]` compares the
current user-memory record against a baseline JSON file and
renders `{ added, changed, removed }` per slot kind. Pure
`computeMemoryDiff` helper is the contract; the CLI just wires
file IO + formatted output.

Scope deviation: git-blame integration is deferred — the
baseline-file approach covers the "compare current vs an
earlier snapshot I saved" case without depending on the repo
state, and the file form composes with any future snapshot
collector (a `muse memory snapshot` follow-up writes the
baseline this command reads). Empty baseline ⇒ every entry
counts as added, so the first run after wiring snapshots is
the "every learned fact" view automatically.

cli +1 unit test on `computeMemoryDiff` covers added /
changed / removed buckets, the empty-baseline pass-through,
and the removal case.
