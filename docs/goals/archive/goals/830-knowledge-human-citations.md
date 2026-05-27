## 830 — feat: knowledge citations name the source, not an opaque id

## Why

P20 Knowledge is "multi-doc RAG WITH source citation". The citation is
only useful if the user can tell what was cited. `assembleKnowledgeCorpus`
labelled note chunks by filename (`notes/health.md` — good) but task,
event, contact, and email chunks by their OPAQUE id —
`[email/18f2a3b9c]`, `[contact/c_xK2…]`, `[event/ev1]`. A grounded
answer citing `[email/18f2a3b9c]` tells the user nothing about which
email it came from, defeating the point of citation.

## Slice

`@muse/autoconfigure` knowledge-corpus.ts — a `labelSource(prefix,
label, fallbackId)` helper builds each citation source as the stable
TYPE PREFIX (kept so the briefing enricher's `excludeSourcePrefixes`
still matches) plus a HUMAN-readable name (whitespace-collapsed,
capped at 60 chars, id-fallback when empty):
- `email/<subject>` (→ sender → id when both empty)
- `event/<title>`, `task/<title>`, `contact/<name>`
- notes unchanged (the filename was already meaningful).

So a cited `[email/Project deadline]` / `[event/Acme strategy meeting]`
now names the actual item.

## Verify

`@muse/autoconfigure` knowledge-{email,calendar,tasks,contacts,
enricher-exclude,chunking-live}-source tests (16) updated to the human
labels + new assertions:
- email cites by subject, NOT the opaque id (`email/Project deadline`,
  and no chunk contains "m1");
- empty subject → sender (`email/noreply@bank.com`);
- empty subject AND sender → id fallback (`email/m9`, never a bare
  `email/`);
- the enricher's `excludeSourcePrefixes:["event/","task/"]` STILL
  excludes (prefix preserved) and surfaces the note instead.
- **Mutation-proven**: reverting the email label to `email/${id}` →
  the human-label + cite tests fail; dropping `labelSource`'s
  empty→fallbackId branch → the both-empty id-fallback test fails.
  Full `pnpm check` EXIT 0, `pnpm lint` 0/0. No model-facing tool /
  no tool-selection change → no smoke:live.

## Decisions

- **Keep the type prefix, swap the id for a name** — the prefix is load-
  bearing (`excludeSourcePrefixes` matches on it); only the id portion
  was opaque. `email/<subject>` satisfies both: the enricher still
  filters by `email/`, and the user reads a meaningful citation.
- **Cap + collapse the label** — a title/subject can be long or
  multi-line; a citation must stay a short tag, so it's whitespace-
  collapsed and capped at 60 chars. CAPABILITIES line under P20
  Knowledge (no bullet flip — improves the existing RAG-citation
  capability).
