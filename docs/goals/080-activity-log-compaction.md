# 080 — Activity log compaction (rotate old proactive-history)

## Why

Pairs with 079. Provide a CLI subcommand to compact old logs into a
gz archive under ~/.muse/archive/.

## Scope

- New muse maintenance compact subcommand.
- Optional --keep-days N.

## Verify

- cli +1 test.

## Status

open
