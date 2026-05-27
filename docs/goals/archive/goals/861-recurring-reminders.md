## 861 — feat: recurring reminders ("remind me every Monday")

## Why

Reminders were one-shot only: `dueAt` is a single timestamp, status
goes pending → fired, done. So a daily-driver staple — "remind me every
morning to take meds", "every Monday: standup" — wasn't possible; the
user had to re-create the reminder each time. A genuinely-new daily
capability.

## Slice — recurrence centered on the single fire choke point

`fireReminder` is the ONE place every fire path routes through (the
firing-loop daemon, `muse remind run`/`fire`, the `muse.reminders.fire`
tool, the REST route). So recurrence lives there:

- `@muse/mcp` personal-reminders-store.ts: `ReminderRecurrence =
  "daily" | "weekly"` + optional `PersistedReminder.recurrence`
  (validated at load, serialized). `nextReminderOccurrence(dueAt,
  recurrence, from)` — advances `dueAt` by 1 / 7 days to the first
  instant strictly after the fire time, skipping missed slots (a
  reminder fired late / after the daemon was off re-arms to the
  upcoming slot, not a backlog). `fireReminder` now **re-arms** a
  recurring reminder (advance `dueAt`, stay `pending`) instead of
  marking it fired — so it keeps recurring across every fire path.
- Create surfaces (all three): `muse remind add --repeat daily|weekly`
  (CLI, local + REST body), the `muse.reminders.add` agent tool gains a
  `recurrence` enum param ("every Monday" → weekly), and the
  `POST /api/reminders` route accepts + validates `recurrence`.

## Verify

- `@muse/mcp` reminders-recurrence.test.ts (7): `nextReminderOccurrence`
  daily/weekly advance, missed-slot skip to next future, unparseable →
  unchanged; `fireReminder` re-arms a recurring reminder (pending,
  dueAt advanced, no firedAt) while a one-shot still flips to fired;
  unknown id → undefined.
- `apps/cli` commands-remind.test.ts (+3): `--repeat weekly` puts
  recurrence in the POST body; an invalid `--repeat` errors and creates
  nothing; `--local --repeat daily` round-trips recurrence into the real
  store.
- **Mutation-proven**: making `fireReminder` ignore recurrence (always
  fire) fails the re-arm test.
- `pnpm check`: mcp 920/920, api 323/323, cli 131/133 (the 2 = the known
  voice-playback `/tmp` flake; 0 non-voice failures). `pnpm lint` 0/0.

## Decisions

- **Re-arm in `fireReminder`, not per-caller.** It's the single fire
  choke point, so one change makes daemon + CLI + tool + REST all honor
  recurrence — no path can fire a recurring reminder and forget to
  re-arm it.
- **Fixed-interval, not calendar/DST-aware.** `daily`/`weekly` advance
  by 86_400_000 / 7× ms. An honest v1: a "9am daily" reminder can drift
  by an hour across a DST boundary. Calendar-correct recurrence (RRULE /
  tz-aware) is a future slice; fixed-interval covers the common case
  cleanly and deterministically.
- **Agent-tool param is [UNVERIFIED-LIVE] for selection.** The
  `muse.reminders.add` `recurrence` enum + handler are tested
  deterministically; whether the local Qwen fills it from "every
  Monday" needs a `smoke:live` round-trip (Ollama down this session).
- No new dependency.
