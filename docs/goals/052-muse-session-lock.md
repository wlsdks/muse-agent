# 052 — muse session lock --hours N

## Why

Pause proactive notices for N hours. Writes a marker file the proactive
daemon checks.

## Scope

- New commands-session.ts with lock / unlock / status subs.
- Proactive notice loop reads the marker; skip-and-log when active.

## Verify

- mcp + cli tests.

## Status

done — three-subcommand surface:

  - `muse session lock [--hours N] [--minutes N] [--reason "..."]`
    writes `~/.muse/session-lock.json` (env-overridable via
    `MUSE_SESSION_LOCK_FILE`) with `{ until, setAt, reason? }`.
    Default 1 hour when no duration is passed. Atomic write +
    0o600 mode to match the other personal stores.
  - `muse session unlock` removes the marker.
  - `muse session status` reports active / not, minutes remaining.

`runDueProactiveNotices` reads the marker on every tick via a
new `sessionLockFile` option; when the lock is active it returns
`{ fired: 0, imminent: 0, sessionLockedUntil }` so the
`proactive-tick` daemon logs a single "skipped (locked until X)"
line per tick instead of a stream of zero-fire ticks. Fail-open
on read / parse error so a corrupted marker can't permanently
gag the daemon.

Verifications:

  - mcp +1 test asserts the loop returns
    `{ fired: 0, sessionLockedUntil: <iso> }` while the lock is
    active and resumes firing past `until`.
  - cli +2 tests: `resolveLockUntilMs` parser boundaries +
    end-to-end lock / status / unlock / status round-trip.
  - autoconfigure / API wiring routes the new option through
    `ProactiveTickOptions` so the deployed surface honours the
    lock without further glue.
