# 015 — Web UI history panel

## Why

Follows up 014. The web app at `apps/web/src/ui/personal-panels.tsx`
has tasks / notes / reminders / calendar panels but no activity
feed. With `/api/history` live, add an HistoryPanel that polls
or refreshes on demand.

## Scope

- New `apps/web/src/ui/history-panel.tsx` (~120 LOC).
- Uses tanstack-query against `/api/history`.
- Kind-filter dropdown + limit + relative time formatting.
- Mount in `App.tsx` next to the other personal panels.

## Verify

- pnpm check / lint / smoke broad.
- web test +1 (component render).
- Visual dogfood: `pnpm --filter @muse/web dev`, panel renders
  the seeded entries.

## Status

deferred — backend prerequisite (`GET /api/history`, goal 014)
landed. The React panel + queryClient wiring + Playwright e2e
+ style-match to personal-panels.tsx is its own focused iter
(~150 LOC plus visual dogfood loop). Re-open as a dedicated UI
iter; batching alongside the API change would dilute review.
