# `@muse/messaging` — the outbound edge

This is where content leaves for a third party. A wrong send is not a bug you roll back; it is a
message the owner did not write, arriving in someone else's inbox. Two rules bind every change
here, and they are enforced in code, never in prompt text.

**1. Draft-first, never auto-send.** The agent produces the exact content and the **owner
confirms that content** before it leaves. The approval gate
(`createChannelApprovalGate` / `toolApprovalGate`) is fail-closed: denied, undeliverable, or
timed-out confirmation means the send does not happen. A recipient that does not resolve
unambiguously triggers a clarifying question, never a best guess.

**2. Every reply suppresses link previews.** A platform's own crawler fetches URLs in a message
to build a preview — no click required — so an injected link in model-authored text exfiltrates
on delivery, approved or not (EchoLeak / CamoLeak class). Each provider carries its parameter:
Telegram `link_preview_options: { is_disabled: true }`, Discord `flags: 4`, Slack
`unfurl_links: false, unfurl_media: false`. LINE and Matrix have no sender-side field — that gap
is recorded, not forgotten. **A new provider ships with its suppression wired, or with its
absence written down here and in the rule below.**

A send capability is delivered only when its test proves deny / timeout / ambiguous-recipient /
absent-consent produce **no external effect** — a happy-path test alone is not delivery.

Full contract: [`.claude/rules/safety/outbound-safety.md`](../../.claude/rules/safety/outbound-safety.md).
Repository-wide brief: [`AGENTS.md`](../../AGENTS.md).
