# Active reminder firing

Reminders are passive in the current iter — they sit in
`~/.muse/reminders.json`, surface in `muse today` once dueAt
passes, and rely on the user (or LLM) to look at them. The next
arc makes them push: when dueAt arrives, Muse delivers the text
through the messaging registry and flips status to `"fired"`.

## Why a separate design

The store already supports the read side (`status: "pending" |
"fired"`, `firedAt?: string`). Three things still need to land:

1. **Trigger**: something has to notice "this reminder's dueAt
   has passed and it hasn't fired yet." Options:
   - In-process tick loop inside `apps/api` (cheapest; dies with
     the server)
   - Existing `@muse/scheduler` agent job hook (dies with the
     server too, but reuses cron infra and persists across
     restarts via the scheduler's KV store)
   - External cron / systemd timer (out of process; survives
     server restarts; but Muse is a personal CLI, not infra)
2. **Delivery**: hand the reminder text to `MessagingProviderRegistry.send`
   on a configured provider (default to the user's primary, or
   the one named on the reminder when we add `via?: "telegram"`).
3. **State transition**: flip status pending → fired with a
   `firedAt` ISO. `snooze` already takes fired → pending, so the
   round-trip is symmetric.

## Phasing

### Phase A (this iter): manual fire

- New pure helper `fireReminder(reminders, id, firedAt)` in
  `packages/mcp/src/personal-reminders-store.ts`. Takes an
  array, returns the updated array (immutable; mirrors the
  add/remove pattern).
- New MCP tool `muse.reminders.fire` (write). Args: `id`,
  optional `firedAt`. The LLM can call this manually after
  it's sent the message through `muse.messaging.send`, closing
  the loop without a daemon.
- No automatic trigger yet. Useful immediately — JARVIS chat
  can already ask "should I send this reminder now?", do the
  send, then call `fire` to mark it done.

### Phase B: scheduled trigger via @muse/scheduler

- `autoconfigure` registers a cron-driven agent job that runs
  every minute, reads pending reminders due at-or-before now,
  and calls `muse.messaging.send` + `muse.reminders.fire` for
  each. The agent prompt says "for each reminder, deliver via
  the provider on the user's preferred channel; if none, use
  the first registered provider; print to stdout if none."
- Idempotency: each reminder fires at most once because status
  flips to "fired" inside the same call.
- Failure mode: if `send` errors, leave status as-is so the
  next minute retries. Cap retries via a `firedAttempts` field
  if needed (Phase C).

### Phase C: per-reminder routing

- Add optional `via: { providerId, destination }` to
  PersistedReminder. CLI `muse remind ... --via telegram:@me`
  sets it. Default fallback chain unchanged.
- Add `firedAttempts: number` for retry budgets.

### Phase D: quiet hours / batch delivery

- User-configurable "don't ping me between 23:00 and 07:00";
  reminders queue inside that window and fire at 07:01.

## Contract surface (Phase A landing this iter)

```ts
// personal-reminders-store
export function fireReminder(
  reminders: readonly PersistedReminder[],
  id: string,
  firedAt: string,
): readonly PersistedReminder[] | undefined;
//   returns undefined when id isn't found; caller surfaces 404.
//   returns the new array (status flipped, firedAt set) otherwise.
```

```
muse.reminders.fire    risk:write    { id, firedAt? }
                                     → { reminder: { ... status:"fired", firedAt } }
                                     → { error: "id is required" / "not found" }
```

CLI / REST surfaces are deferred — Phase B will add the daemon
which uses the MCP tool internally; the CLI doesn't need
`muse remind fire <id>` until a user wants to drive it manually,
and that's a small follow-up.

## Out of scope

- KakaoTalk routing (still excluded — Kakao bot policy)
- Push notifications to a Web UI / desktop notifier (separate
  surface, separate iter)
- Cross-device dedup (the file is single-machine-personal)
