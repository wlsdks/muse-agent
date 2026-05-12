# Proactive surfacing — Design Doc

Status: **Phases A + B + C + D shipped**. Phase D (agent-initiated
turn) lands an in-memory presence tracker rather than the full
presence pub/sub described below — same user-visible behaviour for
single-machine use, simpler to operate. Multi-device routing (where
the notice fires through the surface the user is currently looking
at instead of always going through messaging) is the remaining
Phase D follow-up. Last updated 2026-05-12.

## Why a separate design

Today every Muse response is reactive: the user (or LLM-driven loopback)
sends a chat → Muse replies. The active-context Phase 1 already injects
upcoming events, pending reminders, and the active task into the system
prompt, but those signals only fire when the user is already talking to
Muse. The JARVIS identity (memory `project_muse_identity.md`) calls out
"anticipatory action ('you have a meeting in 15 min — want the doc?')" as
a non-negotiable, and the reminder-firing daemon already proves the
pattern works for one signal source.

Proactive surfacing generalises that pattern. The same `setInterval`
tick the reminder daemon runs, applied to other signal sources, lands
JARVIS-class behaviour without inventing new infra.

## What "proactive surfacing" means here

Three user-visible flows, ranked smallest → largest:

1. **Push notice on imminent calendar event.** Tick scans the calendar
   registry every minute; for any event starting within
   `MUSE_PROACTIVE_LEAD_MINUTES` (default 10) that hasn't already been
   surfaced this session, deliver `"⏰ {event.title} in {N} min"` via
   the same messaging registry the reminder daemon uses.
2. **Push notice on task due-soon.** Symmetric: imminent task dueAt →
   delivered as `"📋 {task.title} due in {N} min"`. Same lead-minutes
   knob applies.
3. **Agent-initiated chat turn.** The boldest cut: when a notice fires
   AND the model is configured AND a chat session is "active" (last
   user turn within N minutes), spawn a one-shot agent run that produces
   the proactive message (e.g. "your 3pm starts in 10 min — want the
   meeting doc?"). Output streams to the same surface the user is
   currently looking at (web UI, CLI listen mode).

Phases 1–2 reuse the reminder daemon's pattern verbatim (1 cron tick,
1 messaging-send call, 1 dedupe file). Phase 3 needs a "what surface
is the user currently on?" signal that doesn't exist yet.

## Pieces required

| Piece | Phase 1 (calendar) | Phase 2 (tasks) | Phase 3 (agent turn) |
| --- | --- | --- | --- |
| Trigger | `setInterval` 60s | same | same |
| Signal source | `CalendarProviderRegistry.listEvents` | `TaskMemoryStore` | both |
| Lead window | `MUSE_PROACTIVE_CALENDAR_LEAD_MINUTES` (default 10) | `MUSE_PROACTIVE_TASK_LEAD_MINUTES` (default 10) | (uses Phase 1/2 fires) |
| Dedupe | sidecar JSON `proactive-fired.json` keyed by `{kind, id, firedFor}` | same | same |
| Delivery | `MessagingProviderRegistry.send` (same as reminder) | same | new `agentRuntime.stream` invocation |
| Quiet hours | reuses `MUSE_REMINDER_QUIET_HOURS` (or new `MUSE_PROACTIVE_QUIET_HOURS` if they should diverge) | same | same |
| Per-event override | reminder's `via?: ReminderVia` pattern (future enhancement) | same | n/a (agent picks surface) |

## Phasing

### Phase A (this design's "first cut")

- New module `apps/api/src/proactive-tick.ts` modelled on `reminder-tick.ts`.
- New `runDueProactiveNotices(options)` helper in `@muse/mcp` (analogous
  to `runDueReminders`).
- Sidecar file `~/.muse/proactive-fired.json` for dedupe — same shape
  as `reminder-history.json` but tracks which `{kind:'calendar', id, dueIso}`
  tuples have fired so a restart-then-restart loop doesn't double-fire.
