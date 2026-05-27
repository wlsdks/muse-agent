# 695 — P11 read bullet COMPLETE: the proactive situational briefing surfaces unread email — a non-empty brief gains an `Inbox: N unread — …` digest when an email provider is configured; supplementary (never triggers a brief alone), fail-soft, silent on a clean inbox

## Why

Goal 694 shipped the P11 read half (`EmailProvider` /
`GmailEmailProvider` / `muse inbox`) but kept the bullet `[ ]` because
its other clause — "needs-reply items feed the P8 situational
briefing" — was unaddressed. This iteration wires it, reusing the
weather→briefing grounding pattern (goal 690), and flips P11's read
bullet.

## Slice

- `packages/mcp/src/email-provider.ts`: `unreadBriefingLine(messages)`
  — a compact unread digest ("3 unread — “Q3 plan” (Alice), …", up to
  3 named subjects with sender display-names + "+N more"), or
  `undefined` when nothing is unread (the briefing stays quiet about a
  clean inbox). Exported from `@muse/mcp`.
- `packages/mcp/src/situational-briefing.ts`: optional `inbox?: string`
  on the input → renders an `Inbox: <line>` row. Same posture as
  `weather`: supplementary, excluded from the empty-check, so it never
  triggers a brief on its own.
- `packages/mcp/src/situational-briefing-loop.ts`: optional
  `emailProvider` + `emailLimit`; when set AND the brief has content,
  `resolveInboxLine` (fail-soft) fetches recent messages and passes the
  unread digest to the composer.
- `apps/api` `startSituationalBriefingTick` + the
  `…DaemonIfConfigured` wiring: thread an `emailProvider`
  (`GmailEmailProvider` from `MUSE_GMAIL_TOKEN`) through to the daemon.

## Verify

- `@muse/mcp` (19 across the touched files): situational-briefing-loop
  gains "grounds the briefing with unread inbox items from the email
  provider (P11)" — an `EmailProvider` returning a mix of read/unread
  delivers a brief over the real `TelegramProvider` whose POSTed text
  contains `Inbox: 1 unread — “Q3 plan” (Alice)` alongside the imminent
  item, with the READ message excluded; email-provider.test.ts gains
  `unreadBriefingLine` (named subjects + "+N more"; undefined when all
  read).
- **Clean-mutation-proven**: removing the composer's `Inbox:` render
  fails the briefing integration test (the unread digest no longer
  appears in the delivered message). Restored; green.
- `pnpm check`: EXIT=0 (cross-package: mcp + api). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM request/response path touched — the composer is pure; the
  inbox is a read-only HTTP fetch (faked in the test). `smoke:live`
  N/A (live use needs a real Gmail OAuth token).

## Status

**P11 read bullet FLIPPED** (694 read/triage/summarise + 695
briefing-feed). The agent reads + summarises the inbox AND unread
items surface in the proactive briefing, both contract-faithful
integration-proven. The SECOND P11 bullet (send — draft-first, gated,
recipient via the goal-691 `resolveContact`, per `outbound-safety.md`)
remains.

## Decisions

- **Supplementary, never a trigger** (same as weather) — unread email
  enriches an already-worthwhile brief; it does not fire a brief on its
  own, avoiding inbox-driven notification spam. An empty tick makes no
  inbox HTTP call.
- **Silent on a clean inbox** — `unreadBriefingLine` returns `undefined`
  for 0 unread, so the brief never says "inbox clean".
- **Sender display-name, not raw address** — "Alice", not
  "Alice <a@x.com>", for a readable digest; falls back to the address
  when there's no display name.
- **`MUSE_GMAIL_TOKEN`-gated** — the daemon only adds the inbox line
  when a token is configured; absent ⇒ no email in the brief (no error).

## Remaining risks

- **OAuth token for live use** — same as 694; the briefing-feed is
  integration-proven but live use needs a real Gmail token (a future
  `muse auth gmail` slice).
- **"Unread" ≈ "needs reply"** — the digest uses the UNREAD label as
  the needs-attention proxy; a smarter needs-reply heuristic (sender
  is a known contact, question detected) is a future refinement.
- **P11 send still pending** — the gated, draft-first send is the
  remaining P11 bullet.
