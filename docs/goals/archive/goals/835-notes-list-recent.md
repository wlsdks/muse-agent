## 835 — feat: "my recent notes" — notes list sort + modifiedAtIso

## Why

"What did I jot down recently?" / "open my latest note" is a daily
notes ask. `muse.notes` `list` returned entries with name / isDirectory
/ sizeBytes but NO modification time and NO ordering (filesystem order),
so the local model couldn't surface recent notes — it'd have to read
every file's metadata itself (it can't) or guess. This adds the
timestamp + a recency sort.

## Slice — deepen the existing tool (no new catalog entry)

`@muse/mcp` loopback-notes.ts — the `list` tool now:
- stats every entry (it already stat'd files for `sizeBytes`) and adds
  `modifiedAtIso` to each row;
- accepts an optional `sort: 'recent'` that orders newest-modified
  first;
- collects ALL visible entries, sorts, THEN slices to `maxListEntries`
  (so `recent` is a TRUE global newest-first, not just the first-N
  reordered) and reports `truncated` when the directory had more.
Omitting `sort` keeps the prior directory order. One tool + an optional
arg per tool-calling.md rule 5.

## Verify

`@muse/mcp` notes-list-recent.test.ts (3), over a REAL temp notes dir
with three files stamped at distinct mtimes (`fs.utimes`):
- `sort:'recent'` → `["new.md","mid.md","old.md"]` (newest first);
- every entry carries a `modifiedAtIso` matching the stamped mtime;
- without `sort`, all three are still listed (default order).
- **Mutation-proven**: removing the recency sort breaks the ordering
  test; dropping `modifiedAtIso` breaks the timestamp test. `@muse/mcp`
  test 889/889; `pnpm lint` 0/0. (Full `pnpm check` shows ONLY the
  known pre-existing voice-playback `/tmp` flake — `apps/cli` alone is
  131/131, the failure is the dist+src copies racing on shared `/tmp`
  under full-suite load, unrelated to this `@muse/mcp` change.) No LLM
  request/response-path change → no smoke:live.

## Decisions

- **Collect-all then sort then slice** rather than break-at-N then sort
  — a "recent" that only reordered the first N filesystem-order entries
  would silently miss a newer note later in the directory. Statting a
  personal-scale notes dir fully is cheap and makes the answer correct.
- **`modifiedAtIso` always present** (not gated on the sort) — it's
  cheap from the stat the listing already does and useful metadata for
  any caller. CAPABILITIES line under P20 notes daily-driver (no bullet
  flip — deepens the existing list tool).
