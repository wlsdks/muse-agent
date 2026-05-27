# 800 — feat: calendar event tools describe every parameter (one-shot tool-calling)

## Why

Continuing the tool-calling-reliability priority
([`tool-calling.md`](../../.claude/rules/tool-calling.md)). The
calendar loopback tools (`add`/`update`/`delete` event) are the
actuators the local model fills the MOST arguments for ("event
tomorrow 3pm titled Dentist, room 4"), yet their parameters
(`title`, `startsAtIso`, `endsAtIso`, `location`, `notes`, `allDay`,
`tags`, `id`, `providerId`) carried NO per-parameter descriptions —
only `{ type: "string" }`. On a small model that's the rule-3
"invalid arguments" failure mode for the highest-stakes (write) tools.

## Slice

`@muse/mcp` loopback-calendar.ts — every parameter of `add` / `update`
/ `delete` now has a concise, example-bearing description (`title`:
"Event title, e.g. 'Dentist appointment'"; `startsAtIso`: "ISO-8601 OR
a natural phrase like 'tomorrow 3pm' / '내일 오후 3시'"; update fields
note "(only if changing it)"; `id`: "from `list`"). No behaviour
change — the rich tool-level description and parsing are untouched.

## Verify

- `@muse/mcp` loopback-calendar-tool-schema.test.ts (new, 2): the
  calendar server's tools, mapped to `MuseTool`s, pass
  `validateToolDefinitions` with ZERO `undescribed_parameter` issues
  (the goal-799 check applied to the REAL tool definitions); the `add`
  tool's `title` carries an "e.g." example and `startsAtIso` mentions
  the relative-phrase / ISO format.
- **Mutation-proven**: removing the `add.title` description → the
  `undescribed_parameter` check flags it and the test fails; restore →
  2/2. Full `pnpm check` EXIT 0, `pnpm lint` 0/0.
- Tool definitions ride the model request, so the live-SELECTION /
  arg-fill benefit wants a `smoke:live` round-trip; Ollama was down
  this tick → deferred (the deterministic definition-quality check is
  the verified claim).

## Decisions

- **Per-parameter descriptions even when the tool description is
  rich** — the model fills arguments per-property; a great tool
  description doesn't tell it what `startsAtIso` specifically expects.
- **Scoped to the calendar tools** — the highest-arg-count write
  surface. The other loopback servers with undescribed params (crypto,
  diff, episodes, context, followups, notes-registry) are follow-on
  slices; the goal-799 validator makes them mechanically findable.
- No bullet flip — tool-calling reliability hardening of the calendar
  actuator. CAPABILITIES line under P20 / tool-calling.
