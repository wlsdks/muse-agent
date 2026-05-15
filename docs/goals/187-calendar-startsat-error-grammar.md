# 187 — calendar `startsAtIso` rejection states the real contract

## Why

`muse.calendar.add`'s `parseIsoDate` accepts an ISO-8601
timestamp **or** any relative phrase via
`resolveRelativeTimePhrase` (English + Korean, goals 160–166;
the goal-166 tool description advertises exactly that). But on
an unparseable value it returned
`startsAtIso must be a valid ISO 8601 timestamp` — which is
**factually wrong**: relative phrases ARE accepted. The error
contradicted both the tool description and the parser, and (as
in goal 186) gave the user/LLM no accepted-grammar to
self-correct. Worse than the dueAt case because it actively
misstated the contract.

## Scope

- `packages/mcp/src/loopback-calendar.ts`: the `!startsAt`
  branch now returns
  `startsAtIso must be an ISO-8601 timestamp or a supported
  relative phrase (got "X"). Examples: "tomorrow 9am", "in 2
  hours", "next monday 6pm", "내일 오후 3시", "3일 후",
  "다음 주 월요일".` — same shape as the goal-186 dueAt
  message, so the two time-input surfaces are now consistent.
  `parseIsoDate` logic is unchanged (message-only).

## Verify

- `pnpm --filter @muse/mcp test` — 331 pass (no regression;
  no test asserted the old string, confirmed by grep).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Built dist carries the new message (grep-confirmed).
- `muse calendar` is a read-only CLI surface by design — add
  is the LLM-tool path, structurally identical to the goal-186
  dueAt path already dog-fooded end-to-end on Ollama qwen3.
  Message-only change, no model request/response shaping
  touched.

## Status

done — the three relative-time input surfaces (tasks dueAt,
reminder dueAt, calendar startsAtIso) now reject with the
same honest, actionable, EN+KO grammar. No surface still
misstates that only ISO is accepted.
