## 854 — feat: `muse inbox <id>` reads one email's full body

## Why

`muse inbox` listed message summaries (from / subject / snippet) but
there was **no way to read the actual content of an email from the
CLI** — the provider already had `EmailReader.getMessage(id)`
(returning the full plain-text body) and `GmailEmailProvider`
implemented it, but no surface exposed it, and the listing didn't show
the id you'd need to pick one. So "read me the email from Bob" was
impossible at the terminal despite the capability being built. A
JARVIS that can list but not read its user's mail is half a reader.

## Slice — read-path on the existing inbox command

`apps/cli` commands-inbox.ts (reuses the same token / provider
plumbing — no new command group, no new dep):
- The listing now prints a short id per line — `[m1] ● Alice — Q3 plan`
  — so a message is addressable (`shortMessageId`).
- `muse inbox [id]` — with an id, resolves it (exact, else short-id
  prefix) against the recent inbox and prints the full message via
  `getMessage`: `formatEmailMessage` renders From / Subject / Date then
  the plain-text body (snippet fallback handled upstream). `--json`
  emits the full `EmailMessage`. Omit the id → the list behaves exactly
  as before.
- Read-only, fail-soft: unknown id, a provider without `getMessage`, a
  `getMessage` that returns undefined / throws → a clear stderr line and
  exit 1, never an exception.

## Verify

`apps/cli` commands-inbox.test.ts (+5, 14 total):
- reads a message by short id — asserts From/Subject/Date + body; `--json`
  emits the full object; an unknown id exits 1 reading nothing; a
  list-only provider (no `getMessage`) exits 1 with a clear message.
- the listing shows `[m1] …` so an id is copyable.
- `formatEmailMessage` renders headers+body, trims, falls back to
  "(no text body)", and omits Date when absent.
- **Mutation-proven**: making the id resolution ignore the target
  (always first message) fails the unknown-id test; removing the
  `getMessage`-presence guard fails the list-only-provider test.
- `pnpm check` EXIT 0 (apps/cli 133/133, 1407 tests), `pnpm lint` 0/0.
  Read-only Gmail, no LLM request/response path → no smoke:live.

## Decisions

- **Optional positional arg, not a new subcommand / group.** `muse
  inbox` is the read surface; `muse inbox <id>` keeps the read with the
  list and reuses the exact token + provider injection already there.
  `muse email` stays the outbound (draft-first, gated) group — reading
  doesn't belong under it.
- **Short-id prefix resolution.** Gmail ids are long; the listing shows
  an 8-char prefix and the read path resolves it against `listRecent(50)`
  (exact match first, then unique prefix) before `getMessage` — the same
  ergonomics as task short ids. A full id still works (exact branch).
- No new dependency; provider typed `EmailProvider & Partial<EmailReader>`
  so list-only fakes still satisfy the signature.
