## 873 — feat: `muse contacts export` — vCard out (data portability)

## Why

870 let the user bulk-import a vCard; the inverse — getting contacts
back OUT — didn't exist. A personal tool should let the user own and
move their data: back up the people graph, or migrate it to another
app. Completes the import/export pair.

## Slice

- `apps/cli` vcard.ts: `contactsToVcf(contacts)` — the inverse of
  `parseVCards`, serialising name/email/phone/birthday/aliases to vCard
  3.0; a nameless contact is skipped, empty input → "".
- `muse contacts export [file]` — writes the vCard to a file, or prints
  it to stdout when no path is given.

## Verify

- `apps/cli` vcard.test.ts: `contactsToVcf` round-trips through
  `parseVCards` (serialise → re-parse yields the same fields), skips a
  nameless contact, emits "" for none.
- commands-contacts.test.ts: a full `import → export → re-import into a
  fresh store` round-trip yields the same contacts (drives the real CLI
  + store both ways).
- **Mutation-proven**: dropping the TEL line from the serializer fails
  the round-trip test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. Local store, no LLM path.

## Decisions

- vCard 3.0 output (widest compatibility; same dialect 870 parses), so
  export → import is a clean round-trip.
- Round-trip is the verification of choice — it exercises the serializer
  AND 870's parser together, end-to-end through the real CLI/store.
- No new dependency.
