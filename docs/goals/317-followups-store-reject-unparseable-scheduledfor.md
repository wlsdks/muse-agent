# 317 — a followup with an unparseable scheduledFor sat "scheduled" forever and never fired

## Why

`isPersistedFollowup` (the per-entry load guard in
`personal-followups-store.ts`) only checked `typeof
candidate.scheduledFor !== "string"`. The firing loop
(`followup-firing-loop.ts:83`) then selects due entries with:

```ts
.filter((entry) => entry.status === "scheduled"
  && Date.parse(entry.scheduledFor) <= cutoffMs)
```

`Date.parse("tomorrow")` (a hand-edited / imported
`~/.muse/followups.json`, a corrupted partial write, or a
detector that emitted a non-ISO value) is `NaN`. `NaN <=
cutoffMs` is `false`, so the followup is **never selected as
due, never fires, and sits `status:"scheduled"` forever** — the
agent told the user it would follow up at a time, and that
promise is **silently never kept, with no error anywhere**. It
is still *listed* (ordering already tolerated unparseable values
since goal 314), so the user believes it is armed when it is
actually dead — a worse, more confusing inconsistency than a
clean absence.

This is the same silent-vanish bug class as the local calendar
(goal 316) and CalDAV (goal 282). Goal 314 hardened only
`compareFollowupsByScheduledFor` (the *list ordering*),
explicitly noting "hand-edited followups.json / imports need not
be canonical" — but left the *firing* path exposed. 317 closes
that path at the same store boundary 314 acknowledged.

## Scope

`packages/mcp/src/personal-followups-store.ts` —
`isPersistedFollowup`:

- `scheduledFor` must now actually **parse**
  (`Number.isFinite(Date.parse(candidate.scheduledFor))`), not
  merely be a string — exactly the predicate the firing loop's
  `Date.parse(...) <= now` filter needs to behave. An
  unparseable entry is dropped at load, the same posture
  `isPersistedEvent` (316) and CalDAV's `parseVEvent` (282) use,
  and the same `Number.isFinite(Date.parse(...))` predicate goal
  314 already uses for ordering in this very file. One short WHY
  comment records the never-fires rationale.

Tightest scope — only `scheduledFor` is hardened:
`createdAt` is only consumed via `localeCompare` (string-safe;
an unparseable value causes no Invalid-Date or never-fire harm),
so widening the guard there would be scope the bug doesn't
require. Behaviour-preserving for every well-formed
`followups.json` (ISO timestamps — the normal detector-resolved
path — parse and pass exactly as before); only a malformed entry
that was previously un-fireable-but-listed is now uniformly
absent.

## Verify

- `pnpm --filter @muse/mcp test` — 350 pass (was 349; +1). New
  regression: a `followups.json` with one valid entry and one
  whose `scheduledFor` is `"tomorrow"` → `readFollowups` returns
  **only** the valid entry (`["fu_ok"]`) (pre-fix: the corrupt
  entry passed `isPersistedFollowup`, was returned, listed as
  "scheduled", and then never fired because `Date.parse` → NaN).
  The existing quarantine / snooze / compare-by-instant (314) /
  upsert / lifecycle tests stay green.
- `pnpm check` — every workspace green (mcp 350, apps/cli 563,
  apps/api 161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure persisted-entry
  type-guard). A live Qwen run cannot reproduce a corrupt
  followups.json on demand, so the deterministic regression is
  the rigorous verification — same stance as goals 316 / 314 /
  282.

## Status

done — a followup whose persisted `scheduledFor` does not parse
is now dropped at the load type-guard, consistently with the
local calendar (316) and CalDAV (282), so a corrupt/hand-edited
entry can no longer sit listed-but-un-fireable forever. The
self-followup firing path is now closed for the same
unparseable-timestamp class goal 314 closed for ordering.
