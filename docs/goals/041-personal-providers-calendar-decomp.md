# 041 — Extract buildCalendarRegistry into registry-builders/calendar.ts

## Why

Continuing goal 007's partial work. messaging was extracted; calendar
is next-most-cohesive (~87 LOC + tryBuildCalendarProvider helper).

## Scope

- Mirror 007's pattern: new file under registry-builders/.
- Re-export from personal-providers.ts.
- Drop the now-unused imports from personal-providers.ts.

## Verify

- All gates green. personal-providers.ts < 530 LOC.

## Status

open
