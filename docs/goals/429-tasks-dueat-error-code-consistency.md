# 429 — `PATCH /api/tasks` invalid-dueAt error code matches POST

## Why

API-contract consistency fix on a fresh axis (`apps/api`
route handlers — the remote surface every CLI `--remote` /
daemon path hits; never touched by the recent
observability/autoconfigure/persona cluster).

The error `code` field is the **machine-readable** contract a
client branches on (the CLI remote mode, scripts, future
surfaces) — the human `message` is not. For an unparseable
`dueAt` on a task:

- `POST /api/tasks`  → `code: "INVALID_TASK_DUE_AT"`
- `PATCH /api/tasks/:id` → `code: "BAD_DUE_AT"`  ← deviation

Same condition (`parseTaskDueAt` failure on `dueAt`), same
resource, **two different codes**. The sibling
`reminders-routes.ts` uses `INVALID_REMINDER_DUE_AT`
consistently for both its POST and snooze paths, so the
codebase-wide convention is `INVALID_<RESOURCE>_DUE_AT`; tasks
POST follows it, the PATCH handler was the lone ad-hoc
`BAD_DUE_AT`. A client correctly handling "invalid task due
date" on create silently fails to recognise it on edit. And no
test pinned the PATCH code, so the divergence was both invisible
and free to drift further.

## Slice

- `apps/api/src/tasks-routes.ts` — `PATCH /api/tasks/:id`'s
  invalid-`dueAt` response code `BAD_DUE_AT` → `INVALID_TASK_DUE_AT`,
  matching the POST handler and the `INVALID_<RESOURCE>_DUE_AT`
  convention. Status (400) and message (the parser's actionable
  text) are unchanged.
- `apps/api/test/server.tasks.test.ts` — regression: a bad
  `dueAt` on POST **and** on PATCH both return 400 with
  `code === "INVALID_TASK_DUE_AT"` (the same code). Fails on the
  pre-fix code (PATCH was `BAD_DUE_AT`); also closes the
  previously-uncovered PATCH-invalid-`dueAt` path.

## Verify

- `@muse/api` server.tasks.test.ts 4/4 (3 existing + 1 new);
  full `@muse/api` suite green (195, +1); tsc strict (api) clean.
- `pnpm check` EXIT=0, every workspace green (api 195, cli 731,
  …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- HTTP route validation verified deterministically via
  `server.inject`; not a model request/response path — no
  `smoke:live` applies.

## Status

Done. A client can now branch on the single
`INVALID_TASK_DUE_AT` code for an invalid task due date whether
it created or edited the task — the tasks routes are
self-consistent and aligned with the reminders routes' identical
convention. The contract is now pinned by a test so it can't
drift again.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; an API-contract consistency fix to an existing
route, recorded honestly as a `fix(api):` change with this
backlog row — not a false metric.

## Decisions

- Aligned PATCH to POST/reminders (`INVALID_<RESOURCE>_DUE_AT`)
  rather than the reverse: POST + the entire `reminders-routes`
  family already use that shape, so changing the lone outlier is
  the minimal, convention-preserving fix (no client that follows
  the documented convention is affected — only one that special-
  cased the bug).
- Did not audit/rename other ad-hoc codes in the file this
  iteration (scope discipline — `INVALID_TASK` / `TASK_NOT_FOUND`
  are already convention-shaped); a broader code-audit, if
  warranted, is a separate slice, not bundled.
