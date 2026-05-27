## 874 — feat: `muse tasks list --search` — find a task by text

## Why

`muse tasks list` filtered only by status (open/done/all) — there was
no way to FIND a task by what it's about ("which task mentions the
dentist?"). On a todo list that grows, eyeballing the whole list is the
only option. Notes have search; tasks didn't. A small, real daily
triage gap.

## Slice

`apps/cli` commands-tasks.ts:
- `filterTasksBySearch(tasks, query)` — pure, case-insensitive substring
  match on title OR notes (operates on the serialized task records, so
  it works identically for the local file and the API payload). Empty
  query → all; no match → none.
- `muse tasks list --search <text>` applies it after the status filter,
  in both `--local` and remote modes, and recomputes `total`.

## Verify

`apps/cli` commands-tasks.test.ts (+4): `filterTasksBySearch` matches a
title, matches notes case-insensitively, returns all on empty / none on
no-match; and `muse tasks list --local --search dentist --json` returns
only the matching task from the real store (drives the real CLI + store).
- **Mutation-proven**: making the filter return all regardless of query
  fails the match + no-match + integration tests.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. Local store, no LLM path.

## Decisions

- **Client-side filter in both modes** — no API change; the list payload
  (local or remote) is filtered the same way, so behaviour is identical.
- Substring over title + notes (not tags — `--status`/tag filters are
  separate) covers the "what was that task about X" intent simply.
- No new dependency.
