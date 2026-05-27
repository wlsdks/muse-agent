# 788 — feat: Google Calendar read recovers from transient 5xx (P19 hardening)

## Why

P19 actuator/perception hardening. Calendar is a daily-driver's
most-used perception, but `GoogleCalendarProvider.request` made a
single-shot fetch — a transient 429/5xx on the events read threw
straight to the briefing, dropping the calendar entirely ("nothing on
your calendar" when really Google blipped). The package already had
the classification (`isRetryableCalendarStatus` +
`CalendarProviderError.retryable`) but nothing retried.

## Slice

`@muse/calendar` google-provider.ts:
- Inject retry config (`retry?: { retries=2, baseDelayMs=250, sleep }`)
  and wrap `request` in a retry-with-backoff loop for the IDEMPOTENT
  GET read only (`init.method === "GET"`). A transient 429/5xx (per
  the existing `isRetryableCalendarStatus`) or a network reject retries
  with exponential backoff; a non-retryable status (403/404) fails
  fast. Writes (POST/PATCH/DELETE) are NEVER retried — a retried
  mutation could double-create / double-delete an event.

## Verify

- `@muse/calendar` calendar.test.ts (+2, contract-faithful HTTP fake):
  a 503-then-200 on the events read recovers (2 API calls, the event
  parsed) instead of throwing; a permanent 403 fails fast with exactly
  ONE API call (no hammering a non-retryable status).
- **Mutation-proven**: forcing `maxRetries = 0` → the 503-recovery
  test fails (throws); restore → 2/2. Full calendar suite 52/52 (no
  regression in the existing read/write/ICS/macOS paths), `pnpm check`
  EXIT 0, `pnpm lint` 0/0. Calendar read (not an LLM request/response
  path) → no `smoke:live`.

## Decisions

- **GET-only retry** — keyed on the HTTP method so the same `request`
  helper hardens the read without ever retrying a mutation. Reuses the
  package's own `isRetryableCalendarStatus` (429 + 5xx) rather than a
  new classifier, so the retry and the `CalendarProviderError.retryable`
  flag agree.
- No bullet flip — P19's "one actuator" bullet is `[x]`; this is the
  per-actuator follow-on (calendar read) after weather / email-read /
  smart-home-read / web-action. CalDAV's read is a later sibling slice.
