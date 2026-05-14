# 016 — `muse search --to-notes <path>`

## Why

After a useful `muse search` run, the user often wants to save the
top results to a research note. Currently they redirect stdout +
hand-edit. Make it one flag: `muse search "X" --to-notes
research/X.md` writes a formatted markdown file with title +
url + snippet per result.

## Scope

- New flag in `commands-search.ts`.
- When set, build markdown body + call the same notes-save MCP
  the loopback uses.
- ANSI strip stays (security 7b40b0f).
- `--overwrite` flag (default error if file exists).

## Verify

- pnpm check / lint / smoke.
- cli +2 tests (writes file; rejects without --overwrite when
  file exists).

## Status

open
