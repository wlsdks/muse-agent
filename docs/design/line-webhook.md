# LINE inbound — webhook + persisted inbox

LINE is the only Phase 2 platform that can't be polled — its
Messaging API only delivers via webhook. Telegram/Discord/Slack
all let `fetchInbound` pull recent messages on demand; for LINE
Muse must run a public HTTPS endpoint that LINE POSTs to, verify
the signature, and persist the events to a small inbox file that
`LineProvider.fetchInbound` later reads.

This design splits across three loops so each piece has its own
gates green:

## Phase 2.b.1 — store foundation (this iter)

- New `packages/messaging/src/inbox-store.ts` with two helpers:
  - `readInbox(file, limit?)` → newest-first array, capped at
    `limit` (default 100, max 200).
  - `appendInbound(file, message, { capacity? })` → writes the
    new entry, trims to `capacity` (default 500) by dropping
    the oldest. Atomic `tmp`+rename.
- Used by Phase 2.b.2 (the webhook handler appends) and
  Phase 2.b.3 (`LineProvider.fetchInbound` reads).
- Direct unit tests on the store — no webhook surface yet.

## Phase 2.b.2 — webhook route (next iter)

- New route `POST /api/messaging/webhooks/line` registered only
  when `MUSE_LINE_CHANNEL_SECRET` is set.
- Custom content-type parser scoped to that route captures the
  raw body buffer so HMAC-SHA256 signature verification matches
  the bytes LINE sent (re-stringifying loses byte stability).
- Signature: `Buffer.compare(timingSafeEqual)` of computed vs
  `X-Line-Signature` header. 401 on mismatch, 200 + empty body
  otherwise (LINE retries non-2xx for ~30 minutes).
- Parse `events[]`; for each `type === "message"` with
  `message.type === "text"`, append to
  `~/.muse/line-inbox.json` via `appendInbound`.

## Phase 2.b.3 — provider read path (next-next iter)

- `LineProvider.fetchInbound(opts)` reads from `line-inbox.json`
  via `readInbox`. Honours `opts.limit` (default 20, capped to
  whatever the file holds).
- The "LINE doesn't support inbound yet" guard in the registry
  becomes obsolete; the inbox-store guards the case where the
  user hasn't received any messages yet (empty file → empty
  array, not an error).
- Existing `MessagingProviderRegistry.fetchInbound` works
  unchanged — Line just gains the method.

## Capacity + retention

`~/.muse/line-inbox.json` holds the most recent 500 inbound
entries (configurable via `MUSE_LINE_INBOX_CAPACITY`). LINE
retains messages for 30 days on its end, so the file is just
a fast-access cache; if it's lost the user can re-pull from
LINE directly via their own data export.

Each entry: `{ messageId, source, sender?, receivedAtIso, text,
raw }` — the same `InboundMessage` shape Telegram/Discord/Slack
already produce. Rich payloads (stickers, images, location)
serialise as text descriptions where reasonable; binary content
isn't persisted (the `raw` field can carry the original event
JSON for callers who want to walk it).

## Out of scope

- Multi-channel inbox (one user, one LINE account assumed).
- Replying to webhook events using the `replyToken` (24-hour
  window). Phase E if asked.
- Migration from polling to webhooks for Telegram/Discord/Slack
  — those work fine via Phase 2.a's REST `fetchInbound`; webhook
  alternatives are a different cost/benefit trade.