- Off by default: activates only when `MUSE_PROACTIVE_PROVIDER` +
  `MUSE_PROACTIVE_DESTINATION` are set AND
  `MUSE_PROACTIVE_ENABLED=true`. Boot is fail-open; missing config = no
  daemon (same posture as the reminder tick).
- Phase A scope is *calendar events only*. Tasks come in Phase B once
  the calendar version has been dogfooded.

### Phase B: task due-soon

- Same surface, signal source becomes `TaskMemoryStore`. The store
  needs a "due before X" query (probably already covered by the
  existing `listForUser`-style API — verify before coding).

### Phase C: per-event opt-out

- Calendar events with `proactive: false` in their description /
  extended properties skip the notice. CalDAV / Google Calendar
  surface extended props natively; LocalCalendar gets a new optional
  field.

### Phase D: agent-initiated turn

- When a notice fires AND a chat session is "active" (last user turn
  within `MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS`, default 5 min), the
  daemon spawns a one-shot `agentRuntime.stream()` call with a system
  prompt like *"Compose a 1-2-sentence heads-up about
  {event}. Mention the time, suggest a relevant tool call (e.g. open
  the doc) if appropriate."* The stream pipes to whatever surface the
  user last used (REST `/api/chat/stream` listener, CLI `muse listen`).
- "What surface is the user on" needs a new signal — probably a
  presence pub/sub on the API server that web/CLI clients heartbeat
  every 30s.

## Out of scope

- **Desktop notifications.** Muse runs on the user's own machine; OS
  notification APIs are platform-specific (macOS NSUserNotification,
  Windows Toast, Linux libnotify). A future iter can layer this as a
  separate delivery adapter; the daemon emits notices through a
  pluggable `NoticeSink` interface so a `NodeOsNotificationSink` is a
  drop-in.
- **Batch / digest delivery.** Same exclusion as the reminder daemon —
  individual notices fire individually. A separate "daily brief"
  feature (which already exists via `muse today --brief`) handles the
  digest case.
- **Cross-device dedupe.** Sidecar file is single-machine. Two Muse
  instances on two devices fire independently. Multi-device coordination
  needs a server-side dedupe store (Postgres) and is a separate iter.
- **Smart routing.** Notice always goes to the configured default
  provider/destination. Per-event routing (Phase C) is the only
  exception. No ML / heuristic ("user is in a meeting, hold the
  notice").

## Risks

- **Notification spam.** A user with 8 events in a day gets 8 pings.
  Mitigations: quiet hours (Phase D of reminder design), lead-minutes
  tunable, per-event opt-out (Phase C). Operators can also set the
  daemon's `MUSE_PROACTIVE_ENABLED=false`.
- **Drift between calendar provider clocks.** Calendar providers can
  return events with a timezone string + naïve time; the imminence
  check must use the same TZ resolution `DefaultActiveContextProvider`
  uses (`resolveTimezone` from `time-helpers`).
- **Dedupe sidecar grows unboundedly.** History file already faces
  this and trims to ~1000 entries. Reuse the same trim helper.

## Why not extend the reminder daemon

The reminder daemon is tightly coupled to `~/.muse/reminders.json` shape
(`PersistedReminder`). Calendar events are read-only from upstream
providers and don't have a `status: pending|fired` field to flip. The
dedupe needs a sidecar regardless, and bundling two unrelated tick
sources into one daemon (calendar + reminders) increases the blast
radius of a bug in either. Symmetric daemons that share helpers
(`shouldFireNow`, `withinQuietHours`, `sendNotice`) is cleaner.

## Phase A landing checklist

1. `@muse/mcp` exports `runDueProactiveNotices(options) → { fired, errors }`.
2. `apps/api/src/proactive-tick.ts` mirrors `reminder-tick.ts` minus the
   reminder-store flip.
3. `apps/api/src/server.ts` wires the tick the same way it wires
   `runReminderTick` (env-gated, fail-open).
4. New env vars surface in `setup-status.ts` snapshot so
   `muse setup status` shows whether proactive surfacing is active.
5. CHANGELOG `Added` entry once shipping.
