# 166 — Tool descriptions advertise the Korean relative-time grammar

## Why

Goals 160–163 made the server-side resolver understand Korean
relative-time ("내일 오후 3시", "3일 뒤", "다음 주 월요일",
"3시 반"). The parser is wired across tasks / reminders /
calendar. **But the tool-parameter descriptions the LLM reads
only listed English examples** ('tomorrow at 6pm', 'next
Monday'). The model uses those descriptions to decide what to
pass; with no Korean example it could decide the Korean phrase
isn't acceptable and instead hallucinate an ISO timestamp —
the exact failure mode `resolveRelativeTimePhrase` exists to
prevent (small models guess the wrong base date).

## Scope

Description strings only (no logic change):

- `loopback-tasks.ts` — `add.dueAt` description: English +
  Korean example sets, "pass directly in their own language".
- `loopback-calendar.ts` — `add` startsAt/endsAt description:
  same treatment.
- `loopback-reminders.ts` — `add` description + the `dueAt`
  property description: same. (`snooze` already delegates
  "same grammar as `add`" so it inherits the update.)

No test pins these description strings (the parse-error
message tested at mcp.test.ts:1856/2140 is a different string,
unchanged), so nothing to re-snapshot.

## Verify

- `pnpm --filter @muse/mcp test` — 331 pass (no regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- End-to-end (Ollama qwen3:8b, reasoning off): chat
  "할 일 추가: 치과 예약, 마감은 내일 오후 3시" →
  qwen3 dispatched `tasks.add`; task persisted with
  `dueAt: 2026-05-16T06:00:00Z` = 2026-05-16 15:00 KST,
  i.e. exactly "내일 오후 3시". The model passed the Korean
  phrase through (no ISO hallucination) and the server
  resolved it deterministically.

## Status

done — the Korean relative-time capability built in 160–163 is
now actually discoverable by the model, closing the loop.
Real-LLM tool-dispatch path; verified via a live qwen3:8b
round-trip (smoke:live needs a provider key).
