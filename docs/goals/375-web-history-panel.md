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

slice 2 done — kind-filter + limit controls wired to the query
params. `HistoryPanel` now has `useState` for `kind`
(all/reminder/proactive/followup/pattern/episode) + `limit`
(20/50/100); two `<select>`s in the heading; `queryKey` includes
`[kind, limit]` so the feed refetches on change. Exported pure
`buildHistoryQuery(kind, limit)` builds the `/api/history` URL
(omits `kind` for "all"). +3 tests (buildHistoryQuery all/kind
cases; controls render with options). Legacy goal → exempt from
the outward test/CAPABILITIES metric per the legacy-grandfather
rule; verified via `@muse/web` suite + lint + full check +
smoke:broad (all green). Remaining: slice 3 (mount in `App.tsx`
+ Playwright e2e) — closes the legacy epic.

## Decisions

- `buildHistoryQuery` is an exported pure helper (mirrors slice-1's
  `relativeFromNow`) so the query-param wiring is deterministically
  unit-tested without simulating React `onChange` in a static
  render.
- No `CAPABILITIES.md` line: 375 is in the immutable legacy set
  {373,375}; its remaining slices are explicitly metric-exempt.

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
