## 870 — feat: `muse contacts import` — bulk-load an address book from a vCard

## Why

The people graph could only be populated one contact at a time
(`muse contacts add`). Onboarding a JARVIS means importing the user's
existing address book — every phone / mail client exports vCard (.vcf).
Without bulk import, the contacts graph (which now feeds resolution,
knowledge_search 866, the briefing's birthdays) starts empty and stays
sparse. A genuinely-new daily capability, local + zero-dependency.

## Slice

- `apps/cli` vcard.ts: `parseVCards(text)` — a pure, dependency-free
  reader for the fields Muse's Contact uses (FN / EMAIL / TEL / BDAY /
  NICKNAME), across vCard 3.0 + 4.0, multiple cards per file, with line
  unfolding and property-parameter stripping (`EMAIL;TYPE=work:`); first
  EMAIL/TEL wins. `normalizeVCardBirthday` maps YYYY-MM-DD / YYYYMMDD /
  --MMDD / MM-DD to the Contact store's birthday shape.
- `muse contacts import <file.vcf>` — parses, then adds each reachable
  card (name + email or phone; bare labels skipped) to the local store,
  de-duped by email OR phone so re-importing the same export doesn't
  pile up. Reports imported / skipped counts (`--json` for a payload).

## Verify

- `apps/cli` vcard.test.ts: `parseVCards` parses multiple cards (params
  stripped, first email/tel wins, aliases from NICKNAME, bday
  normalized), unfolds a continued line, skips a card with no FN;
  `normalizeVCardBirthday` accepts the 4 forms / rejects junk.
- commands-contacts.test.ts: `import` adds the 2 reachable cards + skips
  the bare label, persists to the real store (queryContacts), and a
  re-import imports 0 (de-dup by email OR phone — covers a phone-only
  card).
- **Mutation-proven**: removing the reachability gate imports the bare
  label and fails the count test.
- `pnpm check` EXIT 0 (a tsc `cards[1]!` non-null was needed in the
  test — caught by check, not vitest), `pnpm lint` 0/0. Local store,
  no LLM path.

## Decisions

- **De-dup by email OR phone**, not just email — a phone-only card has
  no email to key on, so email-only dedup would re-import it every run.
- Parser is permissive (keeps a no-contact-method card) and the IMPORT
  gate is strict (drops it) — separation lets `parseVCards` stay a clean
  reader while the reachability policy lives with the store write.
- No new dependency (vCard is line-based text).
