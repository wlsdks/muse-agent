# 768 — feat: knowledge_search spans contacts — unified personal corpus (notes + tasks + calendar + contacts)

## Why

The corpus spanned notes (755) + tasks (766) + calendar (767). The
fourth pillar of the user's personal data is CONTACTS — "what's Bob's
email?", "who's the Acme rep?". Adding it completes a single semantic
search across the user's whole world: a question about a person, a
deadline, a meeting, or a note is answered + cited from one tool.

## Slice

`@muse/autoconfigure` knowledge-corpus.ts:
- `ContactLike` / `ContactsSource` (structural — `{ list() }`).
- `assembleKnowledgeCorpus` gains `contactsSource`: each contact →
  `contact/<id>` chunk (`name <email> (handle) — also: aliases`).
  Fail-open if the store throws.
- `createNotesKnowledgeSearchTool` accepts `contactsSource`; the
  assembly wires `{ list: () => queryContacts(resolveContactsFile(env)) }`
  so the live tool searches notes + tasks + calendar + contacts.

## Verify

- `@muse/autoconfigure` knowledge-contacts-source.test.ts (new, 2)
  against the REAL contacts store (`addContact` → `queryContacts` over
  a temp file):
  - corpus emits `contact/c1` with name + email + alias.
  - end-to-end `knowledge_search("what's bob acme's email?")` answers
    from the store and cites `contact/c1` (`bob@acme.com`).
- Prior knowledge tests still green (notes / tasks / calendar, 8/8).
- **Mutation-proven**: dropping the `contact/` source prefix fails
  both the corpus-shape and citation assertions; restore → 2/2.
- Full `pnpm check` EXIT 0 (autoconfigure 185, every workspace green);
  `pnpm lint` 0/0. Real contacts store + deterministic fake embed — no
  model request/response path → no `smoke:live`.

## Decisions

- **All contacts (no window)** — a contact list is small and timeless;
  unlike calendar, there's no recency window to apply.
- **`contact/<id>` source label** — a cited answer names the contact
  store as origin. No bullet flip — P20 knowledge is already `[x]`;
  this completes the core personal corpus (notes + tasks + calendar +
  contacts), each a live source with its own citation prefix.
