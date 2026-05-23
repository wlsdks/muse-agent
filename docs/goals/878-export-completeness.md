## 878 — fix: `muse export` bundles contacts / feeds / objectives / vetoes / personas

## Why

`muse export` ("bundle every ~/.muse/*.json store + the notes tree")
backs the user's data into a tar.gz — but `DEFAULT_EXPORT_FILES` had
silently grown stale: it OMITTED `contacts.json` (the whole people
graph), `feeds.json` (watched RSS/Atom), `objectives.json` (standing
objectives), `vetoes.json` (learned avoidances), and `persona.json`
(custom personas). A user backing up and restoring would LOSE all of
those — a real backup-integrity / data-ownership defect, exactly where
the user trusts the bundle to be complete.

## Slice

`apps/cli` commands-export.ts: add the five missing user-data stores to
`DEFAULT_EXPORT_FILES`. Transient files (session-lock, briefing-fired)
stay out by design; credentials/inboxes/tasks/reminders/etc. were
already covered.

## Verify

`apps/cli` commands-export.test.ts (new, +2): driving the REAL
`buildMuseExport` against a temp `~/.muse` seeded with
contacts/feeds/objectives/vetoes/persona/tasks → the returned bundle
manifest (`files`) contains every one; and `DEFAULT_EXPORT_FILES` lists
the five recently-added stores.
- **Mutation-proven**: dropping `contacts.json` from the list fails both
  tests (bundle omits it; list assertion fails).
- `pnpm check` EXIT 0, `pnpm lint` 0/0. Local fs bundling, no LLM path.

## Decisions

- The omissions accrued as new stores shipped (contacts phone 853/866,
  feeds 855, objectives, vetoes, personas) without updating the export
  list — a classic "new store, forgot the backup manifest" seam. The
  test now pins the recently-added stores so the next store addition
  that forgets the manifest is caught.
- `collectSources` already skips absent files, so listing a store the
  user hasn't created is harmless.
- No new dependency.
