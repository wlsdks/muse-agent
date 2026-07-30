# @muse/messaging

Owns Muse's inbound/outbound channel surface: per-provider chat adapters (Telegram, Discord,
Slack, LINE, Matrix, macOS/Linux desktop notifications), their durable inbox/thread/cursor
stores, and the approval + outbound-effect machinery that gates anything a channel provider sends
to a third party. It is a package because every provider must satisfy the same fail-closed send
contract before a message can leave the process.

## Public surface

- `MessagingProviderRegistry` — holds the active `MessagingProvider`s, dispatches by ID.
- `TelegramProvider`, `DiscordProvider`, `SlackProvider`, `LineProvider`, `MatrixProvider`,
  `LogMessagingProvider`, `MacosNotificationProvider`, `LinuxLibnotifyProvider` — one adapter per
  channel implementing the shared `MessagingProvider` type.
- `createChannelApprovalGate`, `summarizeToolDraft`, `respondToInbound`,
  `createThreadedInboundRunner`, `inboundKey` — the fail-closed confirmation gate a risky tool call
  must pass, and running/threading an agent turn against one inbound message.
- `recordPendingApproval`/`claimPendingApproval`/`completePendingApproval` plus
  `prepareOutboundEffect`/`acquireOutboundEffectDispatch`/`dispatchOutboundEffectOnce` — the
  durable draft-approval state machine and the exactly-once-intent effect dispatcher it unlocks.
- `appendInbound`, `readInbox`, `appendThreadTurns`, `readThread`, the per-provider poll cursor
  stores, `validateOutboundMessage`, and the `MessagingProviderError`/`MessagingValidationError`
  taxonomy — durable inbox/thread state and outbound payload validation.
- `FileMessagingCredentialStore`, `verifyMessagingToken`, `FileBackedInboxContextProvider` —
  credential storage, webhook token verification, and inbox-to-context projection.

## Depends on

- `@muse/shared` — JSON/error/time primitives shared across the monorepo.

## Rules that bind this package

This package sits on the outbound-to-human safety boundary in
[`../../.claude/rules/outbound-safety.md`](../../.claude/rules/outbound-safety.md): every send is
draft-first (`channel-approval-gate.ts` confirms before `outbound-effect-dispatch.ts` fires),
fail-closed on a denied/timed-out approval, and every provider ships its link-preview/unfurl
suppression wired at the send call site — `link_preview_options.is_disabled` (Telegram), `flags: 4`
(Discord), `unfurl_links`/`unfurl_media: false` (Slack). LINE and Matrix have no sender-side
suppression field; that gap is accepted residual risk per the rule file, not closed here.

## Tests

```bash
pnpm --filter @muse/messaging test
```
