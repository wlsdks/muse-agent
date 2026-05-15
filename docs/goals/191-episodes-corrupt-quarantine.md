# 191 — quarantine the corrupt episodic-memory store too

## Why

Goals 189/190 closed the silent-corrupt-overwrite data-loss
vector for `tasks.json`, `reminders.json`, and `followups.json`.
`episodes.json` — the agent's **episodic memory** (every past
session's recap, the thing that keeps a fresh `muse chat` from
starting amnesiac) — had the identical and arguably worst
instance of the bug:

- `readEpisodes` returned `[]` on a present-but-unparseable or
  wrong-shape file (a partial write after a crash).
- `upsertEpisode` is read → filter-by-id → write. With the read
  silently empty, the end-of-session hook's next upsert wrote a
  file containing **only** the newest episode — permanently
  destroying every prior session's memory. For a JARVIS-style
  agent this is the highest-value store to protect: losing it
  means the assistant forgets the user entirely.

## Scope

- `packages/mcp/src/personal-episodes-store.ts`: the same
  goal-189 `quarantineCorruptStore(file)` — best-effort
  `rename(file, \`${file}.corrupt-<ts>\`)`, errors swallowed —
  called in the two present-but-corrupt branches of
  `readEpisodes` before returning `[]`. ENOENT branch unchanged.
  Helper duplicated per store (6-line zero-branch rename;
  nothing to diverge, consistent with the 189/190 decision).

## Verify

- `pnpm --filter @muse/mcp test` — 335 pass (1 new: a corrupt
  `episodes.json` is preserved at `*.corrupt-*` and a later
  `upsertEpisode` does not destroy the quarantined bytes).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure fs/store logic) — no
  smoke:live needed.

## Status

done — the personal-data layer is now uniformly safe: tasks
(189), reminders + followups (190), and episodic memory (191)
all quarantine a corrupt file for manual recovery instead of
being silently overwritten on the next write. The
permanent-loss vector is closed across every user-data store
in `packages/mcp`.
