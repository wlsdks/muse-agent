## 825 — feat: the agent searches the inbox — `search_email`

## Why

A daily-driver assistant must answer "find the email from the bank
about my statement" / "any emails about the Paris trip". Muse had
`email_recent` (latest N) and `read_email` (one by id) but no way to
SEARCH — the single most common inbox ask. Gmail's REST `q=` param
does the match server-side (`from:`, subject words, keywords), so this
is a thin, zero-cost addition over the existing `GmailEmailProvider`.

## Slice

`@muse/mcp`:
- email-provider.ts — new `EmailSearcher` interface +
  `GmailEmailProvider.search(query, limit)`: GETs
  `/messages?maxResults&q=<query>` then resolves each match's
  metadata. The per-message loop (and its 824 resilience — skip a
  single transient/malformed message, propagate `GmailAuthError`) was
  extracted into a shared private `summariesForIds`, so search and
  `listRecent` inherit the SAME hardening. Blank query → `[]`, no HTTP.
- email-tool.ts — `createEmailSearchTool` → a `search_email` read tool:
  required `query` (concrete example), optional `limit` (1–50). A
  searcher error degrades to `{messages:[], error}` (never throws).
- The pair is kept DISJOINT for one-shot selection (tool-calling.md
  rule 2): `search_email`'s description says "for just the latest
  messages with no search terms, use `email_recent`", and
  `email_recent`'s now says "if the user names a sender/subject/keyword,
  use `search_email` instead."
- `@muse/autoconfigure` — wired into `emailReadTools` (opt-in via
  `MUSE_GMAIL_TOKEN`, same gate as the other read tools).

## Verify

- `@muse/mcp` email-provider-retry.test.ts (search block, +3): the
  query is sent as Gmail's `q=` param (not `labelIds=INBOX`); a blank
  query returns `[]` without any HTTP; a single bad match is skipped
  (inherited 824 resilience). Contract-faithful sequenced fetch fake.
- `@muse/mcp` email-search-tool.test.ts (new, 5): risk:read, `query`
  required, trims query + clamps limit, blank-query rejected without
  calling the searcher, searcher-error → empty+error, description
  steers away from `email_recent`.
- `@muse/autoconfigure` email-search-relevance.test.ts (new, 2): the
  REAL `createEmailSearchTool` through the REAL `DefaultToolFilter` — a
  "find the email about X" prompt surfaces `search_email`; an unrelated
  prompt ("what is 2+2?" / "turn on the lights") does not.
- **Mutation-proven**: dropping the blank-query guard → the no-HTTP
  test fails; sending `labelIds=INBOX` instead of `q=` → the q-param
  test fails. Full `pnpm check` EXIT 0, `pnpm lint` 0/0.
- **Live model SELECTION is `[UNVERIFIED-LIVE]`** — adding a tool
  changes the model-facing catalog, so the smoke:live one-shot
  selection round-trip (search_email vs email_recent) is the real
  proof; Ollama is unreachable this session, so EXPOSURE (the filter)
  and the handler are verified, selection is deferred.

## Decisions

- **Separate `EmailSearcher` interface** — same "depend only on what
  you use" pattern as `EmailReader`/`EmailSender`; the search tool takes
  a searcher, not the whole provider.
- **Shared `summariesForIds`** — extracting the per-message loop means
  search inherits 824's resilience for free instead of duplicating (and
  risking divergence of) the skip/propagate logic.
- **Disjoint descriptions over merging into `email_recent`** — a single
  tool with an optional query muddies selection; two tools with explicit
  "use this not that" cross-references is the tool-calling.md-recommended
  shape for sibling read tools. CAPABILITIES line under Reach (no bullet
  flip — perception expansion, like the other email read tools).
