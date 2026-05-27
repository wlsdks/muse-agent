# Goal 899 — `muse status` surfaces an active session DND lock

## Outward change

When a session DND lock is active (`muse session lock`), `muse status`
now shows it: a `(DND) proactive notices paused until <iso> — `muse
session unlock` to resume` line, and a `session: { dnd, until }`
object in `--json`. Before, the dashboard showed
tasks/objectives/reminders/followups but **not** the DND state — so a
user who locked focus mode could glance at `muse status`, see nothing
amiss, and be confused why no proactive notices were arriving (the
proactive loop silently skips firing while the lock holds).

## Why this, now

A cross-surface seam: the session lock governs whether the proactive
daemon fires, `muse session status` reports it, and the daemon honours
it — but the at-a-glance dashboard a user checks every morning was
blind to it. DND-with-no-indicator is a classic "why is it broken?"
support trap. Smallest verifiable fix to make the dashboard tell the
whole story.

## How

`collectStatus` reads the lock via `readSessionLock(file, now)` (from
`@muse/mcp` — returns the `until` string only while active; expired /
missing / corrupt → `undefined`, so no stale "DND on"), behind a
`defaultSessionLockFile()` env helper (`MUSE_SESSION_LOCK_FILE`,
mirroring `muse session`). The snapshot gains
`session: { dnd, until? }` (additive — no `MUSE_STATUS_SCHEMA_VERSION`
bump); `renderStatus` prints the DND line (only when active) right
after the model block, before tasks. ASCII `(DND)` marker per the
no-emoji house style.

## Verification

`apps/cli` `program.test.ts`: seeds a temp `MUSE_SESSION_LOCK_FILE`
with a future `until`; `muse status --json` asserts
`session.dnd === true` + the `until`, and the text run asserts the
`(DND) proactive notices paused` line. Mutation-proven: dropping the
DND render block fails the text assertion. The 2 full-suite failures
are the known voice-playback `/tmp` flake; `pnpm lint` 0/0. No LLM
path → no smoke:live (Ollama down regardless).

## Decisions

- Reused `readSessionLock` (the same helper the proactive loop and
  `muse session status` use) rather than re-reading the file
  ad-hoc — so the dashboard's notion of "active" matches exactly what
  silences the daemon (including the expiry semantics).
- Rendered the DND line before tasks (a state that *explains* the
  rest of the dashboard) rather than buried at the bottom.
