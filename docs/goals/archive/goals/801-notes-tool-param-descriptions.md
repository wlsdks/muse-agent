# 801 — feat: notes tools describe every parameter + 10-iter regression sweep

## Why

Tool-calling reliability ([`tool-calling.md`](../../.claude/rules/tool-calling.md)),
the notes surface. Notes are a top daily-driver actuator (the model
creates / searches / appends notes constantly), yet the notes-registry
loopback tools (`list`/`read`/`search`/`save`/`append`) exposed their
parameters as bare `{ type: "string" }` — no per-parameter description,
the rule-3 invalid-args failure mode. Also the 10th iteration since the
last sweep (790) → regression sweep due.

## Slice

`@muse/mcp` loopback-notes-registry.ts — every parameter of the five
notes tools now has a concise, example-bearing description (`query`:
"Text to find in note titles/bodies, e.g. 'Q3 launch plan'"; `title`:
"e.g. 'Meeting notes 2026-05-23'"; `id`: "from `list` or `search`";
`overwrite`: "True to replace an existing note's body instead of
erroring"; etc.). No behaviour change.

## Verify

- `@muse/mcp` loopback-notes-tool-schema.test.ts (new, 2): the notes
  server's tools, mapped to `MuseTool`s, pass `validateToolDefinitions`
  with ZERO `undescribed_parameter` issues (the goal-799 check on the
  REAL definitions); `save`'s `title` carries an example and `body` a
  description.
- **Mutation-proven**: removing `save.body`'s description → flagged →
  test fails; restore → 2/2.
- **10-iter regression sweep (791–800)**: full `pnpm check` EXIT 0
  across every workspace suite, `pnpm lint` 0/0, `pnpm smoke:broad`
  51/0. No regression found. `smoke:live` deferred — Ollama down (no
  request/response code path changed this window; the open
  tool-SELECTION live checks from 799/800/801 all await the env).

## Decisions

- **Per-tool param descriptions, surface by surface** — knowledge_search
  (799) → calendar (800) → notes (801), each verified by the goal-799
  validator on its real definitions. Remaining loopback servers
  (crypto, diff, episodes, context, followups, fetch) are the next
  follow-on slices.
- No bullet flip — tool-calling reliability hardening of the notes
  actuator + the periodic sweep. CAPABILITIES line under P20 /
  tool-calling.
