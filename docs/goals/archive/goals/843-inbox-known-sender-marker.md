## 843 — feat: `muse inbox` flags mail from people you know

## Why

The proactive brief triages the inbox by who's writing (837); the
on-demand `muse inbox` command did NOT — it listed messages in feed
order with a `●` for unread but no sense of which are from people you
actually know vs newsletters. Triage means seeing the people first.

## Slice — CLI-only, additive marker (no format break)

`apps/cli` commands-inbox.ts:
- `formatInboxLine(message, known)` — the existing `●`-unread line plus
  a trailing `★` when the sender is a known contact (additive, so the
  prior exact line format is unchanged for unknown senders).
- `buildInboxKnownSender(env)` — a predicate matching a sender's email
  (via the 837 `extractEmailAddress`) against the contacts graph
  (`queryContacts`); fail-soft (unreadable / absent contacts file →
  always-false, listing unchanged, never throws).
- `registerInboxCommand` gained an injectable `isKnownSender` (built
  from contacts in production) and marks each listing line accordingly.

## Verify

`apps/cli` commands-inbox.test.ts (+4, 8 total):
- `formatInboxLine` adds a trailing `★` for a known contact, none
  otherwise, across unread/read;
- the listing flags a known sender's line (`● Alice … ★`) and leaves an
  unknown sender's line bare (injected predicate);
- `buildInboxKnownSender` matches a sender against a real temp contacts
  file by email, and not a stranger;
- it's fail-soft on an unreadable contacts file (always-false).
- The existing 4 inbox tests stay green (the marker is additive; their
  fixtures aren't contacts → no `★`). **Mutation-proven**: dropping the
  `★` fails the marker tests; making the email-match always-false fails
  the contacts-match test. `apps/cli` 131/131, `pnpm check` EXIT 0,
  `pnpm lint` 0/0. CLI read + display, no LLM path → no smoke:live.

## Decisions

- **Trailing `★`, not a reordering** — unlike the proactive brief's
  "name the few" line (837), `muse inbox` is a full chronological
  listing; reordering it by known-sender would scramble the timeline,
  so a per-line marker preserves order while flagging who matters.
- **Additive marker** so the established line format (and its tests)
  is untouched for unknown senders. CAPABILITIES line under the CLI
  inbox surface (no bullet flip — brings 837's people-first signal to
  the on-demand command).
