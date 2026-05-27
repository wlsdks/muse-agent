# 809 — feat: web-fetch + context tools describe their parameters (one-shot tool-calling)

## Why

Tool-calling reliability ([`tool-calling.md`](../../.claude/rules/tool-calling.md)),
continued on a different surface than the recent perception-tool
wiring. The web-fetch tools (`muse.fetch` `get` / `head` — the agent's
"read this URL" capability) and the context tools (`muse.context`
`active` / ref-expand) exposed their parameters as bare
`{ type: "string" }` — the rule-3 invalid-args failure mode on the
web-read path the model fills with a URL.

## Slice

- `@muse/mcp` loopback-fetch.ts — `get` / `head` `url` params gain an
  example-bearing description ("Absolute http(s) URL to fetch, e.g.
  'https://example.com/page' (host must be allowlisted)"); `get`'s
  optional `headers` described too.
- loopback-context.ts — the `active` resolver's `sessionId` / `userId`
  and the ref-expand `ref` param gain descriptions.

## Verify

- `@muse/mcp` loopback-fetch-context-tool-schema.test.ts (new, 2): the
  REAL `createFetchMcpServer` and `createContextReferenceMcpServer`
  tools, mapped to `MuseTool`s, pass `validateToolDefinitions` with
  ZERO `undescribed_parameter` (the goal-799 check); `get`'s `url`
  description mentions `http`.
- **Mutation-proven**: reverting `get`'s `url` to `{ type: "string" }`
  → the check flags it and the test fails; restore → 2/2. Full `pnpm
  check` EXIT 0, `pnpm lint` 0/0.

## Decisions

- **High-value surfaces first** — web-fetch (URL the model fills) +
  context resolver, after knowledge_search (799) / calendar (800) /
  notes (801). The remaining low-traffic loopback servers (crypto,
  diff, episodes, followups) are a clean-up batch the goal-799
  validator keeps findable.
- No bullet flip — tool-calling reliability hardening of the web-read +
  context tools. CAPABILITIES line under P20 / tool-calling.
