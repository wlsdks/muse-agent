# 804 — feat: Notion tasks read recovers from a transient 429 (P19, sibling to 803)

## Why

803 hardened the Notion NOTES read against the API's 429 rate-limit;
`NotionTasksProvider` is the sibling backend (the user's tasks may live
in Notion too) and was still single-shot — a momentary 429 dropped the
task list / search. Completing the Notion backend read-retry across
both providers.

## Slice

`@muse/mcp` tasks-providers-notion.ts — inject retry config
(`retry?: { retries=2, baseDelayMs=250, sleep }`) + a `retriable` flag
on the shared `request`: transient 429/5xx retries with exponential
backoff ONLY on the idempotent reads (`list` query, `search`). Writes
(`add` create, `complete` PATCH) keep `retriable: false` — a retried
create could duplicate the task.

## Verify

- `@muse/mcp` notion-tasks-retry.test.ts (new, 3, contract-faithful
  Notion fake): `list()` recovers from 429-then-200 (2 calls, the task
  parsed); a permanent 401 fails fast in ONE call (`NOTION_AUTH`); an
  `add()` create is NOT retried on 429 (one call, `NOTION_RATE_LIMIT`).
- **Mutation-proven**: forcing `maxRetries = 0` → the 429-recovery
  test fails, write-not-retried still passes; restore → 3/3. Full
  `pnpm check` EXIT 0, `pnpm lint` 0/0. HTTP read (not an LLM
  request/response path) → no `smoke:live`.

## Decisions

- **Mirrors 803 exactly** — same `retriable`-flag mechanism (Notion
  queries are POST, so idempotency, not HTTP method, drives the
  retry). Notion notes (803) + tasks (804) now both survive a
  rate-limit blip while their writes stay single-shot.
- No bullet flip — P19 read-retry posture, Notion backend complete.
  CAPABILITIES line under P19.
