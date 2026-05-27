# 775 — fix: the briefing's "Related" line no longer echoes the imminent item

## Why

773 surfaced a related-knowledge line in the briefing by querying the
unified corpus with the top imminent item's title. But the corpus
INCLUDES calendar events (and tasks), so for a calendar-imminent item
the best match was often that SAME event — the brief would render:

```
Upcoming:
- in 30 min: Acme strategy meeting
Related: [event/ev1] Acme strategy meeting on 2026-…
```

— a redundant echo of what Upcoming already shows. The "Related" line
should add context the brief DOESN'T already schedule (a prep note, a
contact), not repeat the imminent item.

## Slice

- `@muse/autoconfigure` `createKnowledgeEnricher` gains
  `excludeSourcePrefixes`: it now ranks the top 5 and returns the
  first match whose source does NOT start with an excluded prefix
  (was: top 1).
- The briefing daemon builds its enricher with
  `excludeSourcePrefixes: ["event/", "task/"]` — the brief already
  lists the imminent calendar/task under Upcoming, so its "Related"
  line draws from notes / contacts (genuine context). The AMBIENT
  enricher keeps the full corpus (its key is the active window, not
  the schedule — surfacing an upcoming event there is useful, not an
  echo).

## Verify

- `@muse/autoconfigure` knowledge-enricher-exclude.test.ts (new, 2):
  with a corpus of a note + a calendar event, a query matching the
  event surfaces `[event/ev1]` WITHOUT exclusion (the echo), and the
  `[notes/acme.md]` note WITH `excludeSourcePrefixes: ["event/",
  "task/"]` (genuine context, no echo).
- Prior enricher tests still 3/3 (the option is additive; top-5 +
  no-exclusion preserves the single-best behavior).
- **Mutation-proven**: replacing the non-excluded `find` with
  `matches[0]` (ignore the exclusion) makes the event echo through →
  the WITH-exclusion test fails; restore → 2/2.
- Full `pnpm check` EXIT 0 (autoconfigure 194, apps/api 314, every
  workspace green); `pnpm lint` 0/0. Deterministic filter + fake embed
  — no model path → no `smoke:live`.

## Decisions

- **Exclude by source prefix, channel-specific** — the briefing
  excludes its own scheduled surface (`event/` + `task/`); the ambient
  channel excludes nothing (different key, different redundancy
  profile). One enricher, per-channel exclusion.
- **Top-5-then-filter, not top-1** — so a filtered echo falls through
  to the next-best genuine match instead of yielding nothing. No
  bullet flip — quality fix to the 773/774 anticipation
  (CAPABILITIES line).
