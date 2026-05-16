# 260 — Slack/LINE dropped long messages whole (goals 221/222 sibling)

## Why

Goals 221 (Telegram) and 222 (Discord) fixed the same bug: a
brief / answer / proactive notice longer than the shared outbound
cap was **dropped whole** instead of delivered truncated. Their
`send` now does:

```ts
const outboundText = clampOutboundText(message.text, <platformLimit>);
validateOutboundMessage({ ...message, text: outboundText });   // validates the CLAMPED text
// … send outboundText
```

Slack and LINE — the other two messaging providers — were never
brought onto that pattern. Both did:

```ts
async send(message) {
  validateOutboundMessage(message);          // RAW text
  … body: { text: message.text }             // RAW text
}
```

`validateOutboundMessage` **throws** `MessagingValidationError`
when `text.length > 4096`. So a `muse brief` / long `muse ask`
answer / proactive heads-up routed to the user's Slack or LINE,
once it exceeds 4096 chars, threw at validation and the entire
notification was silently lost — exactly the goal 221/222 failure
class, on two of the four providers. (Slack's 40 000 and LINE's
5 000 platform limits are *above* 4096, so the platform itself
wouldn't drop it — it was Muse's own pre-send validation throw
that killed the message.)

## Scope

`packages/messaging/src/line-provider.ts` and
`slack-provider.ts` — apply the established Telegram/Discord
pattern:

- `import { clampOutboundText }` from `./provider-helpers.js`.
- `const outboundText = clampOutboundText(message.text);` (default
  4096 — the shared cap, comfortably within both platforms'
  limits), then `validateOutboundMessage({ ...message, text:
  outboundText })`, then send `outboundText` (LINE
  `messages[0].text`, Slack body `text`).

A too-long message is now delivered truncated with the standard
`… [truncated]` marker instead of dropped. All four messaging
providers (Telegram / Discord / Slack / LINE) are now consistent.
Only the send path changed; inbound, error handling, and receipts
are untouched.

## Verify

- `pnpm --filter @muse/messaging test` — 121 pass (was 119; +2).
  New Slack + LINE tests send a 5000-char message and assert the
  delivered text is exactly 4096 chars, ends with `… [truncated]`,
  and a normal receipt is returned (pre-fix `send` threw at
  `validateOutboundMessage` and nothing was delivered). The
  existing Slack/LINE happy-path + error tests stay green.
- `pnpm check` — every workspace green (messaging 121, apps/cli
  559, apps/api 155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (messaging outbound
  text clamp + provider HTTP, no model round-trip), so no Qwen
  round-trip applies; the deterministic provider unit tests are
  the rigorous verification.

## Status

done — every messaging provider now truncates an over-cap
outbound message and delivers it rather than throwing at
validation and silently dropping it. A long brief, answer, or
proactive notice reaches the user on Slack and LINE just as it
already did on Telegram and Discord.
