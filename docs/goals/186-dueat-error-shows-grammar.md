# 186 — dueAt rejection shows accepted grammar (EN + KO)

## Why

`parseTaskDueAt` rejected an unparseable `dueAt` with
`dueAt must be an ISO-8601 timestamp or a supported relative
phrase (got "X")` — it said *what's wrong* but never *what's
accepted*. The relative-time parser is rich (160–163: English
`tomorrow 9am` / `in 3 hours` / `next monday`, Korean
`내일 오후 3시` / `3일 후` / `다음 주 월요일` / `3시 반`),
but a Korean user who typed `다음달쯤` got a flat rejection
with no path to self-correct. This parser backs **both**
`muse tasks add` and `muse remind` (parseReminderDueAt
delegates to it), so the gap hit two daily surfaces.

## Scope

- `packages/mcp/src/personal-tasks-store.ts`: the error now
  appends concrete EN + KO examples
  (`"tomorrow 9am", "in 3 hours", "next monday 6pm",
  "내일 오후 3시", "3일 후", "다음 주 월요일"`). Message only —
  no behaviour change. The unchanged prefix means the existing
  `.toContain` / `.toMatch` assertions still pass.
- `packages/mcp/test/mcp.test.ts`: the bad-dueAt case now also
  asserts the EN + KO examples appear.

## Verify

- `pnpm --filter @muse/mcp test` — 331 pass (existing case
  extended; prefix unchanged so 1856/2140 still green).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (Ollama qwen3:8b API): `muse tasks add --due
  "다음달쯤"` →
  `INVALID_TASK_DUE_AT: … (got "다음달쯤"). Examples:
  "tomorrow 9am", … "내일 오후 3시", "3일 후", "다음 주
  월요일".` — end-to-end actionable.

## Status

done — the dueAt rejection now teaches the accepted grammar in
the user's own language; tasks + reminders both inherit it
(shared parser). Validation-message only; no model
request/response shaping changed.
