# 821 — fix: loopback domains surface for plural prompts + 10-iter regression sweep

## Why

819/820 fixed natural-prompt exposure for home/weather/email; the same
word-boundary keyword issue affects the loopback domains' heuristics.
`DEFAULT_DOMAIN_KEYWORDS` listed only singulars, so "what are my
**events**?" / "show my **tasks**" / "any **meetings**?" didn't match
`event`/`task`/`meeting` (the matcher is `\bkw\b`) and the calendar /
tasks tools were DROPPED for those everyday phrasings. Also the 10th
iteration since the 811 sweep → regression sweep due.

## Slice

`@muse/agent-core` tool-filter.ts — add plurals + common natural forms
to `DEFAULT_DOMAIN_KEYWORDS`: calendar (events/meetings/appointment(s)/
agenda/약속), tasks (tasks/todos/reminders), notes (notes/memos/docs/
document), messaging (messages).

## Verify

- `@muse/autoconfigure` loopback-domain-relevance.test.ts (new, 4): the
  REAL calendar + tasks loopback tools through the REAL
  `DefaultToolFilter` — "what are my events today?" and "do I have any
  meetings this week?" surface the calendar tools; "show my tasks"
  surfaces the task tools; an unrelated prompt surfaces NO calendar
  tools.
- **Mutation-proven**: removing the calendar `events` plural → the
  events-prompt case fails; restore → 4/4.
- **10-iter regression sweep (812–820)**: full `pnpm check` EXIT 0
  across every workspace suite, `pnpm lint` 0/0, `pnpm smoke:broad`
  51/0. No regression. `smoke:live` deferred — Ollama unreachable.

## Decisions

- **Explicit plurals, not a prefix matcher** — same rationale as
  819/820: the word-boundary matcher is deliberate; plurals are added
  as explicit keywords rather than risking stem-match false positives.
- Completes the natural-prompt exposure sweep across ALL agent domains
  (home/weather/email/calendar/tasks/notes/messaging). No bullet flip —
  tool-calling reliability; CAPABILITIES line under P20.
