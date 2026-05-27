# Goal 907 — `muse webhook` surfaces an unparseable `dueAt` instead of silently dropping it

## Outward change

When `muse webhook serve --as-task` receives a `POST /notify` whose
`dueAt` is present but unparseable (e.g. a Zapier/script sends
`{"dueAt":"next freday"}`), the server now tells the caller: it logs
`dueAt "next freday" not understood — task created without a due date`
to stderr AND returns `{"dueAtIgnored":"next freday"}` in the 202
response. Before, the bad `dueAt` was silently swallowed — the task
was created with no due date, the caller got a plain 202 success, and
the automation author had no way to learn their timestamp was dropped
(so the reminder they expected never fired).

## Why this, now

A cross-surface consistency seam. The sibling file-drop trigger
(`muse watch-folder`) deliberately surfaces an `unparsedHint` so a
typo'd `due:` line doesn't silently degrade (and 906 just hardened
that same surface). The HTTP trigger — the one most likely to be
driven by an unattended automation that can't see a CLI prompt — did
the opposite: it swallowed a bad `dueAt`. An automation that fails
silently is worse than one that errors, because the author keeps
trusting it. Bringing the webhook to parity closes that trap.

## How

Extracted two pure functions from the inline HTTP handler (the
extract-pure-function-from-handler pattern, so the logic is testable
without binding a socket):
- `resolveWebhookDueAt(rawDueAt, now)` — mirrors watch-folder's
  `resolveInboxDueAt`: returns `{ dueAt }` when understood,
  `{ unparsed }` when present-but-unparseable, `{}` when absent.
- `buildWebhookNotify(payload, now)` — normalises a notify payload
  (title/text slicing, empty-body → `ok:false`, notice formatting,
  dueAt resolution) into one value the handler maps to HTTP.

The handler now delegates to these, logs the stderr warning on the
`--as-task` path, and adds `dueAtIgnored` to the 202 JSON (only when
`--as-task` and a dueAt was actually dropped). Valid inputs are
byte-for-byte unchanged.

## Verification

`apps/cli` `commands-webhook.test.ts` (NEW; `npx vitest run --root
apps/cli commands-webhook.test.ts`, 8 passing): `resolveWebhookDueAt`
(valid→dueAt, typo→unparsed, absent/empty→{}); `buildWebhookNotify`
(JSON+valid dueAt, typo→`dueAtUnparsed` + NO dueAt, plain `body` field
+ default title "Webhook", empty→`ok:false`, title/text truncation +
240-char notice elision). Mutation-proven: making `resolveWebhookDueAt`
drop the unparsed case (return `{}`) fails the two surfacing tests;
restored green. `pnpm check` green (apps/cli 1622, apps/api 323);
`pnpm lint` 0/0. Pure handler logic, no LLM path → no smoke:live
(Ollama down regardless).

## Decisions

- Surfaced the dropped `dueAt` in BOTH stderr (for an operator
  watching the server) and the 202 body (for the unattended caller) —
  the automation author is the one who needs it and they only see the
  HTTP response.
- Extracted `buildWebhookNotify` rather than only the dueAt helper, so
  the whole payload-normalisation path (which was entirely untestable
  inside the `createServer` closure) gained direct coverage in passing.
