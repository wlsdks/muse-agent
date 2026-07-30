# @muse/calendar

Owns Muse's provider-neutral calendar abstraction: one `CalendarProvider` interface that every
backend (local file, local ICS, Google Calendar, CalDAV, macOS Calendar.app) implements, so the
agent's `muse.calendar.*` tools work identically regardless of which calendar the user actually
has. It is a package rather than a folder because event identity, time representation, and error
taxonomy must be uniform across backends for the agent to reason about "the calendar" as one thing.

## Public surface

- `CalendarProvider`, `CalendarEvent`, `CalendarEventInput`, `CalendarEventUpdate`,
  `CredentialRequirement`, `CalendarProviderRegistry` — the provider-neutral contract every
  backend implements, and the registry holding multiple active providers by `providerId`.
- `LocalCalendarProvider`, `LocalIcsCalendarProvider`, `GoogleCalendarProvider`,
  `CalDAVCalendarProvider`, `MacOsCalendarProvider` — the concrete backend implementations.
- `decodeCalendarEventReference`, `encodeCalendarEventReference`, `selectExactCalendarEvent` —
  exact-event reference encoding so a tool call can address one specific event unambiguously.
- `projectCalendarRead`, `CalendarReadProjection`, `CalendarAvailabilityInterval` — read-side
  projection used to answer availability/detail questions.
- `eventsToIcs`, `parseIcsCalendar`, `expandRecurringEvent` — ICS import/export and recurrence.
- `FileCalendarCredentialStore`, `resolveCalendarSecret` — credential storage and secret
  resolution for the network-backed providers.
- `CalendarProviderError`, `CalendarValidationError`, `isRetryableCalendarStatus` — the provider
  error taxonomy and retry classification.

## Depends on

- `@muse/secrets` — keychain/secret resolution backing `resolveCalendarSecret`.
- `@muse/shared` — common primitives.
- `@muse/stores` — durable storage conventions used by the local providers.

## Rules that bind this package

Time is always an absolute `Date` (UTC instant); the agent decides timezone for rendering — a
provider must not silently localize. Providers throw `CalendarProviderError` for upstream
failures and `CalendarValidationError` for input rejections, matching the deterministic
error-classification discipline in
[`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md) (`retryable` is the
source of truth, never a hidden retry).

## Tests

```bash
pnpm --filter @muse/calendar test
```
