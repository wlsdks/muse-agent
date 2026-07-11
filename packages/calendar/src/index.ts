/**
 * Muse Calendar — provider-neutral calendar abstraction.
 *
 * Mirrors the `ModelProvider` shape: every backend (local file, Google
 * Calendar, CalDAV, macOS Calendar.app) implements the same
 * `CalendarProvider` interface so the agent's `muse.calendar.*` tools
 * work against any one of them. Multiple providers can coexist via
 * `CalendarProviderRegistry`.
 *
 * Design rules:
 *   - Identity: `CalendarEvent.id` is provider-scoped. Cross-provider
 *     calls must include `providerId`.
 *   - Time: all times are absolute `Date` (UTC instants); the agent
 *     decides timezone for rendering.
 *   - Failure: providers throw `CalendarProviderError` for upstream
 *     failures and `CalendarValidationError` for input rejections.
 *   - Auth: each provider declares the credential keys it needs via
 *     `CredentialRequirement`; the credential store is a separate
 *     concern (see `./credential-store.js`).
 */

export type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderInfo,
  CalendarRange,
  CredentialRequirement
} from "./types.js";
export { CalendarProviderError, CalendarValidationError, CALENDAR_RETRY_AFTER_CAP_MS, isRetryableCalendarStatus, parseRetryAfterMs } from "./errors.js";
export { eventsToIcs, type IcsEvent } from "./ics-export.js";
export { CalendarProviderRegistry } from "./registry.js";
export { LocalCalendarProvider, type LocalCalendarProviderOptions } from "./local-provider.js";
export { LocalIcsCalendarProvider, type LocalIcsCalendarProviderOptions } from "./local-ics-provider.js";
export { expandRecurringEvent, parseIcsCalendar } from "./ics-parse.js";
export {
  GoogleCalendarProvider,
  type GoogleCalendarProviderOptions
} from "./google-provider.js";
export { CalDAVCalendarProvider, type CalDAVCalendarProviderOptions } from "./caldav-provider.js";
export { MacOsCalendarProvider, type MacOsCalendarProviderOptions } from "./macos-provider.js";
export {
  FileCalendarCredentialStore,
  type CalendarCredentialStore,
  type ProviderCredentials
} from "./credential-store.js";
export {
  CALENDAR_KEYCHAIN_SERVICE,
  resolveCalendarSecret,
  type CalendarSecretSourceOptions
} from "./credential-resolver.js";
