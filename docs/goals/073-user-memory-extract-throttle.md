# 073 — User-memory auto-extract write throttle

## Why

createUserMemoryAutoExtractHook fires after every turn. A burst of
short turns could churn the user-memory.json file. Throttle writes to
1/min per user.

## Scope

- Add a small in-process throttle wrapper.
- Defer extraction when within cooldown.

## Verify

- memory +1 test.

## Status

open
