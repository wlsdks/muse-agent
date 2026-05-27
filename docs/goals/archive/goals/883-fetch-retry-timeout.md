# Goal 883 — read-actuator fetches bound each attempt with a timeout (no infinite hang)

## Outward change

Every read-only actuator fetch that goes through `fetchWithRetry`
(weather geocode/forecast, Gmail inbox reads, Home Assistant
state/entity reads + alert briefing, RSS/feed bodies via the
web-watch path) now bounds **each attempt** with a wall-clock
timeout (default 15 s). A host that accepts the TCP connection but
never sends a response — a service mid-restart, a black-hole proxy,
a stalled captive portal — previously hung the call **forever**: a
hang produces no HTTP status and never rejects, so the retry-on-5xx
logic never engaged. The daily briefing / agent turn froze
indefinitely. Now the attempt is aborted, treated as a transient
failure, and retried; if every attempt hangs, a bounded timeout
error propagates and the caller degrades gracefully (the briefing
stays quiet, the read returns `undefined`/`[]`).

## Why this, now

P19 — daily-hardening of the actuators against real failure modes —
explicitly invites "repeat per actuator." Weather (753) and email
(824) handled 5xx/429/malformed; this closes the **hang/no-response**
mode, which is distinct (a 5xx rejects fast; a hang never settles)
and was unhandled across *all* read actuators at once because they
share `fetchWithRetry`. One fix hardens the whole class.

The model request/response path is unaffected — model adapters live
in `@muse/model` and do not use `fetchWithRetry`, so a cold Ollama
load (which can exceed 15 s) is never aborted by this.

## How

`fetchWithRetry` gains a `timeoutMs` option (default 15000, `0`
disables). Each attempt creates an `AbortController`, arms a
`setTimeout` that aborts with a descriptive error, and passes the
signal into `fetchImpl(url, { ...init, signal })`. An aborted attempt
rejects → the existing catch treats it as transient → retry; the
final attempt's error propagates. A caller-supplied `init.signal`
(external cancellation) is linked so it also aborts the in-flight
attempt. The timer is always cleared in `finally`.

## Verification

`@muse/mcp` `weather-retry.test.ts` (the `fetchWithRetry` suite): a
new test where attempt 1 hangs (settles only on `signal` abort) and
attempt 2 succeeds asserts the hung attempt was aborted + retried
(`calls === 2`, eventual 200); a second asserts that when *every*
attempt hangs the call rejects with a bounded `timed out after 5ms`
error rather than hanging. Existing 5xx/429/404/network-reject cases
stay green. Mutation-proven: disabling the per-attempt
`AbortController` makes both new tests hang to the vitest timeout
(2 failed). Full `@muse/mcp` suite 930 green; `pnpm check` exit 0;
`pnpm lint` 0/0. Actuator HTTP path, not the LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- Default 15 s rather than opt-in: the hang vulnerability was in
  *every* read actuator, so the safe default must protect them all;
  15 s is generous for a JSON read yet bounds a hang. Callers can
  override or disable with `0`.
- Linked an external `init.signal` instead of ignoring it, so the
  helper composes with caller cancellation correctly.
