# 694 — P11 (read slice): Muse reads + triages the Gmail inbox — `EmailProvider` abstraction + `GmailEmailProvider` (Gmail REST, Bearer token, no SDK / no new dep) + `summarizeInbox` + a read-only `muse inbox` command; contract-faithful Gmail-HTTP-faked integration

## Why

P11 (email) is "the single biggest missing surface". The first bullet
is read-first: read / triage / summarise the inbox via a provider
behind the abstraction. Its check is explicitly a **contract-faithful
HTTP-faked inbox (integration)** — so the Gmail REST API (HTTP,
`fetch`, no SDK) is the natural fit, with the token supplied by the
user (a guided OAuth flow is a separate later slice; the read provider
+ faked-HTTP integration is the named deliverable).

Read-only: reading the inbox is world-sensing, so no outbound-safety
gate applies (the rule governs only actions toward a third party).
Sending is the SECOND P11 bullet — draft-first + gated, separate.

## Slice

- `packages/mcp/src/email-provider.ts` (new):
  - `EmailProvider` interface (`listRecent(limit)`), `EmailSummary`
    (`{ id, from, subject, snippet, date?, unread }`).
  - `GmailEmailProvider` — Gmail REST (`/users/me/messages` list +
    `?format=metadata` per message), `Authorization: Bearer <token>`,
    injectable `fetchImpl`; parses From/Subject/Date headers + snippet
    + `UNREAD` label; 401/403 → clear auth error; caps limit to 50.
  - `summarizeInbox(messages)` — pure triage line ("N messages, M
    unread" + unread subjects). Exported from `@muse/mcp`.
- `apps/cli/src/commands-inbox.ts` (new): `muse inbox` — token from
  `MUSE_GMAIL_TOKEN`, lists recent inbox with a triage summary + an
  unread marker; `--limit` / `--json`; missing token / provider error
  → clear stderr + exit 1. Registered in `program.ts`.
- Tests:
  - `@muse/mcp` email-provider.test.ts (6): contract-faithful Gmail
    HTTP fake (routes list vs metadata-get, asserts the Bearer header,
    Gmail-shaped JSON) → parsed summaries with `unread` from labelIds;
    Bearer sent on every call; 401 → auth error; empty inbox;
    `summarizeInbox` counts + unread-subject listing.
  - `@muse/cli` commands-inbox.test.ts (4): triage listing (summary +
    `●` unread marker), `--json`, provider auth error → exit 1,
    missing-token hint → exit 1.

## Verify

- `@muse/mcp` email-provider.test.ts: 6 passed. `@muse/cli`
  commands-inbox.test.ts: 4 passed.
- **Clean-mutation-proven**: forcing `unread: false` (dropping the
  `labelIds.includes("UNREAD")` parse) fails the "marking unread"
  contract test. Restored; green.
- `pnpm check`: EXIT=0 (cross-package: mcp + cli). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM request/response path touched — the provider is read-only
  HTTP (faked in tests); the bullet's check is the contract-faithful
  HTTP fake, which the integration test provides. (Live use needs a
  real Gmail OAuth token — a future `muse auth gmail` slice.)

## Status

P11 read/triage/summarise delivered. P11's first bullet stays `[ ]`
pending its other clause — wiring needs-reply inbox items into the P8
situational briefing (reuses the weather→briefing grounding pattern
from goal 690). The second P11 bullet (send, draft-first + gated)
remains and will use the goal-691 `resolveContact` for recipient
resolution per `outbound-safety.md`.

## Decisions

- **Gmail REST over `fetch`, no SDK / no new dep** — the bullet's
  "HTTP-faked" check fits the REST API; `googleapis` would be a heavy
  dep. The provider takes a Bearer access token (env) so the OAuth
  acquisition is a separable concern.
- **Provider in @muse/mcp** — alongside weather/contacts, the layer the
  briefing daemon + CLI both consume; the needs-reply→briefing flip
  slice will reuse it.
- **`summarizeInbox` is deterministic, pure** — a triage summary
  ("12 messages, 3 unread" + unread subjects) needs no LLM and is
  cheaply testable; an LLM inbox digest can layer on later.
- **Read-only, no gate** — explicitly per `outbound-safety.md`
  ("Muse may read the world freely").

## Remaining risks

- **OAuth token acquisition not built** — `muse inbox` needs a
  user-supplied `MUSE_GMAIL_TOKEN`; a guided `muse auth gmail` flow
  (refresh-token handling) is a future slice, so the command is
  integration-proven but not yet live-usable without the user
  obtaining a token. This matches the bullet's faked-inbox check.
- **Gmail-only** — IMAP/other providers would be additional
  `EmailProvider` implementations behind the same abstraction.
- **N+1 HTTP calls** (list + per-message metadata) — fine for a
  small `--limit`; a batch/`q=` refinement could reduce calls later.
