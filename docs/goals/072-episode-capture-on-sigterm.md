# 072 — Episode capture on SIGTERM during REPL exit

## Why

The REPL captures episodes at clean exit. SIGTERM may skip the capture
if not wired. Add a signal handler.

## Scope

- chat-repl.ts SIGTERM handler.
- Synchronous final capture.

## Verify

- cli + manual dogfood.

## Status

open
