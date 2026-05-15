# 190 — quarantine corrupt reminders + followups stores too

## Why

Goal 189 closed the silent-corrupt-overwrite data-loss vector
for `tasks.json` and explicitly flagged the sibling stores.
`readReminders` and `readFollowups` had the **identical** bug:
a present-but-unparseable `reminders.json` / `followups.json`
(partial write after a crash) returned `[]`, so the next
`muse remind add` / firing-loop write / `markFollowupFired`
overwrote the corrupt file with just the new entry —
permanently destroying every prior reminder/followup. A lost
reminder is arguably worse than a lost task (missed
appointment).

## Scope

- `packages/mcp/src/personal-reminders-store.ts` and
  `packages/mcp/src/personal-followups-store.ts`:
  - Each gets the goal-189 `quarantineCorruptStore(file)` —
    best-effort `rename(file, \`${file}.corrupt-<ts>\`)`,
    swallow errors. Called in the two present-but-corrupt
    branches (parse throws / wrong shape) before returning
    `[]`. The ENOENT branch is unchanged.
  - The helper is a 6-line zero-branch best-effort rename;
    duplicated per store rather than coupling three sibling
    store modules through a shared import (nothing to diverge —
    unlike the goal-181 comparator case).

## Verify

- `pnpm --filter @muse/mcp test` — 334 pass (2 new: reminders
  + followups each assert the corrupt bytes are preserved in
  `*.corrupt-*` and a later write doesn't destroy them).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure fs/store logic).

## Status

done — all three personal stores (tasks 189, reminders +
followups 190) now quarantine a corrupt file for manual
recovery instead of being silently overwritten on the next
write. The permanent-loss vector is closed across the
personal-data layer.
