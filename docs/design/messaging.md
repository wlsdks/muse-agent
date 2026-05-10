# Messaging integrations

Personal-Muse can act as a JARVIS-style sender into the user's
chat platforms (Telegram / Discord / Slack / LINE) so a daily
brief, a scheduler reminder, or a long-running agent task can
ping the user wherever they actually read messages.

KakaoTalk is intentionally excluded — Kakao restricts general bot
APIs to verified business channels and unofficial libraries
violate the ToS (account-suspension risk). If a 1인 사용자
solution emerges later we revisit.

## Phasing

The work splits along the inbound axis:

- **Phase 1 (this iter): outbound-only.** All four platforms have a
  REST endpoint for sending a message — no WebSocket, no webhook,
  no polling. One `POST` per send. Verifiable end-to-end with a
  bot token; the hard parts (Discord Gateway, Slack Socket Mode,
  LINE webhook signature) stay deferred.
- **Phase 2 (next): inbound.** Per platform:
  - Telegram → `getUpdates` polling (long-poll loop)
  - Discord → Gateway WebSocket (`@discordjs/ws`)
  - Slack → Socket Mode (`@slack/socket-mode`)
  - LINE → webhook routes in `apps/api`, signature verified against
    `X-Line-Signature`.
- **Phase 3:** MCP loopback (`muse.messaging.send` /
  `muse.messaging.recent`) so the agent itself can route through
  it; CLI is still the user-facing surface.

## Architecture

Mirrors `packages/calendar`:

```
packages/messaging/
  src/
    types.ts                    MessagingProvider, OutboundMessage, OutboundReceipt
    registry.ts                 MessagingProviderRegistry
    credential-store.ts         FileMessagingCredentialStore (chmod 600)
    telegram-provider.ts        TelegramProvider (Bot API REST)
    discord-provider.ts         DiscordProvider (REST channels)
    slack-provider.ts           SlackProvider (chat.postMessage)
    line-provider.ts            LineProvider (push API)
    errors.ts                   MessagingProviderError, MessagingValidationError
    index.ts
```

Provider contract (Phase 1 surface):

```ts
interface MessagingProvider {
  readonly id: "telegram" | "discord" | "slack" | "line" | string;
  describe(): MessagingProviderInfo;
  send(message: OutboundMessage): Promise<OutboundReceipt>;
}
```

`OutboundMessage` always carries `destination` (a platform-native
chat / channel / user id) and `text`. Providers may extend with
optional fields (Discord embeds, Slack blocks) but the contract
must accept and round-trip plain text.

## Provider notes

- **Telegram** — `POST https://api.telegram.org/bot{TOKEN}/sendMessage`
  body `{chat_id, text}`. `parse_mode` optional. Returns the
  Telegram `Message` object; we surface `message_id`.
- **Discord** — `POST https://discord.com/api/v10/channels/{channelId}/messages`
  with header `Authorization: Bot {TOKEN}`, body `{content}`.
  Returns the message; we surface `id`. No Gateway connection
  required for outbound (the docs mislead — REST works for plain
  text).
- **Slack** — `POST https://slack.com/api/chat.postMessage` with
  header `Authorization: Bearer xoxb-...`, body `{channel, text}`.
  Returns `{ok, ts, channel, message}`; success requires `ok=true`,
  surface `ts` (the timestamp doubles as the message id).
- **LINE** — `POST https://api.line.me/v2/bot/message/push` with
  header `Authorization: Bearer {channelAccessToken}`, body
  `{to, messages: [{type: "text", text}]}`. Returns 200/empty on
  success; we surface a synthetic id (no message id from this
  endpoint — that's a quirk of LINE).

## Registry + credentials

`buildMessagingRegistry(env, credentials)` follows the
`buildCalendarRegistry` pattern:

1. Read `MUSE_MESSAGING_PROVIDERS` (CSV; defaults empty so the user
   opts in).
2. For each requested provider, look at env / credentials store
   for a token. If absent, skip silently.
3. Register the provider; otherwise it doesn't appear in
   `muse messaging providers`.

Tokens live in `~/.muse/credentials.json` (the same file calendar
uses) under a `messaging` key, chmod 600.

## CLI

```
muse messaging providers [--json]
  → list configured providers (human format default)

muse messaging send <provider> <destination> <text...> [--json]
  → POST /api/messaging/send {providerId, destination, text}
```

Phase 2 will add `muse messaging inbox` and `--watch`.

## API

```
GET  /api/messaging/providers
POST /api/messaging/send  {providerId, destination, text}
  → 200 { providerId, destination, messageId }
  → 400 INVALID_MESSAGING_REQUEST   (validation)
  → 404 MESSAGING_PROVIDER_UNKNOWN  (not registered)
  → 502 MESSAGING_PROVIDER_FAILED   (upstream rejected)
```

The 502 wrapping is important — Telegram/Discord/Slack/LINE all
return their own error shapes; the route normalises to one
`MessagingProviderError` payload.

## Out of scope (Phase 1)

- Inbound (covered by Phase 2)
- Per-platform rich payloads (embeds, blocks, flex messages)
- Rate limits / retry — keep one round-trip; if upstream 429s we
  surface it. Phase 2 can add a retry-with-backoff helper since
  inbound polling will need it anyway.
- KakaoTalk — see header.
