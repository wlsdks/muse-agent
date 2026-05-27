# 808 — feat: on-demand `email_recent` inbox read tool

## Why

Email had a SEND tool (`email_send`, gated) but no agent READ tool —
the inbox surfaced only as the proactive brief's unread digest. So a
`muse ask` conversation couldn't answer "any new email from Jane? /
what's in my inbox?". Email read is a named P19 actuator
(already hardened in 761); this exposes it to the agent.

## Slice

- `@muse/mcp` email-tool.ts — `createEmailReadTool({ provider })`
  exposes a `risk: "read"` tool `email_recent` (params `limit`
  1–50 default 10, `unreadOnly` boolean) over the hardened
  `EmailProvider.listRecent`, returning `{ count, messages:[{from,
  subject, unread, snippet}] }`. A provider error degrades to an empty
  list + the error (never throws).
- `@muse/autoconfigure` index.ts — registered in the runtime registry,
  gated on `MUSE_GMAIL_TOKEN` (the same gate the email knowledge source
  uses), with a `GmailEmailProvider`.

## Verify

- `@muse/mcp` email-read-tool.test.ts (new, 4, contract-faithful
  `EmailProvider` fake): `risk:read` + lists sender/subject/unread;
  `unreadOnly` filters to unread; `limit` clamps to 1–50 and is passed
  to the provider; a provider error degrades to `{messages:[], error}`.
- `@muse/autoconfigure` email-read-wiring.test.ts (new, 2): the REAL
  `createMuseRuntimeAssembly` exposes `email_recent` (risk:read) with
  `MUSE_GMAIL_TOKEN`; absent without it.
- **Mutation-proven**: dropping the `unreadOnly` filter → the
  unread-filter test fails; restore → 4/4. Full `pnpm check` EXIT 0,
  `pnpm lint` 0/0.
- The exposed tool catalog rides the model request, so live SELECTION
  wants `smoke:live`; Ollama was down → deferred.

## Decisions

- **Read-only, gated on the existing Gmail token** — no new config;
  the read is already retry-hardened (761), so the tool inherits that.
  Write stays the separate gated `email_send`.
- This completes the agent-reachable perception trio added this run:
  home (806), weather (807), email (808) — the agent can now perceive
  the user's home / weather / inbox in conversation, not just the brief.
  No bullet flip — perception EXPAND, CAPABILITIES line under P20.
