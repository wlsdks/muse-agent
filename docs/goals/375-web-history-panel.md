# 375 — Web UI history panel

> **LEGACY (pre-OUTWARD-TARGETS).** Remaining slices are exempt
> from the outward test/metric. Finish them first (one per
> iteration), then close. This tag never applies to any new goal;
> the legacy set is exactly {373, 375}.

Category: epic / legacy

(Carried forward from the pre-reset backlog. Backend prerequisite
`GET /api/history` already shipped; only the UI surface is unbuilt.)

## Why

`apps/web/src/ui/personal-panels.tsx` has tasks / notes / reminders
/ calendar panels but no activity feed, despite `/api/history`
being live. A JARVIS-class operator surface should show the
activity stream.

## Slices

1. **HistoryPanel component** — `apps/web/src/ui/history-panel.tsx`,
   tanstack-query against `/api/history`, relative-time formatting,
   style-matched to `personal-panels.tsx`. +1 component render test.
2. **Kind-filter + limit controls** — dropdown + limit selector
   wired to the query params.
3. **Mount + e2e** — mount in `App.tsx` beside the other personal
   panels; Playwright e2e asserting seeded entries render.

## Verify

- Per slice: `pnpm check`, `pnpm lint` (0/0), `pnpm smoke:broad`.
- Web component test per slice; Playwright e2e on the final slice.
- Visual dogfood: `pnpm --filter @muse/web dev`.

## Status

slice 1 done — `apps/web/src/ui/history-panel.tsx`: `HistoryPanel`
(tanstack-query `/api/history?limit=20`, style-matched to
`CalendarEventsPanel` — `tool-surface compact`, `surface-heading`,
`record-list`) renders the unified activity feed (kind · relative
time · status). Exported pure `relativeFromNow(iso, nowMs)` does
the relative-time formatting (just now / Nm·Nh·Nd ago / future
`in N…` / >7d locale date / junk passthrough). +5 component/unit
tests (no-data surface render, seeded-entry render, relative-time
buckets). Not yet mounted — slice 3 mounts it in `App.tsx` + e2e.

Outward gain: Presence — the operator can now see the Muse
activity stream in the web console (previously API-only).

Remaining: slice 2 (kind-filter + limit controls), slice 3
(mount + Playwright e2e).
