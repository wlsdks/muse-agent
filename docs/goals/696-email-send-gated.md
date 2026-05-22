# 696 — P11 COMPLETE: draft-first, fail-closed outbound email — `sendEmailWithApproval` (resolve recipient → draft → approval gate → send/refuse → action-log) + `GmailEmailProvider.send` + `muse email send`; deny / timeout / ambiguous-recipient ⇒ NO send, contract-faithful integration

## Why

P11's read half (694/695) is done. The send half is the FIRST Muse
capability that transmits content to a third party, so it is governed
by `.claude/rules/outbound-safety.md` and its acceptance check must
prove the gate, not the happy path: deny / timeout / ambiguous-recipient
must produce NO external effect. Security here is deterministic code.

## Slice

- `packages/mcp/src/email-provider.ts`: `EmailSender` interface +
  `GmailEmailProvider.send(to, subject, body)` — Gmail REST
  `messages/send`, Bearer, base64url-encoded RFC822 MIME; 401/403 →
  clear auth error.
- `packages/mcp/src/email-send.ts` (new): `sendEmailWithApproval`
  enforcing the four outbound-safety rules in order —
  1. **Recipient resolved** via `resolveContact`; ambiguous → returns
     candidates (clarify), unknown / no-email → refused — NO send.
  2. **Draft-first + fail-closed gate**: the approval gate receives the
     exact draft; deny OR a thrown gate (undeliverable prompt / timeout)
     ⇒ NO send.
  3. **Send once** with the confirmed content via the injected
     `EmailSender`.
  4. **Recorded**: every outcome (performed / refused / failed) appends
     a rationale-bearing action-log entry.
- `apps/cli/src/commands-email.ts` (new): `muse email send --to
  --subject --body` — the surface; default gate prints the draft +
  a `@clack/prompts` confirm; default sender = `GmailEmailProvider`
  (`MUSE_GMAIL_TOKEN`); deps injectable for tests.

## Verify

- `@muse/mcp` email-send.test.ts (6) — the bullet's named check,
  contract-faithful (real `GmailEmailProvider.send` over a faked fetch
  that records POSTs, never a fake registry):
  - CONFIRM → exactly one `/messages/send` POST carrying the Bearer +
    the base64url body, and a `performed` action-log entry.
  - DENY → 0 sends, `refused` logged.
  - gate throws (timeout/undeliverable) → 0 sends (fail-closed).
  - AMBIGUOUS recipient (two "Bob"s) → 0 sends even with an approving
    gate, candidates returned to clarify, `refused` logged.
  - UNKNOWN recipient → 0 sends. Handle-only contact (no email) → 0.
- `@muse/cli` commands-email.test.ts (3): confirm → sent; deny → no
  send, exit 1; ambiguous → candidates listed, no send, exit 1.
- **Clean-mutation-proven**: removing the `if (!decision.approved)
  return` guard makes a DENIED send fire (`sent: true`) — the DENY test
  catches it. Restored; green.
- `pnpm check`: EXIT=0 (cross-package: mcp + cli). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM path touched — the send is read-of-contacts + a gated HTTP
  POST (faked in tests). Live use needs a real Gmail OAuth token.

## Status

**P11 COMPLETE** — read (694: inbox/triage) + briefing-feed (695) +
send (696: draft-first, gated). The single biggest missing surface now
exists end-to-end behind the outbound-safety contract.

## Decisions

- **Email field, not the generic identifier** — `resolveContact`'s
  `contactIdentifier` falls back to a chat handle (`@dave`, which
  contains `@`); email send uses `contact.email` specifically, so a
  handle-only contact is refused, never mailed to `@dave`. (Caught by
  the handle-only test.)
- **Gate-throw is fail-closed** — a thrown approval gate (prompt
  undeliverable, timeout) is treated as not-approved; a send never
  proceeds because the confirmation step failed.
- **Ambiguous never sends even when the gate would approve** — the
  recipient check precedes the gate, so an ambiguous "Bob" is refused
  with candidates before any draft is confirmed.
- **Orchestration in @muse/mcp, transport injected** — the gate logic
  is the safety-critical part and is tested contract-faithfully with
  the real `GmailEmailProvider.send` over a faked fetch; the CLI is a
  thin surface.

## Remaining risks

- **OAuth token for live use** — `muse email send` needs a real Gmail
  token (`gmail.send` scope); a guided `muse auth gmail` flow is a
  future slice. The bullet's check is the contract-faithful integration,
  which this provides.
- **No reply-threading / CC/BCC** — a minimal To/Subject/Body send;
  reply-in-thread and richer headers are future additions.
- **Gmail-only** — other providers are additional `EmailSender`
  implementations behind the same interface.
