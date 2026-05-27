# 803 — feat: Notion notes read recovers from a transient 429 (P19)

## Why

P19 actuator/perception hardening, fresh surface. Notion is a real
notes backend for the user, and the Notion API rate-limits at **429**
under bursts — a very common real-world failure mode. `NotionNotesProvider`
mapped 429 → `NOTION_RATE_LIMIT` but threw it single-shot, so a momentary
rate-limit dropped the read (list/search/read returned an error instead
of the notes).

## Slice

`@muse/mcp` notes-providers-notion.ts:
- Inject retry config (`retry?: { retries=2, baseDelayMs=250, sleep }`)
  and add a `retriable` flag to the shared `request` method: a
  transient 429/5xx retries with exponential backoff ONLY on the
  idempotent reads (`list` query, `read` page, `search`,
  `fetchAllBlockChildren`). Writes (create / append / replace /
  delete) keep `retriable: false` — a retried create could DUPLICATE a
  page/block. Notion queries are POST, so retry keys on operation
  idempotency, not HTTP method.

## Verify

- `@muse/mcp` notion-notes-retry.test.ts (new, 3, contract-faithful
  Notion fake): `list()` recovers from a 429-then-200 (2 calls, the
  page parsed) instead of throwing; a permanent 401 fails fast with
  ONE call (`NOTION_AUTH`); a `save()` create is NOT retried on 429
  (one call, `NOTION_RATE_LIMIT`) — duplicate-page protection.
- **Mutation-proven**: forcing `maxRetries = 0` → the 429-recovery
  test fails (the write-not-retried test still passes, confirming the
  flag scopes correctly); restore → 3/3. `pnpm check` EXIT 0, `pnpm
  lint` 0/0. HTTP read (not an LLM request/response path) → no
  `smoke:live`.

## Decisions

- **Idempotency flag, not HTTP method** — Notion read queries are POST
  (`/search`, `/databases/:id/query`), so a method-based GET-only rule
  would miss them; the explicit `retriable` flag on the read sites is
  the correct signal, and writes stay single-shot.
- No bullet flip — extends the P19 read-retry posture (weather/email/
  smart-home/Google-cal/CalDAV) to the Notion notes backend.
  tasks-providers-notion is the sibling follow-on. CAPABILITIES line
  under P19.
