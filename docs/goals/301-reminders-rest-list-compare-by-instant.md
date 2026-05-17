# 301 — GET /api/reminders sorted by raw ISO string (goal 291 REST sibling)

## Why

The raw-string-ISO-compare bug class was closed for the inbox
cursor (281), task comparator (290), MCP reminders loopback
(291), and the activity feed (292). But `GET /api/reminders`
(`apps/api/src/reminders-routes.ts`) — a **separate consumer**,
the REST surface `muse today` / the web UI / external clients hit
to list reminders soonest-first — still sorted with the inline:

```ts
const sorted = [...filtered].sort((left, right) =>
  left.dueAt.localeCompare(right.dueAt));
```

Goal 291 only replaced the MCP-loopback tool's sort; this REST
route was left on the old path. `PersistedReminder.dueAt` is a
free-form string (hand-edited `reminders.json`, imports, the
`snooze` path), so lexicographic ISO order is wrong across mixed
precision (`"…00.500Z"` sorts before `"…00Z"`) and timezone
offsets (`"…18:00+09:00"` = `09:00Z` sorts after `"…10:00Z"`) —
the REST list surfaces the **wrong reminder as most imminent**,
exactly the silent-wrong 291 fixed for the agent-facing surface.

## Scope

`apps/api/src/reminders-routes.ts`:

- Import the canonical `compareRemindersByDueAt` (added to the
  `@muse/mcp` barrel in goal 291) and use it for the
  `GET /api/reminders` sort instead of the inline
  `dueAt.localeCompare`. One-line behavioural change + one import;
  no other route logic touched. The POST/snooze paths already
  normalise via `parseReminderDueAt`.

Behaviour-preserving for canonical `…Z` reminders (instant order
== the prior lexicographic result); the REST list now matches the
MCP-loopback list (goal 291) and the task ordering (goal 290) —
one consistent "soonest due, ties→newest-created" rule across
every reminder/task surface.

## Verify

- `pnpm --filter @muse/api test` — 161 pass (was 160; +1). New
  `server.inject` test seeds `reminders.json` (via
  `writeReminders`) with a `+09:00` earliest instant that
  string-sorts in the middle and a `…00.500Z` entry →
  `GET /api/reminders` returns ids
  `["offset-soonest","ms-mid","late"]` by true instant (pre-fix
  `localeCompare` returned `["ms-mid","offset-soonest","late"]` —
  wrong most-imminent). The existing reminders-history /
  reminder-tick / contract tests stay green.
- `pnpm check` — every workspace green (apps/api 161, apps/cli
  563, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (REST route sort
  wiring to a deterministic comparator). The comparator's
  correctness is pinned by goal 291's `compareRemindersByDueAt`
  unit tests; this adds the end-to-end REST assertion — same
  stance as siblings 281 / 290 / 291 / 292.

## Status

done — `GET /api/reminders` now orders by the real due instant
via the shared `compareRemindersByDueAt`, closing the last
untreated instance of the raw-ISO-compare class and making the
REST reminder list consistent with the MCP loopback and task
ordering. Canonical-ISO ordering is unchanged.
