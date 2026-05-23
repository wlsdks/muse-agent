## 862 — feat: `muse notes delete` — prune a stale note so it stops surfacing

## Why

`muse notes` could list / read / search / save / append — but NOT
delete. A notes store you can only grow is a real daily-driver gap: an
outdated, wrong, or no-longer-needed note can't be removed, and it keeps
surfacing in `muse notes search` and (since 855/knowledge_search) in the
agent's knowledge corpus, degrading answer quality. Removing a note had
to be done by hand in the filesystem.

## Slice — delete across the shared notes engine

The CLI `--local` mode and the API routes both dispatch to
`createNotesMcpServer`'s tools, so the capability lands once at the
engine and surfaces everywhere:

- `@muse/mcp` loopback-notes.ts: a `delete` tool — path-traversal-guarded
  (`resolveSafe`), `nodeUnlink` the file; returns `{deleted:true,path}`,
  `{deleted:false,path}` for a missing note (not an error), and an error
  for a directory / missing path / traversal.
- `@muse/mcp` notes-providers.ts + notes-providers-local.ts: an OPTIONAL
  `NotesProvider.delete?(id)` contract method + `LocalDirNotesProvider`
  implementation (the filesystem provider the corpus uses). Optional so
  Notion / Apple providers opt in later without this being half-built.
- `apps/api` notes-routes.ts: `DELETE /api/notes?path=…` → `callTool`.
- `apps/cli` commands-notes.ts: `muse notes delete <path>` (`--local`
  via the tool, remote via REST DELETE), confirms "Deleted …" or
  "No note found …".

## Verify

- `@muse/mcp` notes-delete.test.ts (4): the delete tool removes an
  existing note (gone from read + list), reports `deleted:false` for a
  missing one, rejects traversal / missing path; `LocalDirNotesProvider.
  delete` returns true then false.
- `apps/cli` commands-notes.test.ts (+1): `muse notes delete --local`
  removes the file off the real `MUSE_NOTES_DIR` and confirms; a second
  delete reports not-found.
- mcp.test.ts: the loopback tool-count assertion updated 5 → 6
  (list/read/search/save/append/**delete**, delete = write risk).
- **Mutation-proven**: removing the `nodeUnlink` call leaves the file and
  fails the "note gone" test.
- `pnpm check`: mcp 924/924, api 323/323, cli 0 non-voice failures (the
  2 = the known voice-playback `/tmp` flake). `pnpm lint` 0/0.

## Decisions

- **Optional provider method.** Three providers implement `NotesProvider`
  (Local / Notion / Apple); a required `delete` would force half-baked
  Notion-archive / AppleScript-delete impls now. Optional `delete?`
  delivers the default local path completely and lets the others opt in
  cleanly — the CLI reports "not supported" rather than failing if a
  provider lacks it.
- **`deleted:false` is not an error.** Deleting a note that's already
  gone is idempotent-success-shaped, not a failure — the CLI says "No
  note found" and exits 0; only traversal / a directory / IO error is an
  error (exit 1).
- The new `muse.notes.delete` agent tool's SELECTION by the local model
  is [UNVERIFIED-LIVE] (Ollama down); the handler + CLI + REST + provider
  are deterministically verified. notes domain stays ≤7 tools (now 6).
- No new dependency.
