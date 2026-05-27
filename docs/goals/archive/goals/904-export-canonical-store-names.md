# Goal 904 — `muse export` bundles the canonical store filenames (was excluding the local calendar)

## Outward change

`muse export` now backs up `calendar.json` (your local calendar
events) and `messaging.json` (messaging credentials) — the files the
code actually writes. Before, the export catalog listed
`calendar-local.json` and `messaging-credentials.json`, **names
nothing in the codebase has ever written**, so those entries were
always skipped and the real stores were never in the bundle. A user
who ran `muse calendar add` and then `muse export` got a backup with
**no calendar in it** — and on restore, every local event was gone.
Silent data loss, invisible until you needed the backup.

## Why this, now

The exhaustive-list seam this run keeps surfacing (export 878,
scheduler-next 890, status-objectives 891, open-jobs 903): a catalog
that claims completeness but is out of sync with the stores the code
writes. Here it was worse than an omission — the catalog named
phantom files. The canonical path resolver
(`@muse/autoconfigure` `provider-paths.ts`) is the single source of
truth: `resolveLocalCalendarFile → calendar.json`,
`resolveMessagingCredentialsFile → messaging.json`. The export list
had drifted to dead names. A backup tool that silently drops user
data is the highest-severity correctness gap a daily driver can have.

## How

`DEFAULT_EXPORT_FILES` in `commands-export.ts`:
- `messaging-credentials.json` → `messaging.json`
- `calendar-local.json` → `calendar.json`

`calendar-credentials.json` stays — it IS a real file (the calendar
registry's OAuth credentials, distinct from the local-event store).
Verified by grep that nothing in production writes the two phantom
names (only the export list referenced them), so replacing rather
than keeping them as legacy aliases drops no real data. The encrypt-
path doc comment's stale example was corrected too.

## Verification

`apps/cli` `commands-export.test.ts` (`npx vitest run --root apps/cli
commands-export.test.ts`, 4 passing): a behavioral test seeds a temp
`~/.muse/calendar.json` + `messaging.json`, runs the real
`buildMuseExport`, and asserts both appear in `out.files` (drives the
actual `collectSources` path, not just the const); plus a catalog test
asserting the phantom names are gone and the canonical ones present.
Mutation-proven: reverting `calendar.json` back to the phantom
`calendar-local.json` fails the behavioral + catalog tests; restored
green. `pnpm check` fully green (apps/cli 1588, apps/api 323); `pnpm
lint` 0/0. Pure file IO, no LLM path → no smoke:live (Ollama down
regardless).

## Decisions

- Replaced the phantom names rather than keeping them as legacy
  aliases: a grep proved no code path ever wrote them, so there is no
  legacy data on any install to preserve — carrying dead entries is
  the exact catalog rot that caused the bug.
- Scoped to the two confirmed phantom-name bugs (calendar + messaging
  creds). Other unlisted stores (`action-log.json`, `session-lock.json`,
  cursor/offset/dedupe files) are separate judgment calls — session
  locks and cursors are ephemeral and correctly omitted from a backup;
  whether the accountability log belongs in a portable bundle is its
  own slice, not this bug.
