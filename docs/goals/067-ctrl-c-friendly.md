# 067 — Ctrl-C handling in long-running commands

## Why

Audit muse search / muse ask / muse history / muse listen for clean
Ctrl-C exit (no hanging promises, no half-written files).

## Scope

- Per-command SIGINT handler.
- AbortController propagation.

## Verify

- Manual dogfood; cli +1 test where possible.

## Status

open
