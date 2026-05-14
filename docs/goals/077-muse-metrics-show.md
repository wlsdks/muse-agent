# 077 — muse metrics show — SLO + drift surface

## Why

runtimeAgentMetrics exposes SLO + drift + budget counters. Expose them
via a CLI for at-a-glance.

## Scope

- New subcommand muse metrics.
- Reads /api/admin/snapshot already exists; pretty-print.

## Verify

- cli +1 test.

## Status

open
