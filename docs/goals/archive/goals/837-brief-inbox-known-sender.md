## 837 — feat: the brief triages the inbox by who's writing (people first)

## Why

The morning brief's unread line named the first few unread by feed
order — so a newsletter or a promo could crowd out the email from a
person you actually need to reply to. A JARVIS triages the inbox by
WHO'S writing: mail from someone in your contacts is what matters.
This composes the inbox digest with the contacts graph.

## Slice

- `@muse/mcp` email-provider.ts — `unreadBriefingLine(messages,
  {isKnownSender?})`: when the predicate is given, unread from a known
  sender is surfaced FIRST (stable sort — same-priority keeps
  newest-first order) and flagged "★", so the named few are the people,
  not the feeds. Plus a pure `extractEmailAddress(from)` ("Alice
  <a@x.com>" → "a@x.com", lowercased; undefined when none) for matching
  a sender against contacts.
- `@muse/mcp` situational-briefing-loop.ts — `inboxKnownSender?`
  predicate threaded through `resolveInboxLine` → `unreadBriefingLine`.
- `apps/api` briefing-tick + tick-daemons.ts — wire the predicate from
  a once-at-start snapshot of the contacts' email addresses (a per-call
  file read would hammer disk; a daemon restart refreshes), so the
  brief surfaces people-you-know first when Gmail + contacts are
  configured.

## Verify

`@muse/mcp` inbox-known-sender.test.ts (5):
- `extractEmailAddress`: display-name header → lowercased address;
  bare address; undefined when none.
- `unreadBriefingLine`: a known contact (2nd in feed order) is named
  FIRST and "★"-flagged; without the predicate, feed order + no ★.
- **End-to-end** through the REAL `runDueSituationalBriefing` + a
  capturing messaging provider: the delivered brief's `Inbox:` line
  reads "3 unread" and surfaces "★ … (Bob Acme)" first.
- **Mutation-proven**: dropping the known-first sort fails the
  people-first ordering; dropping the "★" flag fails both ★ assertions.
  `@muse/mcp` 899/899, `pnpm check` EXIT 0, `pnpm lint` 0/0. A
  proactive brief, not a model tool / no LLM path → no smoke:live.

## Decisions

- **Stable sort, known-first** — V8's sort is stable, so prioritising
  known senders preserves newest-first within each group; only the
  people/feeds split moves.
- **Snapshot contacts once at daemon start** — matching every unread
  sender against a fresh file read would hammer disk each tick; a
  start-time snapshot is cheap and a restart refreshes it (a personal
  daemon restarts on deploy). CAPABILITIES line under P20 proactive
  brief (no bullet flip — deepens the existing briefing capability).
