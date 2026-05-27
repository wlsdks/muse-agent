# 792 — feat: CalDAV calendar read recovers from transient 5xx (P19, sibling to 788)

## Why

788 hardened the Google Calendar read against transient 5xx; CalDAV
(iCloud / Fastmail / Proton / Nextcloud) is the other calendar backend
a user may run, and its `listEvents` REPORT read was still single-shot
— a momentary 429/5xx threw straight to the briefing and dropped the
calendar. Completing the per-actuator hardening across BOTH backends.

## Slice

`@muse/calendar` caldav-provider.ts:
- Inject retry config (`retry?: { retries=2, baseDelayMs=250, sleep }`)
  and wrap the `listEvents` REPORT read in a retry-with-backoff loop:
  a transient 429/5xx (per the existing `isRetryableCalendarStatus`)
  or a network reject retries with exponential backoff; a
  non-retryable 401/403/404 fails fast. The write paths (PUT create /
  update, DELETE) stay single-shot — a retried mutation could
  double-create / double-delete an event.

## Verify

- `@muse/calendar` calendar.test.ts (+2, contract-faithful CalDAV
  multistatus XML fake): a 503-then-200 on the REPORT read recovers (2
  calls, the VEVENT parsed) instead of throwing; a permanent 401 (bad
  app-password) fails fast with exactly ONE call.
- **Mutation-proven**: disabling the retryable-status branch → the
  503-recovery test fails; restore → 2/2. Full calendar suite 54/54
  (no regression in the ICS-parse / write / Google / macOS paths),
  `pnpm check` EXIT 0, `pnpm lint` 0/0. Calendar read (not an LLM
  request/response path) → no `smoke:live`.

## Decisions

- **Read-only retry, mirrors 788** — only `listEvents` (the idempotent
  REPORT) retries; the PUT/DELETE writes are untouched. Reuses the
  package's `isRetryableCalendarStatus` so CalDAV and Google agree on
  what's transient.
- No bullet flip — P19's "one actuator" bullet is `[x]`; this completes
  the calendar-read hardening across both backends (Google 788 +
  CalDAV here). CAPABILITIES line under P19.
