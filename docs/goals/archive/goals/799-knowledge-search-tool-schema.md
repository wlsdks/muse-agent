# 799 — feat: knowledge_search tool meets the one-shot bar + validator enforces it

## Why

The human made tool-calling reliability the top priority
([`tool-calling.md`](../../.claude/rules/tool-calling.md)): the local
Qwen must fill the RIGHT tool in ONE shot. Both `knowledge_search`
builders (agent-core 754 + autoconfigure 755) exposed a `query`
parameter with NO description and no `additionalProperties: false` — so
a small model had to guess what goes in `query` (rule-3 "invalid
arguments" failure mode), and the tool gave no "use when / not when"
cue (rule-4 wrong/eager selection).

## Slice

- `@muse/tools` — extend `validateToolDefinitions` with an
  `undescribed_parameter` check: every property of an object input
  schema must carry a non-empty description. Encodes
  `tool-calling.md` rule 3 in the EXISTING validator (no duplicate
  framework).
- `@muse/agent-core` + `@muse/autoconfigure` — both `knowledge_search`
  definitions now give `query` an example-bearing description ("…e.g.
  'my health insurance policy number'…"), add
  `additionalProperties: false`, and append a "use when … ; do not use
  for general knowledge or live web data" cue to the description.

## Verify

- `@muse/tools` tools.test.ts (+1): `validateToolDefinitions` FLAGS an
  object-schema param with no description (`undescribed_parameter`,
  message names the param) and returns clean once it's described.
- `@muse/agent-core` knowledge-recall-agent.test.ts (+1): the REAL
  `createKnowledgeSearchTool({...})` definition passes
  `validateToolDefinitions` with zero issues and its `query`
  description carries a concrete example.
- **Mutation-proven**: disabling the `undescribed_parameter` branch →
  the flag test fails; restore → green. Full `pnpm check` EXIT 0
  (no other package tool is flagged — built-ins already describe their
  params), `pnpm lint` 0/0.
- The tool definition rides the model request, so the live-SELECTION
  benefit wants a `smoke:live` round-trip; Ollama was down this tick,
  so that check is deferred (the deterministic definition-quality gate
  is green and is the verified claim here).

## Decisions

- **Extend the existing validator, don't build a new one** —
  `validateToolDefinitions` already gated name/description/risk; the
  per-parameter description check belongs there, and it's only run in
  the tools test (not a cross-package runtime gate), so no surprise
  sweep of other packages.
- **`additionalProperties: false`** — strict-mode providers (OpenAI)
  require it and it stops a small model from inventing extra args.
- No bullet flip — reliability hardening of an existing tool +
  enforcement of the new tool-calling rule. CAPABILITIES line under
  P20 (knowledge) / tool-calling reliability.
