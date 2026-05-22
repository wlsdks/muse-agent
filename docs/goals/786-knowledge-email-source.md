# 786 — feat: recent email as a knowledge-corpus source (P20 knowledge depth)

## Why

Stagnation guard tripped — 9 of the last 10 commits were the
perception/watch axis. Redirect to the OTHER thin axis the human
named: P20 Knowledge. The personal corpus (`assembleKnowledgeCorpus`)
spanned notes + tasks + calendar + contacts, but NOT email — even
though the hardened email read already exists (761). A daily-driver
assistant must answer "what did Jane email me about the project
deadline?" with a citation, from the user's own inbox.

## Slice

`@muse/autoconfigure` knowledge-corpus.ts:
- `EmailMessageSource` (structural: `listRecent(limit) =>
  EmailMessageLike[]`, satisfied by the existing `GmailEmailProvider`)
  + `emailSource` option on `assembleKnowledgeCorpus`. Each recent
  email becomes a chunk sourced `email/<id>` carrying
  `From <from> — <subject> (<date>)\n<snippet>`, capped by `maxEmails`
  (default 25) and truncated by `maxCharsPerNote`. A throwing source
  degrades to no email chunks (never crashes the corpus).
- Threaded through `createKnowledgeEnricher` +
  `createNotesKnowledgeSearchTool`.
- `apps/.../index.ts` — production `knowledge_search` adds the email
  source when `MUSE_GMAIL_TOKEN` is set (inside the existing
  `MUSE_KNOWLEDGE_SEARCH_ENABLED` opt-in).

## Verify

- `@muse/autoconfigure` knowledge-email-source.test.ts (new, 4): each
  email → an `email/<id>` chunk with from+subject+snippet; `maxEmails`
  caps ingestion (and is passed to `listRecent`); a throwing source
  degrades to zero email chunks; **end-to-end** — `knowledge_search`
  over a contract-faithful email source answers "what did Jane email
  about the project deadline?" and cites `[email/m1]`.
- **Mutation-proven**: making the email-source catch rethrow instead
  of degrading → the throwing-source test fails; restore → 4/4. Full
  `pnpm check` EXIT 0, `pnpm lint` 0/0. No LLM request/response path
  changed (local embedder + contract-faithful email fake) → no
  `smoke:live`.

## Decisions

- **Structural `EmailMessageSource`** — `GmailEmailProvider.listRecent`
  already returns `{ id, from, subject, snippet, date? }`, so it
  satisfies the source with no adapter; the corpus layer stays
  decoupled from the concrete provider.
- **Snippet, not full body** — `EmailSummary` carries the Gmail
  snippet (the searchable preview); ingesting full bodies would
  balloon the per-query embedding cost. The `email/<id>` citation
  points the user at the real message.
- No bullet flip — P20's Knowledge bullet is `[x]`; this deepens it
  (CAPABILITIES line under P20). Gated behind the existing
  `MUSE_KNOWLEDGE_SEARCH_ENABLED` + `MUSE_GMAIL_TOKEN` so the inbox is
  only embedded when the user opted into both.
