# Goal 924 — contacts store tolerates a wrong-typed field (P19 contacts-actuator hardening)

## Outward change

`readContacts` now coerces a hand-edited / externally-synced
`contacts.json` whose optional fields carry the wrong type: a contact
written with `phone: 14155550101` (a JSON number, not a string), a
numeric `email`, a numeric `birthday`, or an `aliases` array holding a
non-string entry. Before, the "tolerant read" let such an entry
through (the read gate only checked `id` + `name`), and then the FIRST
query that fell through to the phone/handle clause crashed
`resolveContact` with `TypeError: a.replace is not a function` —
taking down resolution for the **entire** address book, not just the
malformed contact. So `find_contact` ("who is bob@x.com?") and the
outbound recipient-resolution backbone would throw for every lookup
because one unrelated contact had a numeric phone.

Now the bad field is dropped (the contact is KEPT, resolvable by its
remaining good fields), so resolution never crashes and the user
doesn't lose a whole contact over one stray field.

## Why this, now

P19 hardens the one-of-each actuators against real failure modes;
contacts was the named follow-on after the web-search slice (923). A
local store's analogue of "malformed third-party response" is a store
mutated outside Muse's typed `writeContacts` path — a vCard/Google
sync script or a hand-edit that emits a bare number for a phone. The
store's own docstring promises "tolerant read, corrupt store
quarantined aside"; a `TypeError` that crashes ALL resolution is
exactly the un-tolerated failure that posture exists to prevent, and
it hits the highest-stakes surface (recipient resolution feeds
outbound-safety).

## How

Replaced the boolean `isContact` type guard (only validated `id` +
`name`, then returned the RAW entry typed as `Contact` — a lie when
optional fields were wrong-typed) with a `coerceContact(value):
Contact | undefined` that:
- drops the whole entry when `id` or `name` is missing/non-string
  (unchanged behaviour);
- keeps each optional field (`email` / `handle` / `phone` /
  `birthday`) ONLY when it is actually a string, else omits it;
- filters `aliases` to its string members.

So the returned `Contact[]` genuinely matches the `Contact` type, and
every downstream consumer (`phoneMatches`, `stripLeadingAt`,
`parseBirthdayMonthDay`, `serializeContact`) can trust it.

## Verification

`packages/mcp` `contacts-malformed-read.test.ts` (NEW; `npx vitest run
--root packages/mcp contacts-malformed-read.test.ts`, 3 passing)
drives the REAL `readContacts` over a real temp-dir `contacts.json`:
- a numeric `phone` / `email` / `birthday` and a mixed `aliases` array
  → the contact is kept with the bad fields dropped and the
  non-string alias filtered, well-typed fields preserved;
- the crash repro: `resolveContact(read, "bob@x.com")` (a query that
  falls through PAST a numeric-phone contact to the phone clause) now
  resolves the right contact instead of throwing, and the
  numeric-phone contact still resolves by name;
- an entry missing `id` or `name` is still dropped entirely.

Mutation-proven: reverting the flatMap to the old raw-passthrough
(`id+name string → [entry]`) fails the crash-prevention test
(`TypeError` in `resolveContact`) and the coercion assertions;
restored green. `pnpm --filter @muse/mcp test` 952 passing. `pnpm
check` green across every workspace (apps/cli 1674). `pnpm lint` 0/0.
Pure deterministic read-boundary coercion, no LLM/schema change → no
smoke:live (Ollama down regardless).

## Decisions

- Drop the bad FIELD, keep the CONTACT — not the whole entry. A
  numeric phone shouldn't cost the user the ability to resolve that
  person by name; dropping only the offending field loses the least
  data while still guaranteeing the type. (An entry with no valid
  `id`/`name` is still dropped — there's nothing usable left.)
- Fixed at the READ boundary (`coerceContact`) rather than scattering
  `typeof` guards across `phoneMatches` / `stripLeadingAt` /
  serialization — one gate makes the in-memory `Contact` trustworthy
  for all consumers, present and future.
