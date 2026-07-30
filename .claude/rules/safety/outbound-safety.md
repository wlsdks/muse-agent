# Outbound-to-human safety (fail-close)

Muse may read the world freely. **Acting on the world toward another
human is different** — a wrong autonomous send is not a bug you can
roll back, it is a message your user did not write arriving in
someone else's inbox. This file is the non-negotiable contract for
every capability that *transmits content to a person* or *performs a
state-changing external action*. It is enforced as deterministic code
and tested checks — never as a prompt please-be-careful.

## What this governs

Normal source-control publication to Muse's configured `origin` is governed by
[`../engineering/commits.md`](../engineering/commits.md), including its narrow standing authorization. It is
not authorization for any human-facing send or external action below.

Any action that:

- sends / replies / forwards a message to a **third party** (email,
  chat, DM, SMS, social post, comment),
- submits a form, books, orders, publishes, or otherwise causes an
  effect in someone else's system,
- acts under a standing objective on the user's behalf toward a third
  party.

Replying to the **user themselves** on their own channel is the
low-risk path for the *approval gate* (it already runs the channel
approval gate for risky tools) — but see "Passive-fetch mitigation"
below: low approval risk is not the same as zero output risk.
Everything toward a third party is high-risk and gated.

## The rules (all MUST hold)

1. **Draft-first, never auto-send.** The agent produces the exact
   content and the **user explicitly confirms that content** before
   it leaves. Generated text is never transmitted to a third party
   on the agent's own judgement.
2. **Approval gate is fail-closed.** Reuse the existing
   `createChannelApprovalGate` / `toolApprovalGate` seam. If the
   approval prompt cannot be delivered or is denied / times out, the
   action does **not** happen. A send never proceeds because the
   confirmation step failed.
3. **Recipient is resolved, never guessed.** The destination
   (address / handle / person) must resolve unambiguously (P13
   contacts). An ambiguous or unknown recipient triggers a clarifying
   question (the clarify-directive) — never a best-guess address.
4. **Recorded + reversible-where-possible.** Every outbound action —
   sent OR refused — appends a rationale-bearing entry to the action
   log with the exact content, and is subject to undo / veto /
   learned-avoidance like any other autonomous action.
5. **Standing objectives need recorded scoped consent** for the
   specific send class before they may act toward a third party
   (`performConsentedAction`); absent or scope-mismatched consent is
   fail-closed.

## Passive-fetch mitigation on every channel reply (fail-close, deterministic)

An indirect prompt injection (planted in a page / note / email / MCP
result Muse reads) can make the model end a reply with an attacker URL
carrying a secret in the query string. The moment that reply lands in
a chat platform, the PLATFORM's own server-side crawler can fetch that
URL to build a link preview — no click, no approval, secret
exfiltrated (EchoLeak CVE-2025-32711 / CamoLeak CVE-2025-59145 class).
This holds **regardless of approval status**: even an approved,
human-confirmed reply must not trigger a passive server-side fetch of
attacker-controlled text the model produced.

So every channel-reply send carries the provider's link-preview /
unfurl suppression parameter:

- **Telegram** — `link_preview_options: { is_disabled: true }` on `sendMessage`.
- **Discord** — `flags: 4` (`SUPPRESS_EMBEDS`) on the message-create body.
- **Slack** — `unfurl_links: false, unfurl_media: false` on `chat.postMessage`.
- **LINE** — no equivalent field exists on the text message object.
  Accepted residual risk.
- **Matrix** — no sender-side suppression field exists in the spec
  (`m.hint.no_preview` is an open proposal, matrix-org/matrix-spec#1588).
  Accepted residual risk; whether a preview is generated at all depends
  on the recipient's client/homeserver, not the sender.

A new outbound channel provider ships with its suppression parameter
wired — or, if genuinely unavailable, the gap recorded here — never a
provider that echoes the model's raw text into a platform capable of
crawling it.

## Out of scope — never built

- **Banking / financial-account access, payments, money movement, or
  trading.** Muse must not connect to bank/brokerage accounts,
  initiate transfers, or move money. The blast radius is
  irreversible and uninsurable for a single-user assistant; this is a
  hard product boundary, not a deferral.

## How a new outbound capability ships

A "send" / "act" capability is delivered ONLY when its acceptance
check proves the gate, not just the happy path: the test must show
that **deny / timeout / ambiguous-recipient / absent-consent produces
no external effect** (contract-faithful HTTP fake, never a fake
registry), alongside the confirmed-path send. A send capability whose
test only asserts the happy path is not delivered.
