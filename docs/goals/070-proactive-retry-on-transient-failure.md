# 070 — Proactive notice retry on transient messaging error

## Why

When the messaging provider returns 5xx, the proactive daemon should
retry with backoff instead of marking the notice as failed.

## Scope

- Read proactive-notice-loop.ts.
- Add 3-attempt retry with exponential backoff.
- Final failure still writes to history.

## Verify

- mcp +2 tests (3 transient 503 then success; 3 failures → final failure).

## Status

done — new `sendWithRetry` helper inside
`proactive-notice-loop.ts` wraps the `messagingRegistry.send`
call in a 3-attempt exponential backoff (0ms, 200ms, 800ms).
Final failure re-throws to the existing catch block so history
gets the same `status: "failed"` entry callers already
consume.

Scope discipline: the retry is intentionally narrow — three
attempts, no jitter, no infinite ladder. The outer tick
cadence (typically 60s) gives a free retry every minute, so
covering the 1-2 second transient blip window is what matters.

mcp +2 tests:
  - 2 throws followed by success → fired=1, errors=[], 3 attempts.
  - 3 consecutive throws → fired=0, errors=1 (with upstream
    message), history sidecar carries the failed entry.
