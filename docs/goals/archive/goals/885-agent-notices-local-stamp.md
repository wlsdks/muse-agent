# Goal 885 — `muse agent-notices tail` stamps notices in local time, not raw UTC

## Outward change

Each proactive heads-up streamed by `muse agent-notices tail` is
prefixed with a `[HH:MM]` timestamp. That stamp now renders in the
user's **local** timezone. Before, it was a raw `slice(11, 16)` of
the producer's UTC ISO string — so a user in KST saw every notice
stamped 9 hours off (`[14:55]` for a notice that fired at 23:55
their time), and a malformed `generatedAt` produced a garbled
substring instead of a clean fallback.

## Why this, now

The producer stamps `generatedAt` with `toISOString()` (UTC). Slicing
the time substring shows UTC verbatim — wrong for every non-UTC user,
which is the actual user (Korean / KST). It's also inconsistent with
the rest of Muse, which already renders local time
(`formatCurrentContextLine` in the persona block uses the resolved
local zone). On a JARVIS heads-up the timestamp must read in the
user's wall-clock. Smallest real correctness gap on a fresh,
not-recently-touched surface (the codebase is otherwise deeply
mature).

## How

Extracted `formatNoticeStamp(generatedAt, timeZone?)`: parses the ISO
stamp and formats `HH:MM` via `toLocaleTimeString("en-GB", { …,
timeZone })` in the resolved local zone (`timeZone` injectable for
deterministic tests); a missing or unparseable value returns `??:??`
rather than a bad substring. The `tail` renderer calls it with no
zone arg (machine-local).

## Verification

`apps/cli` `commands-agent-notices.test.ts` (new): a UTC `14:30Z`
formats to `23:30` in `Asia/Seoul` (the raw slice would show
`14:30`), a pre-midnight `23:30Z` rolls to next-day `08:30` KST, a
`UTC` zone is the sanity identity, and missing/empty/`not-a-date`
all yield `??:??`. The existing `program.test.ts` integration test
(`agent-notices tail consumes the SSE stream`) was updated to assert
the stamp via the helper itself, so it's timezone-agnostic in CI.
Mutation-proven: reverting to `slice(11, 16)` fails the local-zone
cases. No LLM path → no smoke:live; Ollama down regardless. `pnpm
check` exit 0, `pnpm lint` 0/0.

## Decisions

- The integration assertion derives the expected stamp from
  `formatNoticeStamp` rather than hardcoding a wall-clock string, so
  it stays correct on any CI timezone instead of trading the UTC bug
  for a tz-flaky test.
