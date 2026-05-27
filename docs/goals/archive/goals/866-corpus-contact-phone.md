## 866 — fix: contact phone reaches the knowledge corpus (853 seam)

## Why

853 added a `phone` field to contacts (stored, returned by
`find_contact`, shown in `muse contacts`). But the knowledge-corpus
contact source — what `knowledge_search` draws on — built each contact
chunk from name / email / handle / aliases only. `ContactLike` didn't
even carry `phone`. So "do I have a number for Sarah?" / "what's mom's
phone" routed through the broad `knowledge_search` tool could NOT be
answered from the corpus (only the narrower `find_contact` tool had the
phone). A stored field that never reached one of its consumers — the
same seam class as 864 (recall-vs-delete).

## Slice

`@muse/autoconfigure` knowledge-corpus.ts:
- `ContactLike` gains `phone?`.
- The contact chunk text appends `phone <number>` when present (the word
  "phone" rides along so a "phone / number" query embeds toward it).

The production wiring already passes full `Contact` objects (which carry
`phone` since 853) into `contactsSource`, so no wiring change — only the
type + chunk text needed it.

## Verify

`@muse/autoconfigure` knowledge-contacts-source.test.ts (+1): a contact
added with a phone yields a `contact/<name>` chunk whose text contains
`phone +1 415 555 0101` (driven through the REAL `addContact` →
`queryContacts` → `assembleKnowledgeCorpus`).
- **Mutation-proven**: dropping the phone push from the chunk fails it.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. (Corpus assembly is
  deterministic; the `knowledge_search` embedding/selection is
  Ollama-gated — no smoke:live for this seam.)

## Decisions

- Phone in the chunk is consistent with email already being there (the
  user's own contact data; the corpus is local). `find_contact` remains
  the direct "what's X's number" path; this makes the broad
  knowledge_search ALSO able to surface it, so the model answers
  regardless of which tool it picks.
- No new dependency.
