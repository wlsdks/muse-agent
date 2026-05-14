# 065 — muse search formatted output shows backend latency

## Why

After the result count + backend banner, append '(N ms)'.

## Scope

- Wrap the loopback search call in a Date.now() pair.
- Add to formatted output.

## Verify

- cli +1 test (mock fetch with delay → latency printed).

## Status

open
