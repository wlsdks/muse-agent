# 071 — Calendar provider fallback to local when remote fails

## Why

If Google Calendar listEvents fails, fall back to LocalCalendarProvider
events instead of returning empty.

## Scope

- Read CalendarProviderRegistry.listEvents.
- Add try/catch per-provider with local fallback.
- Surface the fallback in the response metadata.

## Verify

- calendar +1 test.

## Status

open
